#!/usr/bin/env bash
# #12 一次性 VM 可行性实验的入口（pnpm test:vm）。只能在有 /dev/kvm 与 Docker 的 Linux 主机上、以 root 手动运行
# （要读 iptables / ip6tables / nft 的规则做前后比对）。
#
# 在宿主上只做这些事：构建一个实验镜像，建一个缓存卷，按 node 容器的约束起一个临时容器（非 root、只挂 /dev/kvm、
# cap_drop ALL、no-new-privileges、默认 seccomp、不发布端口），跑完删除容器、实验镜像和缓存卷；实验镜像的基础镜像
# 只在它是本次拉下来的时候才删。Docker 的构建缓存不清（它和宿主上别的构建共用）。不装宿主软件包，不改防火墙；
# 实验前后按 iptables、ip6tables 与 nft 的每张表各取一次指纹，比较是否变化。
#
# 用法：bash tests/integration/vm/run.sh [--repo-tar <带 .git 的仓库 tar>] [--keep]
#   --repo-tar  要在 VM 里 pnpm install / pnpm verify 的仓库（tar 里顶层目录名为 repo）；不给时从当前检出浅克隆一份
#   --keep      保留实验镜像与缓存卷（下载过的 cloud 镜像），方便重跑
# 环境变量：GEEKBOT_VM_RESULTS=<目录> 把全部产物复制出来；GEEKBOT_VM_PROBE_ONLY=1 只跑网络探测，不装依赖、不跑校验；
#           GEEKBOT_VM_SANDBOX 覆盖 qemu 的 -sandbox 取值（默认值与理由见 lab.sh）。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_IMAGE="node:22-bookworm-slim"
REPO_TAR=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-tar) REPO_TAR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || { echo "需要 Linux 主机（macOS 跑不了 KVM），见 docs/services/node/vm-feasibility.md" >&2; exit 2; }
[ -e /dev/kvm ] || { echo "没有 /dev/kvm：这台主机不能跑 VM 实验" >&2; exit 2; }
[ "$(id -u)" = "0" ] || { echo "要以 root 运行：前后比对防火墙规则需要读 iptables / nft" >&2; exit 2; }
for command in docker iptables-save ip6tables-save nft sha256sum; do
  command -v "$command" >/dev/null || { echo "缺少命令：$command" >&2; exit 2; }
done

# 每次运行的资源名带随机后缀：并发的第二次运行不会删掉第一次的容器、镜像或卷。
SUFFIX="$(date +%s)-$$"
CONTAINER="geekbot-vmlab-$SUFFIX"
IMAGE="geekbot-vmlab:$SUFFIX"
CACHE_VOLUME="geekbot-vmlab-cache-$SUFFIX"
BASE_PRESENT=0
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 && BASE_PRESENT=1

WORK="$(mktemp -d /tmp/geekbot-vmlab.XXXXXX)"
mkdir -p "$WORK/out"
chmod 0777 "$WORK/out"
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 0 ]; then
    docker rmi "$IMAGE" >/dev/null 2>&1 || true
    docker volume rm "$CACHE_VOLUME" >/dev/null 2>&1 || true
    [ "$BASE_PRESENT" -eq 0 ] && docker rmi "$BASE_IMAGE" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 防火墙规则的指纹：去掉注释和包计数器（计数器随流量一直变），只比较规则本身。iptables、ip6tables 各一行，
# nft 按表各一行，这样前后不一致时能看出是哪张表变了（宿主上别的程序，例如组网客户端或 incus，也可能在实验期间
# 改它自己的表）。读不到规则时写 UNKNOWN，不拿空输出的哈希冒充「一致」。
rules_fingerprint() { # 名称 命令...
  local name="$1" output
  shift
  if output="$("$@" 2>/dev/null)"; then
    printf '%s %s\n' "$name" "$(printf '%s' "$output" | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//g; s/packets [0-9]+ bytes [0-9]+//g' | sha256sum | cut -c1-12)"
  else
    printf '%s UNKNOWN\n' "$name"
  fi
}
firewall_snapshot() {
  rules_fingerprint iptables iptables-save
  rules_fingerprint ip6tables ip6tables-save
  local tables
  if ! tables="$(nft list tables 2>/dev/null)"; then
    echo "nft UNKNOWN"
    return
  fi
  printf '%s\n' "$tables" | while read -r _ family name; do
    [ -n "$name" ] && rules_fingerprint "nft:$family:$name" nft list table "$family" "$name"
  done
}
firewall_snapshot > "$WORK/out/firewall-before.txt"
STARTED_AT="$(date +%s)"

if [ -z "$REPO_TAR" ]; then
  top="$(git -C "$HERE" rev-parse --show-toplevel)"
  git clone --quiet --depth 1 "file://$top" "$WORK/repo"
  tar -C "$WORK" -cf "$WORK/repo.tar" repo
  REPO_TAR="$WORK/repo.tar"
fi

KVM_GID="$(stat -c %g /dev/kvm)"
echo "构建实验镜像（日志：$WORK/out/build.log）"
docker build -t "$IMAGE" -f "$HERE/Dockerfile.lab" "$HERE" > "$WORK/out/build.log" 2>&1 || { tail -20 "$WORK/out/build.log" >&2; exit 1; }
docker volume create "$CACHE_VOLUME" >/dev/null

docker run -d --name "$CONTAINER" \
  --user 1000:1000 --group-add "$KVM_GID" \
  --device /dev/kvm \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 5g --pids-limit 1024 \
  -e GEEKBOT_VM_PROBE_ONLY="${GEEKBOT_VM_PROBE_ONLY:-0}" \
  -e GEEKBOT_VM_SANDBOX="${GEEKBOT_VM_SANDBOX:-}" \
  -v "$REPO_TAR:/input/repo.tar:ro" \
  -v "$CACHE_VOLUME:/cache" \
  -v "$WORK/out:/out" \
  "$IMAGE" >/dev/null

docker inspect "$CONTAINER" --format '{{json .Config.User}} privileged={{.HostConfig.Privileged}} capDrop={{json .HostConfig.CapDrop}} capAdd={{json .HostConfig.CapAdd}} securityOpt={{json .HostConfig.SecurityOpt}} devices={{json .HostConfig.Devices}} ports={{json .HostConfig.PortBindings}} groupAdd={{json .HostConfig.GroupAdd}}' > "$WORK/out/container-inspect.txt"
docker exec "$CONTAINER" sh -c 'grep -E "^(Seccomp|NoNewPrivs|CapEff):" /proc/1/status' >> "$WORK/out/container-inspect.txt" || true

status="$(docker wait "$CONTAINER")"
docker logs "$CONTAINER" > "$WORK/out/container.log" 2>&1 || true
# 容器删掉之后再取指纹：Docker 在容器存活期间自己维护的规则不算实验对宿主的改动。
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

firewall_snapshot > "$WORK/out/firewall-after.txt"
# 实验时间窗内宿主上全部容器的起停：前后规则有差异时，据此判断是不是实验以外的容器带来的
# （Docker 会给接在默认网桥上的容器在 raw 表里加一条直连防护的 DROP 规则）。
docker events --since "$STARTED_AT" --until "$(date +%s)" --filter type=container \
  --format '{{.Time}} {{.Action}} {{.Actor.Attributes.name}}' 2>/dev/null \
  | grep -E ' (create|start|die|destroy) ' > "$WORK/out/docker-events.txt" || true
{
  if grep -q UNKNOWN "$WORK/out/firewall-before.txt" "$WORK/out/firewall-after.txt"; then
    echo "firewall_unchanged=UNKNOWN（有规则读不到，见 firewall-before.txt / firewall-after.txt）"
  elif diff -q "$WORK/out/firewall-before.txt" "$WORK/out/firewall-after.txt" >/dev/null; then
    echo "firewall_unchanged=yes（$(wc -l < "$WORK/out/firewall-after.txt") 项指纹一致）"
  else
    echo "firewall_unchanged=NO，变化的项："
    diff "$WORK/out/firewall-before.txt" "$WORK/out/firewall-after.txt" | grep '^[<>]' || true
  fi
  echo "container_exit=$status"
} >> "$WORK/out/host.txt"

echo "===== 实验结果（$WORK/out）====="
for file in host.txt container-inspect.txt report.txt; do
  [ -f "$WORK/out/$file" ] && { echo "----- $file"; cat "$WORK/out/$file"; }
done
if [ -n "${GEEKBOT_VM_RESULTS:-}" ]; then
  mkdir -p "$GEEKBOT_VM_RESULTS"
  cp -r "$WORK/out/." "$GEEKBOT_VM_RESULTS/"
  echo "全部产物已复制到 $GEEKBOT_VM_RESULTS"
fi
[ "$status" = "0" ]

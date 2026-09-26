#!/usr/bin/env bash
# #12 一次性 VM 可行性实验的入口（pnpm test:vm）。只能在有 /dev/kvm 与 Docker 的 Linux 主机上手动运行。
#
# 在宿主上只做这些事：构建一个实验镜像，建一个缓存卷，按 node 容器的约束起一个临时容器（非 root、只挂 /dev/kvm、
# cap_drop ALL、no-new-privileges、默认 seccomp、不发布端口），跑完删除容器、镜像和缓存卷。不装宿主软件包，
# 不改防火墙；实验前后各记一次防火墙规则的哈希，比较是否变化。
#
# 用法：bash tests/integration/vm/run.sh [--repo-tar <带 .git 的仓库 tar>] [--keep]
#   --repo-tar  要在 VM 里 pnpm install / pnpm verify 的仓库（tar 里顶层目录名为 repo）；不给时从当前检出浅克隆一份
#   --keep      保留实验镜像与缓存卷（下载过的 cloud 镜像），方便重跑
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="geekbot-vmlab:experiment"
CACHE_VOLUME="geekbot-vmlab-cache"
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
command -v docker >/dev/null || { echo "没有 docker" >&2; exit 2; }

WORK="$(mktemp -d /tmp/geekbot-vmlab.XXXXXX)"
mkdir -p "$WORK/out"
chmod 0777 "$WORK/out"
cleanup() {
  docker rm -f geekbot-vmlab >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 0 ]; then
    docker rmi "$IMAGE" >/dev/null 2>&1 || true
    docker volume rm "$CACHE_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# 防火墙规则的指纹：去掉注释和包计数器（计数器随流量一直变），只比较规则本身。
# iptables / ip6tables 各一行，nft 按表各一行，这样前后不一致时能看出是哪张表变了
# （宿主上别的程序，例如组网客户端，也可能在实验期间改它自己的表）。
firewall_snapshot() {
  printf 'iptables %s\n' "$({ iptables-save 2>/dev/null | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//g' || true; } | sha256sum | cut -c1-12)"
  printf 'ip6tables %s\n' "$({ ip6tables-save 2>/dev/null | grep -v '^#' | sed -E 's/\[[0-9]+:[0-9]+\]//g' || true; } | sha256sum | cut -c1-12)"
  nft list tables 2>/dev/null | while read -r _ family name; do
    printf 'nft:%s:%s %s\n' "$family" "$name" "$(nft list table "$family" "$name" 2>/dev/null | sed -E 's/packets [0-9]+ bytes [0-9]+//g' | sha256sum | cut -c1-12)"
  done
}
firewall_snapshot > "$WORK/out/firewall-before.txt"

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

docker run -d --name geekbot-vmlab \
  --user 1000:1000 --group-add "$KVM_GID" \
  --device /dev/kvm \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 5g --pids-limit 1024 \
  -v "$REPO_TAR:/input/repo.tar:ro" \
  -v "$CACHE_VOLUME:/cache" \
  -v "$WORK/out:/out" \
  "$IMAGE" >/dev/null

docker inspect geekbot-vmlab --format '{{json .Config.User}} privileged={{.HostConfig.Privileged}} capDrop={{json .HostConfig.CapDrop}} capAdd={{json .HostConfig.CapAdd}} securityOpt={{json .HostConfig.SecurityOpt}} devices={{json .HostConfig.Devices}} ports={{json .HostConfig.PortBindings}} groupAdd={{json .HostConfig.GroupAdd}}' > "$WORK/out/container-inspect.txt"
docker exec geekbot-vmlab sh -c 'grep -E "^(Seccomp|NoNewPrivs|CapEff):" /proc/1/status' >> "$WORK/out/container-inspect.txt" || true

status="$(docker wait geekbot-vmlab)"
docker logs geekbot-vmlab > "$WORK/out/container.log" 2>&1 || true
# 容器删掉之后再取指纹：Docker 在容器存活期间自己维护的规则不算实验对宿主的改动。
docker rm -f geekbot-vmlab >/dev/null 2>&1 || true

firewall_snapshot > "$WORK/out/firewall-after.txt"
{
  if diff -q "$WORK/out/firewall-before.txt" "$WORK/out/firewall-after.txt" >/dev/null; then
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

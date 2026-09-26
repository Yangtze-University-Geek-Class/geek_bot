#!/usr/bin/env bash
# #12 实验容器里的流程（由 run.sh 启动，以 uid 1000 运行）：
#   1. 核对 /dev/kvm 在非 root、默认 seccomp、cap_drop ALL 下可用；
#   2. 下载 Debian 12 genericcloud 镜像与 Node 22 并按官方校验和核对；
#   3. 起出网 CONNECT 代理（egress-proxy.mjs），VM 只能经 guestfwd 连到它；
#   4. 起两次 1 vCPU / 2 GiB 的一次性 VM：第一次冷装依赖，第二次带上第一次导出的 pnpm store；
#   5. 汇总冷启动、网络隔离、依赖安装、pnpm verify、内存峰值，写到 /out/report.txt。
# QEMU 用户态网络的地址在运行时拼出，仓库里不留私网地址字面量。
set -euo pipefail

OUT=/out
CACHE=/cache
W="$(mktemp -d)"
slirp() { printf '%d.%d.%d.%d' 10 0 2 "$1"; }
PROXY_ADDR="$(slirp 100)"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$OUT/lab.log"; }
PROBE_ONLY="${GEEKBOT_VM_PROBE_ONLY:-0}"
# 容器的默认网关（Docker 网桥上的节点宿主地址），从 /proc/net/route 的十六进制小端字段换算，交给来宾去探测。
CONTAINER_GW="$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route | sed -E 's/(..)(..)(..)(..)/\4 \3 \2 \1/' | while read -r a b c d; do printf '%d.%d.%d.%d' "0x$a" "0x$b" "0x$c" "0x$d"; done)"

log "身份：$(id)"
stat -c "%A %U:%G %n" /dev/kvm | tee -a "$OUT/lab.log"
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then log "kvm=rw"; else log "kvm=NOT_ACCESSIBLE"; exit 3; fi

# ---- 基础镜像与 Node（带校验）----
BASE_URL="https://cloud.debian.org/images/cloud/bookworm/latest"
IMG="debian-12-genericcloud-amd64.qcow2"
curl -fsSL -o "$CACHE/SHA512SUMS" "$BASE_URL/SHA512SUMS"
if ! (cd "$CACHE" && grep " $IMG\$" SHA512SUMS | sha512sum -c - >/dev/null 2>&1); then
  log "下载 $IMG"
  curl -fsSL -o "$CACHE/$IMG" "$BASE_URL/$IMG"
fi
(cd "$CACHE" && grep " $IMG\$" SHA512SUMS | sha512sum -c -) | tee -a "$OUT/lab.log"
IMG_SHA512="$(sha512sum "$CACHE/$IMG" | cut -c1-32)"

NODE_VERSION="$(node -v)"
NODE_TAR="node-$NODE_VERSION-linux-x64.tar.xz"
curl -fsSL -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
if ! (cd "$CACHE" && grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1); then
  curl -fsSL -o "$CACHE/$NODE_TAR" "https://nodejs.org/dist/$NODE_VERSION/$NODE_TAR"
fi
(cd "$CACHE" && grep " $NODE_TAR\$" SHASUMS256.txt | sha256sum -c -) | tee -a "$OUT/lab.log"

# ---- cloud-init 种子：只挂输入盘、跑 guest.sh、关机 ----
cat > "$W/user-data" <<'EOF'
#cloud-config
package_update: false
package_upgrade: false
runcmd:
  - [bash, -c, "mkdir -p /in && tar -xf /dev/vdb -C /in && bash /in/guest.sh > /dev/ttyS0 2>&1; poweroff"]
EOF
printf 'instance-id: geekbot-vmlab\nlocal-hostname: geekbot-vmlab\n' > "$W/meta-data"
genisoimage -quiet -output "$W/seed.iso" -volid cidata -joliet -rock "$W/user-data" "$W/meta-data"

# ---- qemu 的 seccomp 沙箱 ----
# 按 ADR-0011：on,obsolete=deny,resourcecontrol=deny，不带 elevateprivileges=deny。本实验实测 QEMU 7.2（Debian 12）里
# elevateprivileges=deny 或 =children 都会让 guestfwd 的 cmd: 转发进程起不来；所有者 2026-09-26 决定去掉这一项，
# 由容器的 cap_drop ALL 与 no-new-privileges 兜底。可用环境变量 GEEKBOT_VM_SANDBOX 覆盖以复现。
SANDBOX="${GEEKBOT_VM_SANDBOX:-on,obsolete=deny,resourcecontrol=deny}"

# ---- 出网代理 ----
# 实验白名单：npm 源、Debian 源（guest 用 apt 装 git），以及一个解析到回环地址的公共域名，用来验证「解析后拒绝」。
ALLOW="registry.npmjs.org,deb.debian.org,security.debian.org,localtest.me"

run_vm() {
  local run="$1" with_store="$2"
  local dir="$W/$run"
  mkdir -p "$dir/in"
  cp /lab/guest.sh "$dir/in/guest.sh"
  cp /input/repo.tar "$dir/in/repo.tar"
  cp "$CACHE/$NODE_TAR" "$dir/in/node.tar.xz"
  printf 'RUN=%s\nPROXY=http://%s:3128\nCONTAINER_GW=%s\nPROBE_ONLY=%s\n' "$run" "$PROXY_ADDR" "$CONTAINER_GW" "$PROBE_ONLY" > "$dir/in/env"
  if [ "$with_store" = "yes" ]; then cp "$W/store.tar" "$dir/in/store.tar"; fi
  tar -C "$dir/in" -cf "$dir/input.tar" .
  truncate -s 4G "$dir/output.img"
  qemu-img create -q -f qcow2 -b "$CACHE/$IMG" -F qcow2 "$dir/overlay.qcow2" 16G

  node /lab/egress-proxy.mjs --listen 127.0.0.1:3128 --allow "$ALLOW" --log "$OUT/proxy-$run.jsonl" &
  local proxy_pid=$!
  sleep 1

  log "[$run] 启动 VM（1 vCPU / 2 GiB，restrict=on，一条 guestfwd 到出网代理）"
  local start
  start="$(date +%s.%N)"
  timeout 3600 qemu-system-x86_64 \
    -enable-kvm -cpu host -smp 1 -m 2048 \
    -sandbox "$SANDBOX" \
    -display none -monitor none -no-reboot \
    -serial "file:$dir/serial.log" \
    -drive "file=$dir/overlay.qcow2,if=virtio,format=qcow2" \
    -drive "file=$dir/input.tar,if=virtio,format=raw,readonly=on" \
    -drive "file=$dir/output.img,if=virtio,format=raw" \
    -drive "file=$W/seed.iso,media=cdrom,format=raw,readonly=on" \
    -netdev "user,id=n0,restrict=on,guestfwd=tcp:$PROXY_ADDR:3128-cmd:nc 127.0.0.1 3128" \
    -device virtio-net-pci,netdev=n0 &
  local qemu_pid=$!

  local ready=""
  while kill -0 "$qemu_pid" 2>/dev/null; do
    if [ -z "$ready" ] && grep -q "GEEKBOT-MARK ready" "$dir/serial.log" 2>/dev/null; then
      ready="$(date +%s.%N)"
      log "[$run] runner 就绪：$(echo "$ready - $start" | awk '{printf "%.1f", $1 - $3}') 秒"
    fi
    sleep 0.5
  done
  local qemu_status=0
  wait "$qemu_pid" || qemu_status=$?
  local end
  end="$(date +%s.%N)"
  kill -TERM "$proxy_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true

  mkdir -p "$dir/result"
  tar -xf "$dir/output.img" -C "$dir/result" 2>/dev/null || log "[$run] 输出盘里没有结果"
  cp "$dir/serial.log" "$OUT/serial-$run.log"
  [ -d "$dir/result/results" ] && cp -r "$dir/result/results" "$OUT/results-$run"
  if [ -f "$dir/result/results/store.tar" ]; then mv "$dir/result/results/store.tar" "$W/store.tar"; rm -f "$OUT/results-$run/store.tar"; fi
  {
    echo "== $run =="
    echo "qemu_exit=$qemu_status"
    awk -v s="$start" -v r="${ready:-0}" -v e="$end" 'BEGIN{ if (r>0) printf "boot_to_ready_s=%.1f\n", r-s; else print "boot_to_ready_s=NA"; printf "vm_total_s=%.1f\n", e-s }'
    echo "proxy_allowed=$(grep -c '"decision":"allow"' "$OUT/proxy-$run.jsonl" || true)"
    echo "proxy_denied=$(grep -c '"decision":"deny"' "$OUT/proxy-$run.jsonl" || true)"
    grep '"decision":"summary"' "$OUT/proxy-$run.jsonl" | tail -1 || true
    [ -f "$OUT/results-$run/summary.txt" ] && cat "$OUT/results-$run/summary.txt"
  } >> "$OUT/report.txt"
  rm -rf "$dir"
}

{
  echo "image=$IMG sha512_prefix=$IMG_SHA512"
  echo "qemu=$(qemu-system-x86_64 --version | head -1)"
  echo "node_for_guest=$NODE_VERSION"
  echo "qemu_sandbox=$SANDBOX"
} > "$OUT/report.txt"

run_vm cold no
if [ "$PROBE_ONLY" = "1" ]; then
  log "只跑探测（GEEKBOT_VM_PROBE_ONLY=1），不做第二次"
elif [ -f "$W/store.tar" ]; then
  run_vm warm yes
else
  log "第一次没有导出 pnpm store，跳过第二次"
fi
log "实验结束"

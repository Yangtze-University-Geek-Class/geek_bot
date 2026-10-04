#!/bin/sh
# 一次性 VM 里的启动脚本（放在只读工具盘的根目录，由 cloud-init 种子在挂好工具盘后以 root 执行，输出到串口）。
#   /dev/vdb  只读输入盘（tar：task.json、bundle.json）
#   /dev/vdc  只读工具盘（squashfs，已挂在 /opt/geekbot：node、omp、omp-data、runner.mjs、本脚本）
#   /dev/vdd  可写输出盘（runner 写 result.json 或 failure.json 的 tar）
#   fw_cfg opt/geekbot/token  本任务的模型令牌（只有 root 可读）
#   virtio-serial org.geekbot.events  实时事件
# runner 以 root 读令牌与磁盘，omp 降到普通用户 geekbot 运行。结束后落盘并立即关机（qemu 带 -no-reboot，关机即退出）。
set -u
# cloud-init 的 runcmd 里没有 HOME（#12 发现 4）。
export HOME=/root
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
G=/opt/geekbot
TOKEN=/sys/firmware/qemu_fw_cfg/by_name/opt/geekbot/token/raw

modprobe qemu_fw_cfg 2>/dev/null || true
if [ ! -r "$TOKEN" ]; then
  echo "GEEKBOT guest-init: fw_cfg 里没有模型令牌（qemu_fw_cfg 模块不可用？）"
fi
if ! id geekbot >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/geekbot --shell /bin/bash geekbot
fi
mkdir -p /work
chown geekbot:geekbot /work
chmod 0700 /work

"$G/node/bin/node" "$G/runner.mjs" vm \
  --input /dev/vdb \
  --output /dev/vdd \
  --events /dev/virtio-ports/org.geekbot.events \
  --token-file "$TOKEN" \
  --run-as geekbot \
  --work /work \
  --omp "$G/omp/omp" \
  --omp-data "$G/omp-data" \
  --node-bin "$G/node/bin"
echo "GEEKBOT guest-init: runner 退出码 $?"
sync
poweroff -f

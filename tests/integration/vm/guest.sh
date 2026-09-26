#!/usr/bin/env bash
# #12 VM 里的流程（cloud-init 以 root 运行，输出到串口）：探测网络隔离 → 经出网代理装 git → 装 Node 与 pnpm →
# pnpm install 与 pnpm verify（计时、采样内存）→ 结果写到输出盘 /dev/vdc。
# QEMU 用户态网络与各私网段的地址（IPv4 与 IPv6）在运行时拼出，仓库里不留地址字面量。
set -u
# cloud-init 的 runcmd 里没有 HOME：不设的话 git config --global、npm、pnpm 都写不到家目录。
export HOME=/root
# shellcheck disable=SC1091
. /in/env
R=/results
mkdir -p "$R"
addr() { printf '%d.%d.%d.%d' "$@"; }
mark() { echo "GEEKBOT-MARK $1 $(date +%s.%N)"; echo "$1 $(date +%s.%N)" >> "$R/marks.txt"; }
say() { echo "$*" | tee -a "$R/summary.txt"; }

mark ready

# 内存采样：每秒记一次已用内存（MemTotal - MemAvailable，KiB）。
( while :; do awk '/^MemTotal/{t=$2} /^MemAvailable/{a=$2} END{print t-a}' /proc/meminfo; sleep 1; done ) > "$R/mem-kib.txt" &
SAMPLER=$!

# ---- 网络隔离：restrict=on 时来宾到宿主、私网、元数据地址都应当不通 ----
# 每项记下失败类型（refused、timeout、unreachable），方便判断是被隔离挡住，还是目标本来就不在听。
# 阳性对照：宿主别名地址 .2 在 restrict=off 时对应实验容器的回环，那里 3128 有出网代理在听；
# 它也 blocked，才说明是 restrict=on 挡住了来宾到宿主的连接，而不是端口没人听。
# 容器网关（CONTAINER_GW，由 lab.sh 从容器的默认路由取得）就是节点宿主在 Docker 网桥上的地址，探它的 22。
probe_tcp() { # 名称 地址 端口
  local err status
  err="$(timeout 4 bash -c "exec 3<>/dev/tcp/$2/$3" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then say "probe $1 REACHABLE"; return; fi
  case "$status:$err" in
    124:*) say "probe $1 blocked (timeout)" ;;
    *refused*) say "probe $1 blocked (refused)" ;;
    *unreachable*) say "probe $1 blocked (unreachable)" ;;
    *) say "probe $1 blocked (other: $(printf '%s' "$err" | tail -1 | cut -c1-60))" ;;
  esac
}
HOST_ALIAS="$(addr 10 0 2 2)"
probe_tcp "host-alias:3128(positive-control)" "$HOST_ALIAS" 3128
for port in 22 139 445 3055 3183; do probe_tcp "host-alias:$port" "$HOST_ALIAS" "$port"; done
if [ -n "${CONTAINER_GW:-}" ]; then
  probe_tcp "container-gateway:22" "$CONTAINER_GW" 22
  probe_tcp "container-gateway:3128" "$CONTAINER_GW" 3128
fi
probe_tcp "slirp-dns:53" "$(addr 10 0 2 3)" 53
probe_tcp "rfc1918-192.168:80" "$(addr 192 168 1 1)" 80
probe_tcp "rfc1918-10:80" "$(addr 10 0 0 1)" 80
probe_tcp "rfc1918-172.16:80" "$(addr 172 17 0 1)" 80
probe_tcp "cgnat:80" "$(addr 100 64 0 1)" 80
probe_tcp "metadata:80" "$(addr 169 254 169 254)" 80
probe_tcp "public-ip:443" "$(addr 1 1 1 1)" 443
if timeout 4 getent hosts deb.debian.org >/dev/null 2>&1; then say "probe dns-resolution REACHABLE"; else say "probe dns-resolution blocked"; fi
v6() { local IFS=:; echo "$*"; }
probe_v6() { # 名称前缀 地址：curl 退出码 28 是超时，7 是连不上（按报错区分 refused 与 unreachable）
  local err status
  err="$(timeout 6 curl -sS -o /dev/null --max-time 4 -g "http://[$2]:22/" 2>&1)"
  status=$?
  if [ "$status" -eq 0 ]; then say "probe $1:$2 REACHABLE"; return; fi
  case "$status:$err" in
    28:*|124:*) say "probe $1:$2 blocked (timeout)" ;;
    *refused*) say "probe $1:$2 blocked (refused)" ;;
    *nreachable*) say "probe $1:$2 blocked (unreachable)" ;;
    *) say "probe $1:$2 blocked (other: $(printf '%s' "$err" | tail -1 | cut -c1-60))" ;;
  esac
}
for target in "$(v6 fec0 "" 2)" "$(v6 fd00 "" 1)" "$(v6 fe80 "" 2)%eth0" "$(v6 "" "" ffff "$(addr 10 0 0 1)")" "$(v6 64 ff9b "" 101 101)"; do
  probe_v6 ipv6 "$target"
done
# 反向核对转发确实存在：出网代理的转发地址应当连得上。
PROXY_HOSTPORT="${PROXY#http://}"
probe_tcp "guestfwd-proxy(expected-reachable)" "${PROXY_HOSTPORT%:*}" "${PROXY_HOSTPORT##*:}"

# ---- 来宾自己加默认路由之后再探一次 ----
# restrict=on 时 DHCP 可能不下发网关，上面网段外的目标报 unreachable 只说明包没离开来宾。来宾里以 root 运行的代码
# 可以自己加默认路由，这时能不能拦住只取决于 QEMU 用户态网络在 restrict=on 下丢不丢包，所以加上路由再探一遍。
say "route_v4_before: $(ip -4 route show default | head -1)"
say "route_v6_before: $(ip -6 route show default | head -1)"
if ip -4 route replace default via "$HOST_ALIAS" 2>/dev/null; then say "defroute_v4 added"; else say "defroute_v4 FAILED"; fi
if ip -6 route replace default via "$(v6 fec0 "" 2)" 2>/dev/null; then say "defroute_v6 added"; else say "defroute_v6 FAILED"; fi
if [ -n "${CONTAINER_GW:-}" ]; then
  probe_tcp "defroute:container-gateway:22" "$CONTAINER_GW" 22
  probe_tcp "defroute:container-gateway:3128" "$CONTAINER_GW" 3128
fi
probe_tcp "defroute:rfc1918-192.168:80" "$(addr 192 168 1 1)" 80
probe_tcp "defroute:rfc1918-172.16:80" "$(addr 172 17 0 1)" 80
probe_tcp "defroute:cgnat:80" "$(addr 100 64 0 1)" 80
probe_tcp "defroute:metadata:80" "$(addr 169 254 169 254)" 80
probe_tcp "defroute:public-ip:443" "$(addr 1 1 1 1)" 443
for target in "$(v6 fd00 "" 1)" "$(v6 64 ff9b "" 101 101)" "$(v6 2606 4700 4700 "" 1111)"; do
  probe_v6 defroute:ipv6 "$target"
done
probe_tcp "defroute:guestfwd-proxy(expected-reachable)" "${PROXY_HOSTPORT%:*}" "${PROXY_HOSTPORT##*:}"

if [ "${PROBE_ONLY:-0}" = "1" ]; then
  say "probe_only=1，跳过安装与校验"
  mark "done"
  sync
  tar -cf /dev/vdc -C / results
  sync
  exit 0
fi

# ---- 出网代理：白名单内可达，GitHub、白名单外、IP 字面量、解析到回环的域名都被拒 ----
through_proxy() { # 名称 URL
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -x "$PROXY" "$2" 2>&1 | tail -1)"
  say "proxy $1 -> $code"
}
through_proxy "npm-registry" "https://registry.npmjs.org/"
through_proxy "github" "https://github.com/"
through_proxy "github-api" "https://api.github.com/"
through_proxy "raw-githubusercontent" "https://raw.githubusercontent.com/"
through_proxy "not-allowlisted" "https://example.com/"
through_proxy "ip-literal" "https://$(addr 1 1 1 1)/"
through_proxy "resolves-to-loopback" "https://localtest.me/"

# ---- 经代理装 git（pnpm verify 的公开安全检查要用 git ls-files）----
export https_proxy="$PROXY" HTTPS_PROXY="$PROXY"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do [ -f "$f" ] && sed -i 's#http://deb.debian.org#https://deb.debian.org#g; s#http://security.debian.org#https://security.debian.org#g' "$f"; done
printf 'Acquire::https::Proxy "%s";\nAcquire::http::Proxy "%s";\nAcquire::Languages "none";\n' "$PROXY" "$PROXY" > /etc/apt/apt.conf.d/99geekbot-proxy
t0=$(date +%s)
if apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1; then say "apt_git ok $(( $(date +%s) - t0 ))s"; else say "apt_git FAILED"; fi

# ---- Node 与 pnpm ----
mkdir -p /opt/node && tar -xJf /in/node.tar.xz -C /opt/node --strip-components=1
export PATH="/opt/node/bin:$PATH"
t0=$(date +%s)
if npm install -g --silent pnpm@9.15.9 >/dev/null 2>&1; then say "npm_pnpm ok $(( $(date +%s) - t0 ))s"; else say "npm_pnpm FAILED"; fi
say "node $(node -v) pnpm $(pnpm -v 2>/dev/null)"

# ---- 仓库：pnpm install 与 pnpm verify ----
mkdir -p /work && tar -xf /in/repo.tar -C /work
cd /work/repo || exit 1
git config --system --add safe.directory /work/repo
STORE=/work/pnpm-store
mkdir -p "$STORE"
pnpm config set store-dir "$STORE" >/dev/null
if [ -f /in/store.tar ]; then
  t0=$(date +%s); tar -xf /in/store.tar -C "$STORE"; say "store_restore $(( $(date +%s) - t0 ))s size=$(du -sm "$STORE" | cut -f1)MiB"
fi
mark install_start
t0=$(date +%s)
pnpm install --frozen-lockfile > "$R/install.log" 2>&1
say "pnpm_install exit=$? $(( $(date +%s) - t0 ))s"
mark verify_start
t0=$(date +%s)
pnpm verify > "$R/verify.log" 2>&1
say "pnpm_verify exit=$? $(( $(date +%s) - t0 ))s"
grep -E 'Test Files|Tests ' "$R/verify.log" | sed 's/^/verify: /' | tee -a "$R/summary.txt"
mark verify_end

kill "$SAMPLER" 2>/dev/null
say "mem_peak_used_mib=$(sort -n "$R/mem-kib.txt" | tail -1 | awk '{printf "%d", $1/1024}') of $(awk '/^MemTotal/{printf "%d", $2/1024}' /proc/meminfo)MiB"
if dmesg 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then say "oom=YES"; else say "oom=no"; fi
say "swap_total_mib=$(awk '/^SwapTotal/{printf "%d", $2/1024}' /proc/meminfo)"

if [ ! -f /in/store.tar ]; then
  tar -cf "$R/store.tar" -C "$STORE" . && say "store_export size=$(du -sm "$R/store.tar" | cut -f1)MiB"
fi
mark "done"
sync
tar -cf /dev/vdc -C / results
sync

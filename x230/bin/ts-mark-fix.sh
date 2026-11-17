#!/bin/bash
# tailscaled 与 mihomo 的 fwmark(0x80000) 冲突修复：清零 tailscaled 出站包标记，使其回到 mihomo TUN 代理路径
CGID=$(stat -Lc %i /sys/fs/cgroup/system.slice/tailscaled.service 2>/dev/null) || exit 0
nft add table inet tailscale_fix 2>/dev/null
nft add chain inet tailscale_fix output '{ type route hook output priority mangle; policy accept; }' 2>/dev/null
nft flush chain inet tailscale_fix output
nft add rule inet tailscale_fix output meta cgroup "$CGID" meta mark set 0x00000000

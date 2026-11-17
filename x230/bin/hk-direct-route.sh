#!/bin/sh
# 让发往香港服务器 156.239.8.225 的流量走物理网卡直连，绕开 mihomo TUN
# 否则 SSH 会被代理转发，kex 握手被对端拒绝（Connection closed by remote host）
DST="156.239.8.225/32"
case "$1" in
  up)   ip rule add to "$DST" lookup main priority 8990 2>/dev/null || true ;;
  down) ip rule del to "$DST" lookup main priority 8990 2>/dev/null || true ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac

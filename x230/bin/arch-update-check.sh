#!/bin/bash
# 每日 21:30 Arch 更新巡检（仅检查并分级推送 ntfy，不自动 -Syu）
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897

TOPIC="x230-<REDACTED_TOPIC>"
URL="http://127.0.0.1:2586/$TOPIC"

out=$(checkupdates 2>/dev/null)
n=$(echo "$out" | grep -c .)

last_syu=$(grep -E 'Running .*-Syu' /var/log/pacman.log 2>/dev/null | tail -n1 | sed -n 's/^\[\([^]]*\)\].*/\1/p' || true)
days=0
if [ -n "$last_syu" ]; then
  e_last=$(date -d "$last_syu" +%s 2>/dev/null || echo 0)
  e_now=$(date +%s)
  [ "$e_last" -gt 0 ] && days=$(( (e_now - e_last) / 86400 ))
fi

[ "$n" -eq 0 ] && [ "$days" -lt 21 ] && exit 0

names=$(echo "$out" | awk '{print $1}' | head -8 | tr '\n' ' ')
imp=$(echo "$out" | awk '{print $1}' | grep -E '^(linux|systemd|glibc|mesa|pacman|openssl|ca-certificates-mozilla|sudo|docker|nodejs)$' | tr '\n' ' ')
boot_mb=$(df -Pm /boot 2>/dev/null | awk 'NR==2{print $4}')

prio="default"
tags="package"
advice="运行 arch-safe-upgrade --check 预览"
if [ "$days" -ge 21 ]; then
  prio="high"
  tags="warning,package"
  advice="⚠️ 已超过 ${days} 天未滚包，建议近期跑 arch-safe-upgrade --apply"
elif [ "$days" -ge 14 ] || echo "$imp" | grep -qE 'openssl|ca-certificates-mozilla|sudo'; then
  advice="建议安排窗口跑 arch-safe-upgrade --apply（含安全/核心组件）"
fi

msg="📦 ${n} 个包可更新（距上次 -Syu 已 ${days} 天 | /boot 剩 ${boot_mb:-?}MB）
${names}
$([ -n "$imp" ] && echo "⚠️ 重要组件: ${imp}")
👉 ${advice}"

curl -s -H "Title: Arch 滚更提醒" -H "Tags: $tags" -H "Priority: $prio" -d "$msg" "$URL" > /dev/null

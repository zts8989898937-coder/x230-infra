#!/bin/bash
# X230 每日体检推送到 ntfy（手机收通知）
TOPIC="x230-<REDACTED_TOPIC>"
URL="http://127.0.0.1:2586/$TOPIC"

temp=$(sensors 2>/dev/null | awk '/Package id 0/{print $4}' | tr -d '+')
fan=$(sensors 2>/dev/null | awk '/fan1/{print $2}')
mem=$(free -h --si | awk '/Mem:/{print $3" / "$2}')
zram=$(free -h --si | awk '/Swap:/{print $3}')
disk=$(df -h / | awk 'NR==2{print $5" 已用, "$4" 可用"}')
load=$(cut -d' ' -f1-3 /proc/loadavg)
up=$(uptime -p | sed 's/up //')
failed=$(systemctl --failed --no-legend 2>/dev/null | wc -l)
[ "$failed" -eq 0 ] && failed="无" || failed="$failed 个!!"
lid=$(grep -c 'ignore' /etc/systemd/logind.conf.d/10-always-on.conf 2>/dev/null || echo 0)
[ "${lid:-0}" -ge 2 ] && lid="正常" || lid="⚠️配置丢失!"

msg="⏱ 已运行 $up
🌡 $temp  🌀 ${fan}RPM
📊 内存 $mem | zram 已用 $zram
💾 磁盘 $disk
⚖ 负载 $load
❌ 异常服务: $failed
🖥 合盖常开: $lid"

curl -s -H "Title: X230 早安体检" -H "Tags: stethoscope" -H "Priority: default" \
     -d "$msg" "$URL" >/dev/null

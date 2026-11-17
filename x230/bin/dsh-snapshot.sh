#!/usr/bin/env bash
# dsh-snapshot — 把 DSH 关键配置/补丁/凭据/服务单元打成一个可恢复的快照包
# 用法: sudo /usr/local/bin/dsh-snapshot.sh
# 产出: /home/zts/backups/dsh-snapshots/dsh-critical-<时间戳>.tar.zst（600，含凭据）
# 恢复: sudo tar --zstd -xf <包> -C / && sudo systemctl daemon-reload && sudo systemctl restart dsh-web
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=/home/zts/backups/dsh-snapshots
mkdir -p "$OUT"; chmod 700 "$OUT"
TMP=$(mktemp -d /var/tmp/dsh-snap.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

copy() { [ -e "$1" ] || return 0; mkdir -p "$TMP/$(dirname "$2")"; cp -a "$1" "$TMP/$2"; }

# systemd 单元
for f in dsh-web.service dsh-web.service.d dsh-tunnel.service agy-bridge.service agy-bridge.service.d \
         agy-tunnel.service dsh-web-lan.service dsh-web-lan.socket dsh-wg-proxy.service dsh-wg-proxy.socket \
         dsh-watchdog.service dsh-watchdog.timer dsh-public-cookie.service dsh-public-cookie.timer \
         x230-backup.service x230-backup.timer; do
  copy "/etc/systemd/system/$f" "etc/systemd/system/$f"
done

# 本机脚本
for f in dsh-rescue dsh-restart-safe dsh-watchdog x230-backup.sh dsh-snapshot.sh; do
  copy "/usr/local/bin/$f" "usr/local/bin/$f"
done
for f in agy-bridge agy-burn agy-usage agy-login.py gclick.js gverify.js agy-oauth.js; do
  copy "/home/zts/.local/bin/$f" "home/zts/.local/bin/$f"
done

# dsh profile 配置与补丁
P=/home/zts/.dsh/profiles/web
copy "$P/cordis.patch.yml" "home/zts/.dsh/profiles/web/cordis.patch.yml"
copy "$P/package.json" "home/zts/.dsh/profiles/web/package.json"
copy "$P/pnpm-lock.yaml" "home/zts/.dsh/profiles/web/pnpm-lock.yaml"
copy "$P/node_modules/dsh-context/lib/client.js" "home/zts/.dsh/profiles/web/node_modules/dsh-context/lib/client.js"
copy "$P/node_modules/dsh-memory-evolve/lib/notify.js" "home/zts/.dsh/profiles/web/node_modules/dsh-memory-evolve/lib/notify.js"
copy "$P/node_modules/dsh-memory-evolve/lib/feishu-channel.mjs" "home/zts/.dsh/profiles/web/node_modules/dsh-memory-evolve/lib/feishu-channel.mjs"

# 飞书桥状态（含 AppID/Secret，务必保持包 600）
copy "/home/zts/.dsh/feishu-im/state.json" "home/zts/.dsh/feishu-im/state.json"
# 凭据目录
copy "/home/zts/.config/secrets" "home/zts/.config/secrets"

# 香港 nginx 站点配置（尽力而为）
if ssh -o ConnectTimeout=8 -o BatchMode=yes hk 'cat /www/server/panel/vhost/nginx/dsh.stillfloating.top.conf' > "$TMP/nginx-dsh.stillfloating.top.conf" 2>/dev/null; then :; else rm -f "$TMP/nginx-dsh.stillfloating.top.conf"; fi

{
  echo "DSH 关键快照 $STAMP"
  echo "主机: $(uname -n)  内核: $(uname -r)"
  echo "dsh: $(/usr/bin/dsh --version 2>/dev/null)"
  echo "包内容: systemd 单元、/usr/local/bin 脚本、~/.local/bin 脚本、profile 配置、插件补丁、飞书 state、~/.config/secrets、香港 nginx 配置(如可连)"
  echo "恢复: sudo tar --zstd -xf <包> -C / && sudo systemctl daemon-reload && sudo systemctl restart dsh-web && sudo systemctl restart agy-bridge dsh-tunnel agy-tunnel"
  echo "注意: 含凭据，包权限 600，勿外传。"
} > "$TMP/MANIFEST.txt"

tar --zstd -cf "$OUT/dsh-critical-$STAMP.tar.zst" -C "$TMP" .
chown zts:zts "$OUT" "$OUT/dsh-critical-$STAMP.tar.zst" 2>/dev/null || true
chmod 600 "$OUT/dsh-critical-$STAMP.tar.zst"
ls -1t "$OUT"/dsh-critical-*.tar.zst 2>/dev/null | tail -n +15 | xargs -r rm -f
echo "$OUT/dsh-critical-$STAMP.tar.zst"

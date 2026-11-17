#!/usr/bin/env bash
# x230-gdrive-backup.sh — Google Drive 核心加密备份 + 包清单同步 + 工作产出兜底同步
# 目标分布：
#   1) gdrive:系统备份/x230-restic-core （restic 端到端强加密，保留 daily 4 / weekly 8 / monthly 12）
#   2) gdrive:系统备份/x230-pkglists/    （脱敏系统包清单与开机服务清单）
#   3) gdrive:工作产出/                 （调用 put-output-sync 兜底）
set -uo pipefail

export HOME=/root
export XDG_CACHE_HOME=/root/.cache
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export ALL_PROXY=socks5://127.0.0.1:7897
export RCLONE_TPSLIMIT=8
export RCLONE_TPSLIMIT_BURST=16
export RCLONE_LOW_LEVEL_RETRIES=10
export RCLONE_RETRIES=5
export RCLONE_CONFIG=/home/zts/.config/rclone/rclone.conf
export RESTIC_REPOSITORY="rclone:gdrive:系统备份/x230-restic-core"
export RESTIC_PASSWORD_FILE="/home/zts/.config/restic/password"

LOG=/var/log/x230-gdrive-backup.log
NTFY_URL="http://127.0.0.1:2586/x230-<REDACTED_TOPIC>"
mkdir -p "$XDG_CACHE_HOME"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
notify() {
  local title="$1" tags="$2" prio="$3" body="$4"
  curl -s -H "Title: $title" -H "Tags: $tags" -H "Priority: $prio" -d "$body" "$NTFY_URL" >/dev/null || true
}

log "=== gdrive core backup start ==="
/usr/local/bin/x230-backup-state /home/zts/backups/system-state >>"$LOG" 2>&1 || true

# 1. 加密核心备份至 Google Drive
restic backup \
  /home/zts /etc /usr/local/bin /var/lib/pacman/local \
  --exclude=/home/zts/.cache \
  --exclude=/home/zts/paru \
  --exclude=/home/zts/.var \
  --exclude=/home/zts/.npm \
  --exclude=/home/zts/.cargo/registry \
  --exclude=/home/zts/.local/share/Trash \
  --exclude=/home/zts/.local/share/pnpm \
  --exclude=/home/zts/.vscode-server \
  --exclude=/home/zts/apps \
  --exclude=/home/zts/Downloads \
  --exclude=/home/zts/blender-pkgs \
  --exclude=/home/zts/Music \
  --exclude=/home/zts/photos-by-date \
  --exclude=/home/zts/phone-photos \
  --exclude='/home/zts/.dsh/**/Cache*' \
  --exclude='/home/zts/.dsh/**/Code Cache*' \
  --exclude='/home/zts/.dsh/**/GPUCache*' \
  --exclude=/home/zts/agent-share/RESTIC-PASSWORD.txt \
  --exclude-caches \
  --tag gdrive-core \
  --compression auto >>"$LOG" 2>&1
b_rc=$?
log "restic backup rc=$b_rc"

if [ "$b_rc" -ne 0 ] && [ "$b_rc" -ne 3 ]; then
  notify "⚠️ X230 GDrive 核心备份失败" "warning" "high" "restic backup rc=$b_rc，详情见 $LOG"
  exit "$b_rc"
fi

# 2. 长期留存策略（比 HK 保留更久，实现跨云容灾）
restic forget \
  --keep-daily 4 --keep-weekly 8 --keep-monthly 12 --prune --max-repack-size 300M --tag gdrive-core >>"$LOG" 2>&1
p_rc=$?
log "restic forget/prune rc=$p_rc"

# 3. 脱敏包清单与工作产出同步
rclone copy /home/zts/backups/system-state "gdrive:系统备份/x230-pkglists" \
  --transfers 4 --checkers 8 --retries 3 >>"$LOG" 2>&1 || true
runuser -u zts -- env HOME=/home/zts HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  /usr/local/bin/put-output-sync >>"$LOG" 2>&1 || true

if [ "$p_rc" -ne 0 ]; then
  notify "⚠️ X230 GDrive 清理异常" "warning" "default" "backup 成功但 prune rc=$p_rc，见 $LOG"
  exit "$p_rc"
fi
log "=== gdrive core backup done ==="

#!/bin/bash
# X230 → 香港服务器 restic 核心增量热备（仅核心配置/代码/DSH/Agent记忆，大型媒体与冷备走 Google Drive）
# 密码文件 /home/zts/.config/restic/password（600），丢失则无法恢复
set -uo pipefail
export HOME=/root
export XDG_CACHE_HOME=/root/.cache
mkdir -p "$XDG_CACHE_HOME"

export RESTIC_REPOSITORY="sftp:root@192.0.2.10:/srv/restic/x230"
export RESTIC_PASSWORD_FILE="/home/zts/.config/restic/password"
SFTP_CMD='ssh -i /home/zts/.ssh/id_ed25519_hk -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 root@192.0.2.10 -s sftp'
SSH_HK='ssh -i /home/zts/.ssh/id_ed25519_hk -o IdentitiesOnly=yes -o ConnectTimeout=10 root@192.0.2.10'
NTFY_URL="http://127.0.0.1:2586/x230-<REDACTED_TOPIC>"

notify_fail() {
  curl -s -H "Title: ⚠️ X230 HK 备份异常" -H "Tags: warning" -H "Priority: high" -d "$1" "$NTFY_URL" >/dev/null || true
}

# 1. 导出最新包清单与系统状态
/usr/local/bin/x230-backup-state /home/zts/backups/system-state >/dev/null || true
$SSH_HK "mkdir -p /srv/backups/x230-pkglists" 2>/dev/null && scp -q -i /home/zts/.ssh/id_ed25519_hk -o IdentitiesOnly=yes /home/zts/backups/system-state/* root@192.0.2.10:/srv/backups/x230-pkglists/ 2>/dev/null || true

# 2. 检查香港服务器剩余空间（低于 600MB 拒绝继续塞入，先尝试 prune 释放）
hk_avail_kb=$($SSH_HK "df -Pk /srv | awk 'NR==2{print \$4}'" 2>/dev/null || echo "")
if [ -n "$hk_avail_kb" ] && [ "$hk_avail_kb" -lt 614400 ]; then
  notify_fail "香港 /srv 剩余空间不足 ($((hk_avail_kb/1024))MB < 600MB)，已跳过新快照写入，将尝试仅 prune 清理"
  restic -o sftp.command="$SFTP_CMD" forget \
    --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune --max-repack-size 200M --tag auto || true
  exit 1
fi

# 3. 备份核心系统配置、脚本、工作区与包数据库（剥离已分流到 GDrive 的大媒体/可再生缓存）
restic -o sftp.command="$SFTP_CMD" backup \
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
  --tag auto \
  --compression auto
b_rc=$?
if [ "$b_rc" -ne 0 ] && [ "$b_rc" -ne 3 ]; then
  notify_fail "restic backup 失败 (rc=$b_rc)"
  exit "$b_rc"
fi

# 4. 清理旧快照（限制单次 repack 体积，防止撑爆 HK 小盘）
restic -o sftp.command="$SFTP_CMD" forget \
  --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 3 --prune --max-repack-size 200M --tag auto
p_rc=$?
if [ "$p_rc" -ne 0 ]; then
  notify_fail "restic forget/prune 失败 (rc=$p_rc)，请检查仓库锁或磁盘空间"
  exit "$p_rc"
fi

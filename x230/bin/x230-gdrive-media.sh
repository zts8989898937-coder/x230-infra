#!/usr/bin/env bash
# x230-gdrive-media.sh — 静态媒体与历史按年相册分桶增量备份到 Google Drive（只增量拷贝，不删远端）
set -uo pipefail

export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export ALL_PROXY=socks5://127.0.0.1:7897
export RCLONE_CONFIG=/home/zts/.config/rclone/rclone.conf

LOG=/home/zts/.local/state/x230-gdrive-media.log
mkdir -p "$(dirname "$LOG")"
FLAGS=(--transfers 4 --checkers 8 --drive-chunk-size 16M --drive-upload-cutoff 16M --tpslimit 8 --retries 5 --stats 300s --stats-one-line)

{
  echo "=== $(date -Is) media sync start ==="
  rc=0
  if [ -d /home/zts/photos-by-date ]; then
    echo "--- sync photos-by-date -> gdrive:照片/X230-按年归档"
    rclone copy /home/zts/photos-by-date "gdrive:照片/X230-按年归档" "${FLAGS[@]}" || rc=$?
  fi
  if [ -d /home/zts/Music ]; then
    echo "--- sync Music -> gdrive:媒体库/X230-Music"
    rclone copy /home/zts/Music "gdrive:媒体库/X230-Music" "${FLAGS[@]}" || rc=$?
  fi
  echo "=== $(date -Is) media sync done rc=$rc ==="
  exit "$rc"
} >>"$LOG" 2>&1

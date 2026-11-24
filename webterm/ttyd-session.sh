#!/bin/bash
# ttyd 把 ?arg=<name> 传进来；同名 session 存在就接回去，不存在就新建
name="${1:-main}"
if (( $# > 1 )) || [[ ! "$name" =~ ^[a-zA-Z0-9_-]{1,120}$ ]]; then
  exit 2
fi
exec tmux -L wt -f /home/zts/agent-share/webterm/tmux.conf new-session -A -s "wt-${name}" /usr/bin/fish -l

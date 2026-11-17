#!/bin/bash
# ttyd 把 ?arg=<name> 传进来；同名 session 存在就接回去，不存在就新建
name="${1:-main}"
exec tmux -L wt -f /home/zts/agent-share/webterm/tmux.conf new-session -A -s "wt-${name}" /usr/bin/fish -l

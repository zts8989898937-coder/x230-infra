#!/usr/bin/env bash
# Live machine snapshots belong in private backups, never in a public source tree.
set -euo pipefail
printf '%s\n' '自动采集真实系统配置的公开同步入口已停用。' '请只提交人工审查过的通用代码和 examples/ 模板；真实配置使用私有备份。' >&2
exit 1

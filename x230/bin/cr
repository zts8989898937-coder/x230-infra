#!/usr/bin/env bash
# 本地 / 远程通用快速编译运行脚本（与 VS Code ▶ 按钮共用 vsc-run + /opt/pch 预编译头）
# 用法：
#   cr                 编译当前目录最新源码并直接等待终端输入数据
#   cr sol.cpp         指定文件，终端输入数据
#   cr sol.cpp -i      读取同目录 in.txt 作为标准输入
#   cr sol.cpp -2      以 -O2 计时运行（有 in.txt 则读入）
set -u

mode="kbd"
src=""
for a in "$@"; do
  case "$a" in
    -i|--in) mode="in" ;;
    -k|--keyboard) mode="kbd" ;;
    -2|--o2) mode="o2" ;;
    *.cpp|*.cc|*.cxx|*.C|*.c|*.py|*.sh) src="$a" ;;
  esac
done

if [ -z "$src" ]; then
  src=$(ls -t ./*.cpp ./*.cc ./*.cxx ./*.c ./*.py 2>/dev/null | head -n 1 || true)
fi
if [ -z "$src" ] || [ ! -f "$src" ]; then
  echo "当前目录没找到可运行文件，用法: cr [源文件] [-i|-k|-2]"
  exit 1
fi

abs_src="$(cd -- "$(dirname -- "$src")" && pwd)/$(basename -- "$src")"
if [ -x /usr/local/bin/vsc-run ]; then
  exec /usr/local/bin/vsc-run "$mode" "$abs_src"
fi

# 兜底（未装 vsc-run 时）
dir="$(dirname -- "$abs_src")"
file="$(basename -- "$abs_src")"
bin="$dir/${file%.*}"
cd "$dir" || exit 1
g++ -std=c++17 -O0 -Wall -Wextra -DLOCAL -o "$bin" "$file" || exit 1
if [ "$mode" = "in" ] && [ -s in.txt ]; then
  exec "$bin" < in.txt
else
  exec "$bin"
fi

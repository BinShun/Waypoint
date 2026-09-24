#!/bin/bash
# Waypoint — 离线启动（macOS 双击运行）
#
# 做什么：
#   1. 找一个能用的 node（系统 / nvm / CodeBuddy 自带的都试一遍）
#   2. 只绑定 127.0.0.1（不对外、不需要网络）
#   3. 数据目录显式指向本脚本所在文件夹的 data/ —— 与从哪个目录双击无关
#   4. 启动后自动打开浏览器
#
# 不做什么：不联网、不装依赖、不改应用代码。AI 未配置时全部功能照常可用。

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
DATA_DIR="$APP_DIR/data"
PORT="${PORT:-8787}"
LOG="/tmp/waypoint-server.log"
PIDFILE="/tmp/waypoint-server.pid"

# ---- 1. 找 node ------------------------------------------------------------
find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  for n in "$HOME"/.nvm/versions/node/*/bin/node \
           "$HOME"/.workbuddy/binaries/node/versions/*/bin/node \
           /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$n" ] && { echo "$n"; return; }
  done
}
NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo "找不到 node（Node.js 18+）。请先安装：https://nodejs.org ，然后重新双击本文件。"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# ---- 2. 端口已被占用？ -----------------------------------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已经在跑 Waypoint 了，直接打开："
else
  mkdir -p "$DATA_DIR"
  HOST=127.0.0.1 PORT="$PORT" WB_DATA_DIR="$DATA_DIR" \
    nohup "$NODE" "$APP_DIR/server/server.mjs" > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  # 等服务器起来
  for _ in $(seq 1 20); do
    curl -s -m 1 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# ---- 3. 打开浏览器 ---------------------------------------------------------
echo
echo "  Waypoint 已启动（仅本机，无需联网）"
echo "  地址 : http://127.0.0.1:$PORT"
echo "  数据 : $DATA_DIR/workbench.json"
echo "  日志 : $LOG     停止：双击 stop.command"
echo
open "http://127.0.0.1:$PORT"
sleep 1

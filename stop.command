#!/bin/bash
# Waypoint — 停止本机服务（macOS 双击运行）
# 只杀 start.command 记录的那一个进程，不做宽泛 pkill，避免误杀别的 node 服务。

PIDFILE="/tmp/waypoint-server.pid"
PORT="${PORT:-8787}"

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    echo "已停止 Waypoint（pid $PID）。"
  else
    echo "进程 $PID 已经不在了。"
  fi
  rm -f "$PIDFILE"
else
  echo "没有找到运行记录（$PIDFILE）。"
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 仍被占用，占用进程："
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN
else
  echo "端口 $PORT 已释放，数据保留在 data/workbench.json。"
fi

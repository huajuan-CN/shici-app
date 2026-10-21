#!/bin/zsh
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=4173

cd "$APP_DIR"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用，请关闭旧服务或修改 start.command 中的 PORT。"
  exit 1
fi

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "拾词正在启动：http://127.0.0.1:$PORT"
python3 -m http.server "$PORT" --bind 127.0.0.1 &
SERVER_PID=$!
sleep 1
open "http://127.0.0.1:$PORT"
echo "关闭此窗口或按 Ctrl+C 可停止本地服务。"
wait "$SERVER_PID"

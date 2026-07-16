#!/bin/zsh

DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$DIR/网页平台"
SERVER_FILE="$WEB_DIR/server.py"
WEB_FILE="$WEB_DIR/index.html"
PORT="${AI_STORYBOARD_PORT:-5176}"

if [[ ! -f "$WEB_FILE" ]]; then
  osascript -e 'display alert "没有找到网页平台/index.html，请确认文件夹完整。"'
  exit 1
fi

if [[ -f "$SERVER_FILE" ]]; then
  PYTHON_BIN="$(command -v python3)"
  if [[ -z "$PYTHON_BIN" ]]; then
    osascript -e 'display alert "没有找到 python3，无法启动本地后端服务。"'
    exit 1
  fi

  if ! lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    sleep 1
    (sleep 1; open "http://127.0.0.1:$PORT/") &
    exec "$PYTHON_BIN" "$SERVER_FILE" --host 127.0.0.1 --port "$PORT"
  fi

  open "http://127.0.0.1:$PORT/"
else
  open "$WEB_FILE"
fi

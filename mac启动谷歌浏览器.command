#!/bin/bash
set -e

CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE_DIR="$HOME/chrome-automation-profile"

if [ ! -x "$CHROME_APP" ]; then
  echo "未找到 Google Chrome：$CHROME_APP"
  read -r -p "按回车退出..."
  exit 1
fi

echo "正在启动 Chrome 远程调试端口 9222..."
echo "自动化 profile：$PROFILE_DIR"
"$CHROME_APP" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR"

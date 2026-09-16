#!/usr/bin/env bash
# 小说创作工作台启动脚本（macOS / Linux）
#
#   ./启动.sh                            写作端，端口 5367
#   ./启动.sh 5368 data-demo --seed      展示端，端口 5368，空库时自动载入示例
#
# 位置参数：[端口] [数据目录] [其余参数原样透传给服务端]

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${1:-5367}"
DATA="${2:-data-work}"
if [ $# -ge 2 ]; then shift 2; elif [ $# -ge 1 ]; then shift 1; fi

if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "$HOME/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" ]; then
  NODE="$HOME/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
else
  echo "未检测到 Node.js，请先安装 LTS 版本：https://nodejs.org"
  exit 1
fi

echo "Novel Studio 启动中：http://localhost:$PORT  （数据目录：$DATA）"
exec "$NODE" "$DIR/server/index.js" "$PORT" "--data=$DATA" "$@"

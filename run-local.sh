#!/usr/bin/env bash
# QAStudio 本地运行脚本（不依赖 Docker）
# 用法: ./run-local.sh init | build | start | stop | restart | status

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT/.qastudio.pid"
LOG_FILE="${QASTUDIO_LOG:-$ROOT/.qastudio.log}"
PORT="${PORT:-7000}"

BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
STATIC_DIR="$BACKEND_DIR/static"

# 解析虚拟环境路径（init 会创建，start 等依赖已存在）
if [[ -d "$ROOT/.venv" ]]; then
  VENV_DIR="$ROOT/.venv"
elif [[ -d "$BACKEND_DIR/.venv" ]]; then
  VENV_DIR="$BACKEND_DIR/.venv"
else
  VENV_DIR=""
fi
if [[ -n "$VENV_DIR" ]]; then
  PYTHON="${VENV_DIR}/bin/python"
  PIP="${VENV_DIR}/bin/pip"
  UVICORN="${VENV_DIR}/bin/uvicorn"
else
  PYTHON=python3
  PIP=pip
  UVICORN=uvicorn
fi

# ---------- init：仅需执行一次（创建虚拟环境、安装依赖、数据库种子） ----------
init_server() {
  echo "========== init: 创建虚拟环境与依赖 =========="
  if [[ -z "$VENV_DIR" ]]; then
    echo "创建项目虚拟环境 $ROOT/.venv ..."
    python3 -m venv "$ROOT/.venv"
    VENV_DIR="$ROOT/.venv"
    PYTHON="${VENV_DIR}/bin/python"
    PIP="${VENV_DIR}/bin/pip"
    UVICORN="${VENV_DIR}/bin/uvicorn"
  fi
  echo "使用虚拟环境: $VENV_DIR"
  if ! "$PYTHON" -c "import fastapi" 2>/dev/null; then
    echo "安装后端依赖..."
    "$PIP" install -r "$BACKEND_DIR/requirements.txt"
  else
    echo "后端依赖已就绪。"
  fi
  echo "========== init: 执行数据库种子（仅需一次） =========="
  cd "$BACKEND_DIR"
  "$PYTHON" -m app.db.seed || true
  cd "$ROOT"
  echo "init 完成。接下来可执行: $0 build 然后 $0 start"
}

# ---------- build：编译前端并部署到 backend/static ----------
build_frontend() {
  echo "========== build: 编译前端 =========="
  if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo "错误: 未找到 node 或 npm，请先安装 Node.js。"
    exit 1
  fi
  cd "$FRONTEND_DIR"
  if [[ ! -d node_modules ]]; then
    echo "安装前端依赖..."
    npm ci
  fi
  export VITE_API_BASE=/api
  npm run build
  cd "$ROOT"
  echo "========== build: 部署到 backend/static =========="
  rm -rf "$STATIC_DIR"
  cp -r "$FRONTEND_DIR/dist" "$STATIC_DIR"
  echo "已复制 frontend/dist -> backend/static"
  echo "build 完成。"
}

# ---------- start：仅启动后端（需已执行 init 与 build） ----------
start_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "服务已在运行 (PID=$pid)，端口 $PORT。如需重启请先执行: $0 stop"
      return 0
    fi
    rm -f "$PID_FILE"
  fi

  if [[ -z "$VENV_DIR" ]] || [[ ! -x "$PYTHON" ]]; then
    echo "错误: 未找到虚拟环境，请先执行: $0 init"
    exit 1
  fi
  if [[ ! -f "$STATIC_DIR/index.html" ]]; then
    echo "错误: 未找到前端构建产物，请先执行: $0 build"
    exit 1
  fi

  echo "========== 启动后端 =========="
  cd "$BACKEND_DIR"
  export CORS_ORIGIN_REGEX="${CORS_ORIGIN_REGEX:-https?://.*}"
  : >> "$LOG_FILE" 2>/dev/null || true
  "$UVICORN" app.main:app --host 0.0.0.0 --port "$PORT" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  cd "$ROOT"
  sleep 1
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "QAStudio 已启动: http://127.0.0.1:$PORT"
    echo "日志文件: $LOG_FILE  查看: tail -f $LOG_FILE"
    echo "通过本机 IP 访问: 请放行防火墙端口 $PORT（如: sudo ufw allow $PORT）"
    echo "停止服务: $0 stop"
  else
    echo "启动失败，请查看上方错误信息。"
    rm -f "$PID_FILE"
    exit 1
  fi
}

# ---------- stop：仅停止后端进程 ----------
stop_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "正在停止 QAStudio 服务 (PID=$pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
      echo "已停止。"
    else
      echo "进程 $pid 已不存在。"
    fi
    rm -f "$PID_FILE"
  else
    echo "未找到 PID 文件，服务可能未在运行。"
  fi
}

# ---------- status ----------
status_server() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "QAStudio 运行中 (PID=$pid)，端口 $PORT -> http://127.0.0.1:$PORT"
    else
      echo "PID 文件存在但进程已退出。"
      rm -f "$PID_FILE"
    fi
  else
    echo "QAStudio 未运行。"
  fi
}

# ---------- 入口 ----------
case "${1:-}" in
  init)    init_server ;;
  build)   build_frontend ;;
  start)   start_server ;;
  stop)    stop_server ;;
  restart) stop_server; start_server ;;
  status)  status_server ;;
  *)
    echo "用法: $0 { init | build | start | stop | restart | status }"
    echo "  init   - 仅需一次：创建 Python 虚拟环境、安装后端依赖、执行数据库种子"
    echo "  build  - 编译前端并部署到 backend/static"
    echo "  start  - 启动后端服务（需已执行 init 和 build）"
    echo "  stop   - 停止后端服务"
    echo "  restart - 先 stop 再 start"
    echo "  status - 查看运行状态"
    exit 1
    ;;
esac

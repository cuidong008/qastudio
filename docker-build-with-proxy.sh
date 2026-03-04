#!/usr/bin/bash
# WSL2 下使用 Windows 上的代理构建镜像（代理地址默认 127.0.0.1:7890）
# 用法: ./docker-build-with-proxy.sh
# 指定代理主机: WINDOWS_IP=172.16.84.250 ./docker-build-with-proxy.sh  或  PROXY_HOST=172.16.84.250 ./docker-build-with-proxy.sh
# 指定端口:     PROXY_PORT=7890 ./docker-build-with-proxy.sh

set -e
PROXY_PORT="${PROXY_PORT:-7890}"

# 代理所在主机 IP：优先用环境变量，否则从 WSL2 的 /etc/resolv.conf 取 nameserver（可能不准）
if [[ -n "${WINDOWS_IP:-}" ]]; then
  :
elif [[ -n "${PROXY_HOST:-}" ]]; then
  WINDOWS_IP="$PROXY_HOST"
elif [[ -f /etc/resolv.conf ]]; then
  WINDOWS_IP=$(grep '^nameserver' /etc/resolv.conf | awk '{print $2}' | head -n1)
else
  WINDOWS_IP="host.docker.internal"
fi

if [[ -z "$WINDOWS_IP" ]]; then
  echo "无法获取 Windows 主机 IP，请检查 /etc/resolv.conf"
  exit 1
fi

PROXY_URL="http://${WINDOWS_IP}:${PROXY_PORT}"
echo "使用代理: $PROXY_URL"
echo "构建镜像: qastudio"
echo ""

docker build --network=host \
  --build-arg HTTP_PROXY="$PROXY_URL" \
  --build-arg HTTPS_PROXY="$PROXY_URL" \
  --build-arg NO_PROXY="localhost,127.0.0.1,192.168.0.0/16" \
  -t qastudio ./


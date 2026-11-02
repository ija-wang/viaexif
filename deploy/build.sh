#!/usr/bin/env bash
# 一键部署 viaEXIF 自托管水印器
#   sudo bash build.sh pull     拉 GHCR 现成镜像并启动（最快，不编译）
#   sudo bash build.sh          本地构建 + 启动
#   sudo bash build.sh logs     跟随日志
#   sudo bash build.sh down     停止（数据卷保留）
#   sudo bash build.sh clean    停止 + 删镜像 + 删数据卷
#   sudo bash build.sh status   查看容器与镜像状态
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

command -v docker >/dev/null || { echo "[x] 未找到 docker"; exit 1; }
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi

MODE="${1:-up}"
PRIMARY_BASE="python:3.12-slim"
FALLBACK_BASE="registry.cn-hangzhou.aliyuncs.com/library/python:3.12-slim"
LOCAL_IMAGE="viaexif:1.1.1"
REMOTE_IMAGE="${VIAEXIF_IMAGE:-ghcr.io/ija-wang/viaexif:latest}"

build() {
  local base="$1"
  echo "==> 构建（base=${base}）"
  docker build --progress=plain -t "$LOCAL_IMAGE" \
    --build-arg BASE_IMAGE="${base}" . 2>&1 | tail -40
}

# 健康检查轮询：健康即返回，超时也返回（不阻塞后续输出）
wait_healthy() {
  echo "==> 等待健康检查（最多 60s）"
  local st
  for i in $(seq 1 30); do
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' viaexif 2>/dev/null || echo "missing")
    printf '    [%02d] %s\n' "$i" "$st"
    [ "$st" = "healthy" ] && return 0
    sleep 2
  done
  echo "!! 未在 60s 内变为 healthy，查看日志：sudo bash $0 logs"
}

banner() {
  echo
  docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' | grep -i viaexif || true
  echo
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "==> 镜像：$1"
  echo "==> 访问：http://${IP:-<本机IP>}:8080"
}

case "$MODE" in
  pull)
    if ! docker pull "$REMOTE_IMAGE"; then
      echo "!! 直连失败，改用加速前缀重试"
      ALT="ghcr.1ms.run/${REMOTE_IMAGE#ghcr.io/}"
      echo "   $ALT"
      docker pull "$ALT" || { echo "[x] 拉取失败，检查网络或改用 build 模式"; exit 1; }
      docker tag "$ALT" "$REMOTE_IMAGE"
    fi
    VIAEXIF_IMAGE="$REMOTE_IMAGE" $DC up -d --no-build || { echo "[x] 启动失败"; exit 1; }
    wait_healthy
    banner "$REMOTE_IMAGE"
    ;;

  up)
    if ! build "$PRIMARY_BASE"; then
      echo "!! 主镜像构建失败，改用阿里云镜像站重试"
      build "$FALLBACK_BASE" || { echo "[x] 两种 base 均失败，请检查网络/daemon.json"; exit 1; }
    fi

    echo "==> 启动容器"
    VIAEXIF_IMAGE="$LOCAL_IMAGE" $DC up -d --no-build || { echo "[x] 启动失败"; exit 1; }

    wait_healthy
    banner "$LOCAL_IMAGE"
    ;;

  logs)   $DC logs -f --tail 100 ;;
  status)
    docker ps -a --filter name=viaexif --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo; docker images | grep -i viaexif || echo "（无镜像）"
    ;;
  down)   $DC down && echo "==> 已停止，数据卷保留" ;;
  clean)  $DC down -v; docker rmi "$LOCAL_IMAGE" "$REMOTE_IMAGE" 2>/dev/null; echo "==> 镜像与卷已清理" ;;
  *)      echo "用法: sudo bash $0 [pull|up|logs|status|down|clean]"; exit 1 ;;
esac

#!/usr/bin/env bash
# 一键构建并启动 viaEXIF 自托管水印器
#   sudo bash build.sh          构建 + 启动
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

build() {
  local base="$1"
  echo "==> 构建（base=${base}）"
  docker build --progress=plain -t viaexif:1.1.0 \
    --build-arg BASE_IMAGE="${base}" . 2>&1 | tail -40
}

case "$MODE" in
  up)
    if ! build "$PRIMARY_BASE"; then
      echo "!! 主镜像构建失败，改用阿里云镜像站重试"
      build "$FALLBACK_BASE" || { echo "[x] 两种 base 均失败，请检查网络/daemon.json"; exit 1; }
    fi

    echo "==> 启动容器"
    $DC up -d --no-build || { echo "[x] 启动失败"; exit 1; }

    echo "==> 等待健康检查（最多 60s）"
    for i in $(seq 1 30); do
      st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' viaexif 2>/dev/null || echo "missing")
      printf '    [%02d] %s\n' "$i" "$st"
      [ "$st" = "healthy" ] && break
      sleep 2
    done

    echo
    docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}  {{.CreatedSince}}' | grep -i viaexif || true
    echo
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "==> 镜像：viaexif:1.1.0"
    echo "==> 访问：http://${IP:-<本机IP>}:8080"
    ;;

  logs)   $DC logs -f --tail 100 ;;
  status)
    docker ps -a --filter name=viaexif --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    echo; docker images | grep -i viaexif || echo "（无镜像）"
    ;;
  down)   $DC down && echo "==> 已停止，数据卷保留" ;;
  clean)  $DC down -v; docker rmi viaexif:1.1.0 2>/dev/null; echo "==> 镜像与卷已清理" ;;
  *)      echo "用法: sudo bash $0 [up|logs|status|down|clean]"; exit 1 ;;
esac

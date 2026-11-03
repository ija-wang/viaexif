#!/usr/bin/env bash
# 把一个已经在跑的 viaEXIF 容器换到新镜像，其余参数照抄旧容器。
#
#   sudo bash deploy/upgrade.sh                 # 换成脚本里写死的 GHCR 镜像
#   sudo bash deploy/upgrade.sh <镜像:tag>      # 换到指定镜像
#
# 为什么不是 pull + restart：容器的镜像在创建时就固定了，`restart` 和
# `docker container update` 都不会重新解包镜像层——只有重建容器才会。
# 为什么不是手抄参数：漏一个 -v 就是一个「能跑但数据是空」的容器，
# 所以这里直接从 docker inspect 复刻 env / 挂载 / 端口 / 重启策略 / 标签。
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "[x] 需要 root：sudo bash deploy/upgrade.sh"; exit 1; }
command -v docker >/dev/null || { echo "[x] 未找到 docker"; exit 1; }
command -v python3 >/dev/null || { echo "[x] 未找到 python3（用来解析 inspect 输出）"; exit 1; }

IMG="${1:-ghcr.io/ija-wang/viaexif:1.2.2}"

NAME=$(docker ps -a --format '{{.Names}}\t{{.Image}}' | grep -i 'viaexif' | head -1 | cut -f1)
if [ -z "${NAME:-}" ]; then
  echo "[x] 没找到 viaexif 容器。现有容器："
  docker ps -a --format '  {{.Names}}\t{{.Image}}\t{{.Status}}'
  exit 1
fi

OLD_IMG=$(docker inspect "$NAME" --format '{{.Config.Image}}')
echo "== 容器 =="
echo "   名称   $NAME"
echo "   旧镜像 $OLD_IMG"
echo "   新镜像 $IMG"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
docker inspect "$NAME" > "$TMP/old.json"

# 从 inspect 拼一条等价的 docker run，只换镜像。env 只保留本项目认的
# （EXIF_ / PORT / TZ）——镜像自带的 PATH、PYTHON_VERSION 这些由新镜像自己
# 提供，照抄过去反而把旧值钉死。
python3 - "$TMP/old.json" "$IMG" "$OLD_IMG" "$TMP/run-new.sh" "$TMP/run-old.sh" <<'PY'
import json, shlex, sys

spec = json.load(open(sys.argv[1]))[0]


def render(img):
    h = spec["HostConfig"]
    cfg = spec["Config"]
    out = ["docker", "run", "-d", "--name", spec["Name"].lstrip("/")]
    out += ["--restart", (h.get("RestartPolicy") or {}).get("Name") or "always"]
    for bind in h.get("Binds") or []:
        out += ["-v", bind]
    for cport, binds in (h.get("PortBindings") or {}).items():
        for b in binds:
            host = b.get("HostIp") or ""
            out += ["-p", f"{host + ':' if host else ''}{b['HostPort']}:{cport.split('/')[0]}"]
    for env in cfg.get("Env") or []:
        if env.split("=", 1)[0].startswith(("EXIF_", "PORT", "TZ")):
            out += ["-e", env]
    net = h.get("NetworkMode")
    if net and net not in ("default", "bridge"):
        out += ["--network", net]
    if h.get("ReadonlyRootfs"):
        out += ["--read-only"]
    for label, value in (cfg.get("Labels") or {}).items():
        if label.startswith(("org.opencontainers.image.", "com.docker.")):
            continue      # 镜像自带，让新镜像自己声明
        out += ["--label", f"{label}={value}"]
    out.append(img)
    return " ".join(shlex.quote(a) for a in out)


open(sys.argv[4], "w").write(render(sys.argv[2]) + "\n")
open(sys.argv[5], "w").write(render(sys.argv[3]) + "\n")
PY

echo "== 重建命令 =="
cat "$TMP/run-new.sh"
echo
echo "== 拉取 =="
docker pull "$IMG"

echo "== 重建 =="
docker stop "$NAME" >/dev/null
docker rm "$NAME" >/dev/null
bash "$TMP/run-new.sh" >/dev/null

PORT=$(docker inspect "$NAME" --format '{{range $p, $c := .HostConfig.PortBindings}}{{(index $c 0).HostPort}}{{end}}' 2>/dev/null || true)
PORT=${PORT:-8080}
echo "== 等待 :$PORT 应答 =="
body=""
for _ in $(seq 1 40); do
  body=$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)
  [ -n "$body" ] && break
  sleep 1
done

if [ -z "$body" ]; then
  echo "[x] 新容器 40 秒内没有应答，回滚到 $OLD_IMG"
  docker logs --tail 40 "$NAME" 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  bash "$TMP/run-old.sh" >/dev/null
  echo "[x] 已回滚。上面是失败容器的日志。"
  exit 1
fi

echo "$body"
echo "== 完成：$NAME 现在跑 $(docker inspect "$NAME" --format '{{.Config.Image}}') =="

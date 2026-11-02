# 基础镜像可用 build-arg 覆盖，国内直连 Docker Hub 不通时改用镜像站：
#   docker compose build --build-arg BASE_IMAGE=registry.cn-hangzhou.aliyuncs.com/library/python:3.12-slim
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    EXIF_DATA_DIR=/data

# pip 源：默认走阿里云（NAS 实测 pypi.org 3.5s / 阿里云 2.9s 且更稳）
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_TRUSTED_HOST=mirrors.aliyun.com
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# rawpy's manylinux wheel links against the OpenMP runtime, which Debian slim
# does not ship; without it `import rawpy` dies with "libgomp.so.1".
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/*

COPY server ./server
COPY web ./web

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin app \
 && mkdir -p /data \
 && chown -R app:app /data

USER app

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import os,sys,urllib.request;p=os.environ.get('PORT','8080');sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+p+'/api/health',timeout=2).status==200 else 1)"

CMD ["sh", "-c", "exec uvicorn server.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers"]

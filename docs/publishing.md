# 发布：GitHub、镜像仓库与飞牛（fnOS）

这份文档回答两件事：

1. 代码怎么推到 GitHub；
2. 镜像怎么发布，才能**在飞牛 NAS 的「镜像仓库」里搜到 / 装到**。

---

## 一、推到 GitHub

仓库已经初始化好（`main` 分支，首次提交完成），只差一个远端。

```bash
cd viaexif

# 1) 建空仓库（不要勾 README / .gitignore / license，本地已有）
#    https://github.com/new  →  Repository name: viaexif  →  Public  →  Create

# 2) 挂远端并推送
git remote add origin git@github.com:<你的用户名>/viaexif.git
git push -u origin main
```

用 HTTPS 的话把第二行换成：

```bash
git remote add origin https://github.com/<你的用户名>/viaexif.git
```

### 走 SSH 的话，先确认公钥已在 GitHub 上

```bash
ssh -T git@github.com     # 期望输出 Hi <用户名>! ...
```

如果提示 `Permission denied (publickey)`，把本机公钥贴到 <https://github.com/settings/ssh/new>：

```bash
cat ~/.ssh/id_ed25519.pub    # 复制整行，Title 随便填，Key type 选 Authentication Key
```

> 本机 `github.com:22` 与 `ssh.github.com:443` 都可直连；`github.com` 的 443 在部分网络下会被阻断，
> 表现为浏览器打不开但 `git push`（走 22 端口）正常。

---

## 二、镜像发布：CI 已经写好

`.github/workflows/docker.yml` 会在 `main` 分支推送和 `v*` 标签时自动构建并推两个地方：

| Registry | 镜像地址 | 需要的配置 |
|---|---|---|
| GHCR | `ghcr.io/ija-wang/viaexif:latest` | 无，用仓库自带的 `GITHUB_TOKEN` |
| Docker Hub | `docker.io/<用户名>/viaexif:latest` | 见下 |

Docker Hub 是**可选**的：没配就只推 GHCR，工作流照样绿。

构建完成后还有一个 `smoke` job：它把**刚推上去的那个镜像**真的拉下来跑起来，验证静态页、`/api/health` 的能力位（`heic` / `raw` / `heicEncode`）、HEIC 解码、RAW 解码、HEIC 编码。构建绿只说明轮子装上了，`libgomp` / `libheif` 的运行时问题要到导入时才炸 —— 这一层由它兜住。

### 想让 CI 也推 Docker Hub

1. Docker Hub → Account settings → Personal access tokens → **Generate new token**，权限选 **Read & Write**（不是 Read-only），复制出来；
2. GitHub 仓库 → Settings → Secrets and variables → Actions：
   - **Variables** 标签页 → `DOCKERHUB_USERNAME` = 你的 Docker Hub 用户名；
   - **Secrets** 标签页 → `DOCKERHUB_TOKEN` = 上一步的 token。
3. 重跑工作流（Actions → docker → Re-run），或推一个空提交触发。

token 只显示一次，务必当场复制。

### 打版本标签

```bash
git tag v1.1.6 && git push origin v1.1.6
```

`docker/metadata-action` 会把 `v1.1.6` 展开成 `1.1.6`、`1.1`、`latest` 三个 tag。

### 想同时出 ARM 镜像（群晖 ARM / 树莓派）

Actions → docker → Run workflow，`platforms` 填 `linux/amd64,linux/arm64`。
arm64 走 QEMU 模拟，构建时间大约翻 4 倍；`pillow-heif` 和 `rawpy` 在 PyPI 上都有 aarch64 轮子，能装上。

---

## 三、飞牛镜像仓库"搜得到"的真相

先把机制说清楚，否则会一直白试。

飞牛 Docker → **镜像仓库** 页面里的搜索框，查的是 **Docker Hub 的公开搜索索引**（`hub.docker.com/v2/search/repositories/`）。
它**不是**搜你添加的"镜像源"，也**不搜** GHCR / 阿里云 ACR。

所以在飞牛里能被搜到，同时满足三个条件才行：

1. 镜像在 **Docker Hub** 上，且仓库是 **public**；
2. Docker Hub 的搜索索引收录了它 —— 新建仓库通常要**几小时到一天**才进索引，刚推完搜不到是正常的；
3. **NAS 能访问 `hub.docker.com`**。

第 3 条是最容易翻车的一条。在本机 NAS（`ijaHub` / fnOS）上实测：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://hub.docker.com/v2/search/repositories/?query=nginx
# → 000   （连不上）
curl -s -o /dev/null -w '%{http_code}\n' https://ghcr.io/v2/
# → 401   （可达，401 是未认证的正常响应）
```

也就是说：**即使镜像已经在 Docker Hub 上，这台 NAS 的搜索框也大概率搜不出东西**——
飞牛论坛上"同样的网络环境群晖能搜到、fnOS 搜不到"的帖子，根因就在这。

### 结论：别指望搜索，用下面三条路

#### 路 A（最省事）：直接拉，绕开搜索框

飞牛 Docker → **镜像** → 右上角 **拉取** → 填完整地址：

```
ghcr.io/ija-wang/viaexif:latest
```

国内直连 `ghcr.io` 慢的话，用加速前缀（飞牛「仓库设置」里加的源也是同一个原理）：

```
ghcr.1ms.run/ija-wang/viaexif:latest
```

拉完在「本地镜像」里就有了，点运行即可。这条路不依赖 Docker Hub，最稳。

> **2026-11-02 实测**：`ghcr.io/ija-wang/viaexif` 的两个 tag（`latest` / `main`）匿名 token 即可取到 manifest，包是 public；
> 从 `ijaHub`（192.168.50.222）发起同样的请求返回 `manifest:200`，说明这台 NAS 直连 GHCR 就能拉，不需要额外配镜像源。

#### 路 B：用 Compose 装（能开机自启、带健康检查）

飞牛 Docker → **Compose** → 新增项目，粘贴：

```yaml
services:
  viaexif:
    image: ghcr.io/ija-wang/viaexif:latest
    container_name: viaexif
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      EXIF_SHARE_TTL: "86400"
      EXIF_MAX_UPLOAD_MB: "40"
      EXIF_MAX_DECODE_MB: "200"
      EXIF_DECODE_MAX_PX: "12000"
    volumes:
      - ./data:/data
```

#### 路 C（真要让「镜像仓库」里翻得到）：在 NAS 上自建私有 registry

搜索框搜不到自建仓库，但飞牛「仓库设置 → 添加」支持填私有地址 + 账号密码，
添加后可以在该仓库下浏览镜像 —— 这是唯一能"在飞牛界面里看到自己镜像"的可控方式。

```bash
# NAS 上（ija 不在 docker 组，需要 sudo）
sudo docker run -d --name registry -p 5000:5000 \
  -v /vol2/docker/registry:/var/lib/registry \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  registry:2
```

把本机构建好的镜像塞进去（在能跑 docker 的机器上）：

```bash
docker tag viaexif:1.1.6 192.168.50.222:5000/viaexif:1.1.6
docker push 192.168.50.222:5000/viaexif:1.1.6
```

NAS 的 `/etc/docker/daemon.json` 里已有 `insecure-registries`，
把 `192.168.50.222:5000` 加进去（**别用脚本整份覆盖这个文件**，里面有 `data-root`，写坏了镜像和容器会一起消失），
然后在飞牛「仓库设置」里添加 `http://192.168.50.222:5000`。

> registry:2 的 `_catalog` 只列仓库名，不支持关键词搜索；想要搜索能力就换 Harbor（飞牛论坛有教程）。

---

## 四、本机没有 Docker 时怎么办

这台 Windows 上没装 Docker Desktop，所以构建只能在别处做。两个选择：

- **交给 GitHub Actions**（推荐）：推上去就自动出镜像，本机什么都不用装；
- **在 NAS 上构建**：

```bash
ssh ija@192.168.50.222
cd ~/viaexif && sudo bash deploy/build.sh
```

`deploy/build.sh` 内置国内镜像站回退（Docker Hub 直连失败时自动换阿里云 / 1ms），
并把 `APP_VERSION` 打进镜像标签。

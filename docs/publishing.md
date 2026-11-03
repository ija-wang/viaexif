# 发布：GitHub、镜像仓库与 NAS 安装

这份文档回答三件事：

1. 代码怎么推到 GitHub、CI 怎么出镜像；
2. 镜像怎么发到 GHCR / Docker Hub，版本 tag 怎么来；
3. 在 NAS（飞牛 fnOS、群晖或任意 Linux）上怎么装、怎么升级。

> 文中 `<你的用户名>` 指 GitHub 用户名或组织名，`<NAS-IP>` 指 NAS 的局域网地址，
> `<数据目录>` 指宿主上给容器 `/data` 用的持久化路径。按自己的环境替换即可。

---

## 一、推到 GitHub

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

> `github.com:22` 与 `ssh.github.com:443` 两条通路都可以用；部分网络会阻断 `github.com` 的 443，
> 表现为浏览器打不开但 `git push`（走 22 端口）正常，这时把远端改成 `ssh.github.com:443` 即可。

---

## 二、镜像发布：CI 已经写好

`.github/workflows/docker.yml` 在 `main` 分支推送和 `v*` 标签时自动构建并推两个地方：

| Registry | 镜像地址 | 需要的配置 |
|---|---|---|
| GHCR | `ghcr.io/<你的用户名>/viaexif:latest` | 无，用仓库自带的 `GITHUB_TOKEN` |
| Docker Hub | `docker.io/<你的DockerHub用户名>/viaexif:latest` | 见下 |

工作流里的镜像前缀取自 `github.repository_owner`，所以**换仓库不用改代码**，谁 fork 谁就能出自己的镜像。

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
git tag v1.2.0 && git push origin v1.2.0
```

`docker/metadata-action` 会把 `v1.2.0` 展开成 `1.2.0`、`1.2`、`latest` 三个 tag。
版本号以 `server/config.py: APP_VERSION` 为准，打标签前先确认它和这次的改动一致——
`/api/health` 返回的 `version` 就是从这个常量来的，三者对不上时排障会很痛苦。

### 想同时出 ARM 镜像（群晖 ARM / 树莓派）

Actions → docker → Run workflow，`platforms` 填 `linux/amd64,linux/arm64`。
arm64 走 QEMU 模拟，构建时间大约翻 4 倍；`pillow-heif` 和 `rawpy` 在 PyPI 上都有 aarch64 轮子，能装上。

---

## 三、在 NAS 上装

### 先搞清楚一件事：镜像仓库的搜索框查不到你

飞牛 Docker → **镜像仓库** 页面里的搜索框，查的是 **Docker Hub 的公开搜索索引**（`hub.docker.com/v2/search/repositories/`）。
它**不是**搜你添加的"镜像源"，也**不搜** GHCR / 阿里云 ACR。

所以在飞牛里能被搜到，要同时满足三个条件：

1. 镜像在 **Docker Hub** 上，且仓库是 **public**；
2. Docker Hub 的搜索索引收录了它 —— 新建仓库通常要**几小时到一天**才进索引，刚推完搜不到是正常的；
3. **NAS 能访问 `hub.docker.com`**。

第 3 条是最容易翻车的一条。很多国内网络环境下 `hub.docker.com` 直接不可达：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://hub.docker.com/v2/search/repositories/?query=nginx
# → 000   （连不上）
curl -s -o /dev/null -w '%{http_code}\n' https://ghcr.io/v2/
# → 401   （可达，401 是未认证的正常响应）
```

也就是说：**即使镜像已经在 Docker Hub 上，搜索框也大概率搜不出东西**——
飞牛论坛上"同样的网络环境群晖能搜到、fnOS 搜不到"的帖子，根因就在这。

### 路 A（最省事）：直接拉，绕开搜索框

飞牛 Docker → **镜像** → 右上角 **拉取** → 填完整地址：

```
ghcr.io/<你的用户名>/viaexif:1.2.0
```

国内直连 `ghcr.io` 慢的话，用加速前缀（飞牛「仓库设置」里加的源也是同一个原理）：

```
ghcr.1ms.run/<你的用户名>/viaexif:1.2.0
```

拉完在「本地镜像」里就有了，点运行即可。这条路不依赖 Docker Hub，最稳。

> GHCR 上的包默认是 public 的，匿名 token 就能取到 manifest：
> `curl -s "https://ghcr.io/token?scope=repository:<你的用户名>/viaexif:pull&service=ghcr.io"`。
> 如果返回 403 / manifest:denied，去仓库 Packages 页面把包可见性改成 public。

### 路 B：用 Compose 装（能开机自启、带健康检查）

飞牛 Docker → **Compose** → 新增项目，粘贴：

```yaml
services:
  viaexif:
    image: ghcr.io/<你的用户名>/viaexif:1.2.0
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

绑定的 `./data` 要可写。容器里以 `app`（uid 10001）运行，bind mount 权限不对会起不来：

```bash
sudo chown -R 10001:10001 ./data
```

不想折腾权限就用具名卷（`viaexif-data:/data`），权限自动继承。

### 路 C（真要让「镜像仓库」里翻得到）：在 NAS 上自建私有 registry

搜索框搜不到自建仓库，但飞牛「仓库设置 → 添加」支持填私有地址 + 账号密码，
添加后可以在该仓库下浏览镜像 —— 这是唯一能「在飞牛界面里看到自己镜像」的可控方式。

```bash
# NAS 上（docker 一般需要 sudo）
sudo docker run -d --name registry -p 5000:5000 \
  -v <数据目录>/registry:/var/lib/registry \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  registry:2
```

把本机构建好的镜像塞进去（在能跑 docker 的机器上）：

```bash
docker tag viaexif:1.2.0 <NAS-IP>:5000/viaexif:1.2.0
docker push <NAS-IP>:5000/viaexif:1.2.0
```

NAS 的 `/etc/docker/daemon.json` 里要有 `insecure-registries` 并包含 `<NAS-IP>:5000`
（**别用脚本整份覆盖这个文件**，里面通常还有 `data-root`，写坏了镜像和容器会一起消失）：

```json
{
  "insecure-registries": ["<NAS-IP>:5000"]
}
```

改完 `sudo systemctl restart docker`，再在飞牛「仓库设置」里添加 `http://<NAS-IP>:5000`。

> registry:2 的 `_catalog` 只列仓库名，不支持关键词搜索；想要搜索能力就换 Harbor。

---

## 四、升级已有容器

镜像 tag 是容器的不可变字段，`docker compose up -d` 只对 compose 管的容器有效。
先确认容器是谁起的：

```bash
sudo docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' viaexif
```

- 有输出（compose 项目名）→ compose 管的，直接：

  ```bash
  cd <项目目录> && sudo docker compose pull && sudo docker compose up -d
  ```

- 输出为空 → **界面或 `docker run` 起的独立容器**，只能按原参数重建：

  ```bash
  sudo docker inspect viaexif          # 抄下 Env / Mounts / PortBindings / RestartPolicy
  sudo docker pull ghcr.io/<你的用户名>/viaexif:<新版本>
  sudo docker stop viaexif && sudo docker rm viaexif
  sudo docker run -d --name viaexif --restart always -p 8080:8080 \
    -v <数据目录>:/data ghcr.io/<你的用户名>/viaexif:<新版本>
  ```

`docker container update` 只能改 CPU / 内存这类资源项，**改不了 image**。
重建前务必对一遍挂载路径和 env，漏掉 `-v` 会得到一个「能跑但数据是空」的容器。

验证升级是否生效：

```bash
curl -s http://<NAS-IP>:8080/api/health    # 期望 version 与目标版本一致
```

---

## 五、本机没有 Docker 时怎么办

构建只能在别处做，两个选择：

- **交给 GitHub Actions**（推荐）：推上去就自动出镜像，本机什么都不用装；
- **在 NAS 上构建**（NAS 上要有源码）：

  ```bash
  ssh <你的用户>@<NAS-IP>
  cd <源码目录> && sudo bash deploy/build.sh
  ```

`deploy/build.sh` 内置国内镜像站回退（Docker Hub 直连失败时自动换阿里云 / 1ms），
并把 `server/config.py` 里的 `APP_VERSION` 打进本地镜像 tag。

---

## 六、应用图标（含将来的飞牛 fpk）

图标是一件而不是两件东西，避免「网页一个样、安装包里又是旧图」：

| 文件 | 用途 |
|---|---|
| `web/assets/viaexif.svg` | **母版**（矢量，160×160，圆角 30）。页头标记、favicon、apple-touch-icon 都用它 |
| `web/assets/icons/icon-<n>.png` | 由母版栅格化：16 / 32 / 48 / 64 / 128 / 180 / 192 / 256 / 512 |

母版改了之后重出一套（透明底，圆角外是空的）：

```bash
node tools/make-icons.mjs      # 写 web/assets/icons/icon-*.png
```

做 fpk 时直接拿 `icon-256.png`，别从网页截图：它是 1:1 像素、无压缩损失。
仓库里没有 `manifest` 或 `.fpk` 脚手架——真要做的时候再按飞牛当时的模板补，
但图标、版本号（`server/config.py: APP_VERSION`）和镜像 tag 三者必须同号。

## 七、字体

`web/assets/fonts/*.woff2` 与 `web/css/fonts.css` 都是**生成物，已提交**——正常构建不需要 fonttools，
也不需要 Maple Mono 的原始 TTF。它们只在换字体或改字符集时重出：

```bash
python tools/build-fonts.py <maple-mono 字体目录> --write
python tools/build-fonts.py <maple-mono 字体目录> --check   # 只校验，CI 可用来挡漂移
```

每个字面约 40 KB（16 个共 0.62 MB），字符集见工具里的 `UNICODES`。
字体许可为 SIL OFL 1.1，`LICENSE.txt` 与 woff2 放在同一目录随包分发——OFL 要求保留，
删了就不是「忘了带」，而是违约。

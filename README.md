# Aki Password Gen

一个纯 Node.js + 原生 HTML/JS 的密码生成器，用来替代老旧的
[luzifer/password](https://github.com/Luzifer/password)（luzifer-password-gen）Docker 镜像。

- **API 完全兼容**：`/v1/getPassword?length=10&special=true` 这类旧调用原样可用
- **核心增强**：特殊字符集可自定义（`special_chars` 参数），解决"某些系统只允许部分符号，每次都要手动替换"的痛点
- **零依赖**：服务端只用了 Node 内置模块，前端无任何框架/CDN 资源，可完全离线运行
- **纯本地生成**：网页端密码在浏览器内用 Web Crypto 生成，不经过网络；API 也不记录任何日志

## 功能

- 随机密码：长度 4–128，大小写/数字/符号四类字符独立开关
- **自定义特殊字符集**（内置旧版字符集、`!@#$%`、`-_.`、`!@#$%^&*` 等预设）
- 排除易混淆字符（`I l 0 O B 8`）、避免键盘/字母表序列、避免相邻重复（默认行为与旧版一致，均可关闭）
- 短语密码（XKCD 风格）：单词数 4–12、自定义分隔符、日期前缀（与旧版 `xkcd=true` 行为一致）
- 批量生成（`amount`，最多 100 个）、JSON 输出（`format=json`）
- 网页端实时强度评估、一键复制、设置本地保存、暗色模式

## 快速开始

```bash
docker run -d --name aki-password-gen -p 3000:3000 --restart unless-stopped ghcr.io/akikazehub/aki-password-gen:latest
```

或使用 docker compose（见 `docker-compose.yml`）。然后访问 `http://<主机>:3000`。

## API 文档

### `GET /v1/getPassword`

成功时返回 `text/plain` 纯文本密码（无换行符，与旧版一致）。所有 API 响应带 `Access-Control-Allow-Origin: *`。

#### 兼容参数（与旧版 luzifer/password 完全一致）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `length` | `20` | 密码长度，4–128；`xkcd=true` 时表示**单词数**。越界返回 406 |
| `special` | `false` | `true` 时启用特殊字符（默认字符集见下） |
| `xkcd` | `false` | `true` 时生成短语密码 |
| `date` | `true` | 仅 xkcd 模式：是否前缀 `YYYYMMDD.`，`false` 关闭 |
| `separator` | 空 | 仅 xkcd 模式：单词分隔符 |

默认特殊字符集（与旧版相同）：`!#$%&()*+,-_./:;=?@[]^{}~|`

#### 新增参数（扩展功能）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `special_chars`（别名 `custom_symbols`） | 旧版字符集 | **自定义特殊字符集合**，URL 编码后传入。指定后自动启用符号（除非显式传 `symbols=false`） |
| `symbols` | 同 `special` | 符号开关（`special` 是它的旧版别名） |
| `lowercase` / `uppercase` / `digits` | `true` | 小写 / 大写 / 数字开关 |
| `exclude_ambiguous` | `true` | 排除易混淆字符 `I l 0 O B 8`（旧版强制排除，故默认开启） |
| `avoid_sequences` | `true` | 避免 `abc`、`123`、`qwerty` 等序列（旧版强制） |
| `allow_repeats` | `false` | 允许相邻字符重复（旧版禁止） |
| `amount` | `1` | 一次生成 1–100 个；文本模式用换行分隔 |
| `format` | `text` | `json` 时返回 JSON 数组 |

布尔参数与旧版语义一致：只有字面量 `true` / `false` 生效。

#### 错误响应

- `406`：`Please do not use length with more than 128 or fewer than 4 characters!`
- `400`：`amount must be between 1 and 100`
- `500`：`generating password: <原因>`

#### 示例

```bash
# 旧用法原样可用
curl 'http://nas:3000/v1/getPassword?length=10&special=true'

# 核心痛点解决：只用某系统允许的特殊字符 !@#$%（注意 URL 编码）
curl 'http://nas:3000/v1/getPassword?length=16&special_chars=%21%40%23%24%25'

# 批量 + JSON
curl 'http://nas:3000/v1/getPassword?length=24&format=json&amount=5'

# 纯数字 PIN（关闭大小写）
curl 'http://nas:3000/v1/getPassword?length=6&lowercase=false&uppercase=false'

# 短语密码
curl 'http://nas:3000/v1/getPassword?xkcd=true&length=4&separator=-&date=false'
```

### `GET /v1/healthz`

返回 200 空响应体（与旧版一致），可用于容器健康检查。

## 群晖 Synology 部署

前提：先把本仓库推送到 GitHub（见下文），并等待 GitHub Actions 构建完成（仓库 Actions 页出现绿色勾）。

### 方式 A：Docker Hub（可以在注册表里直接搜索）

1. 在 [hub.docker.com](https://hub.docker.com) 注册一个账号（例如 `akikazehub`）。
2. Docker Hub → 右上角头像 → **Account Settings** → **Personal access tokens** → **Generate new token**（权限 Read & Write），复制 token。
3. GitHub 仓库 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，添加两个：
   - `DOCKERHUB_USERNAME` = 你的 Docker Hub 用户名
   - `DOCKERHUB_TOKEN` = 刚才的 token
4. 回到仓库 **Actions** 页 → 选 "Build and publish Docker image" → **Run workflow**（或随便推一个 commit）。
5. 群晖 **套件中心** → 安装 **Container Manager**（DSM 7.2+；老版本叫 Docker 套件，操作类似）。
6. 打开 **Container Manager** → **注册表** → 搜索你的镜像名（`aki-password-gen`，或 `<你的DockerHub用户名>/aki-password-gen`）→ **下载**，选 `latest`。
7. **映像** 里选中它 → **运行** → 端口设置：本地端口 `3000` → 容器端口 `3000` → 下一步 → 完成。
8. 浏览器访问 `http://NAS的IP:3000` 即可。

### 方式 B：ghcr.io（不需要 Docker Hub 账号）

1. GitHub → 右上角头像 → **Your packages** → 找到 `aki-password-gen` → **Package settings** → **Change visibility** → **Public**（首次构建的包默认私有，群晖匿名拉取需要改成公开）。
2. 群晖 **Container Manager** → **映像** → **新增** → **从 URL 添加** → 输入：
   ```
   ghcr.io/akikazehub/aki-password-gen:latest
   ```
3. 选中下载好的映像 → **运行** → 端口映射本地 `3000` → 容器 `3000` → 完成。

> 群晖的"注册表搜索"只支持 Docker Hub，所以 ghcr 的镜像只能用 URL 方式添加，但使用上没有任何区别。

### 方式 C：用 docker compose（项目）

**Container Manager** → **项目** → **新增** → 填个名字 → 创建 `docker-compose.yml` 中粘贴本仓库的
`docker-compose.yml` 内容 → 下一步 → 完成。适合想固定配置、随 DSM 开机自启的场景。

### 从旧版 luzifer-password-gen 迁移

1. 停止并删除旧容器（Container Manager → 容器 → 旧容器 → 停止 → 删除），释放 3000 端口。
2. 按上面任一方式启动新容器，使用同样的端口。
3. 所有旧 URL（`/v1/getPassword?length=10&special=true`、`/v1/healthz`）无需任何修改。
4. 想要旧版没有的自定义符号，加 `special_chars` 参数即可，或直接用网页界面。

## GitHub Actions 自动构建

推送到 `main`（或打 `v*` 标签）时，工作流会：

1. 跑完整测试套件（`npm test`）
2. 构建 `linux/amd64` + `linux/arm64` 双架构镜像（覆盖绝大多数群晖机型）
3. 推送到 `ghcr.io/akikazehub/aki-password-gen`；若配置了 Docker Hub secrets（见方式 A 第 3 步），同时推送 Docker Hub

## 本地开发

```bash
node server.js        # 默认 3000 端口，PORT 环境变量可改
npm test              # 运行全部测试
```

代码结构：

```
lib/generator.mjs     # 核心生成逻辑（服务端与浏览器共用同一份）
lib/xkcd-words.mjs    # XKCD 短语词表（取自旧版项目）
server.js             # 零依赖 HTTP 服务（静态文件 + API）
public/               # 纯 HTML/CSS/JS 前端
test/                 # 单元测试 + API 兼容性测试
```

## 安全说明

- 生成使用密码学安全随机源（Web Crypto `getRandomValues`，取模偏差已消除）
- 服务端不记录任何请求参数或响应内容；密码不出内存
- 网页端生成完全在浏览器本地完成，不发起任何网络请求
- 容器以非 root 用户运行，镜像零第三方依赖，攻击面极小

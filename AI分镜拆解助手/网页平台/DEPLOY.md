# 部署上线说明

## 当前应用形态

这是一个带 Python 后端的 Web 应用，不是纯静态页面。

- 前端：`index.html`、`styles.css`、`app.js`
- 后端：`server.py`
- 数据库：本地 SQLite，默认路径为 `.data/app.db`
- 用户模型 Key：用户登录后自行配置，服务端加密保存

当前仓库的 `render.yaml` 是免费体验版配置，没有绑定 Render 持久化磁盘。这样可以先部署打开，但 Render 重启或重新部署后，用户账号、项目看板和 API 配置可能会丢失。正式给多人长期使用时，建议改用 PostgreSQL，或在 Render 里增加持久化磁盘并把 `APP_DATA_DIR` 指向磁盘目录。

## 推荐部署方式

优先使用支持 Docker 或 Python 后端的平台，例如：

- Render Web Service
- Railway
- Fly.io
- 自有云服务器

不要直接部署到只支持静态网页的平台，否则登录、项目保存、剧本分析接口都会失效。

## 必填环境变量

生产环境必须配置：

```bash
APP_ENV=production
APP_SECRET=请使用强随机字符串
APP_DATA_DIR=/data
COOKIE_SECURE=true
SESSION_MAX_AGE_SECONDS=1209600
PORT=5176
```

注意：不要在环境变量里配置某个用户的模型 API Key。每个用户登录后在页面里配置自己的 Key。

## Docker 本地验证

```bash
docker build -t ai-storyboard-assistant .
docker run --rm -p 5176:5176 \
  -e APP_SECRET="local-test-secret-change-me" \
  -e COOKIE_SECURE=false \
  -v "$(pwd)/.data:/data" \
  ai-storyboard-assistant
```

然后打开：

```text
http://127.0.0.1:5176/
```

## Render 部署参考

仓库根目录已经提供 `render.yaml`，可以作为 Render Blueprint 使用。

1. 新建 Web Service。
2. 连接 GitHub 仓库。
3. 选择 Docker 部署，或直接使用仓库里的 Blueprint。
4. 设置 `APP_SECRET` 环境变量。
5. 免费体验版无需配置持久化磁盘。
6. 部署完成后访问平台给出的 URL。

如需正式长期保存数据，再新增以下能力之一：

- Render 持久化磁盘：挂载到 `/data`，并保持 `APP_DATA_DIR=/data`。
- 托管数据库：迁移 SQLite 到 PostgreSQL 或 MySQL。

## 上线前检查

- `.env` 不要提交。
- `.data/` 不要提交。
- `APP_SECRET` 必须是生产环境专用强随机值。
- 生产环境必须开启 HTTPS。
- 用户 API Key 只允许用户自己在页面配置。
- 如果多人正式使用，建议把 SQLite 迁移到 PostgreSQL 或 MySQL。

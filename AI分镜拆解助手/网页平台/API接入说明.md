# API 接入说明

## 当前已完成

- 新增本地后端：`server.py`
- 新增剧本分析接口：`POST /api/script/analyze`
- 新增拆分镜接口：`POST /api/storyboard/split`
- 新增健康检查接口：`GET /api/health`
- 新增配置接口：`GET /api/config`、`POST /api/config`
- 新增剧本分析 Prompt：`prompts/script_analysis.md`
- 新增拆分镜 Prompt：`prompts/storyboard_split.md`
- 前端点击“下一步：剧本分析”时，会优先请求后端接口。
- 前端点击“确认分析并拆解分镜”时，会继续请求后端拆分镜接口。
- 未配置真实模型时，后端会返回本地演示分镜，避免页面不可用。
- 首页右上角“API 接入”现在可以读取和保存本地后端配置，但不会把已保存的 API Key 明文回显到页面。

## API Key 放在哪里

不要把真实 API Key 写进 `index.html`、`app.js` 或公共 `.env`。

当前版本已改为 BYOK：每个用户注册/登录后，在首页右上角点击“API 接入”，填写并保存自己的配置。

保存后的 Key 会加密后写入本地 SQLite 数据库 `网页平台/.data/app.db`，不会写入前端代码，也不会使用其他用户的 Key。

注意：SQLite 适合当前本地 MVP 和面试演示。正式多人上线时，应迁移到托管数据库，并使用云厂商 KMS 或成熟密钥管理服务保存用户 Key。

## 启动方式

双击上一级目录中的：

```text
打开本地网页.command
```

或者在终端进入当前目录后运行：

```bash
python3 server.py --host 127.0.0.1 --port 5176
```

然后打开：

```text
http://127.0.0.1:5176/
```

## 当前边界

- 剧本分析和拆分镜共用当前登录用户配置的文本模型。
- 如果真实模型调用失败，会自动回到本地演示模式，并在页面提示。
- “生成分镜图”暂时仍是前端 SVG 草图模拟，没有接图片生成模型。

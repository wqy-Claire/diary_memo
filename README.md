# diary_mvp（网页手帐）

一个零依赖的本地网页手帐：前端静态页 + 本地加密存储（WebCrypto）+ 可选 DeepSeek 代理接口（`/api/chat`）。

## 本地运行（固定网址，数据互通）

默认固定端口 **5179**（端口不同会导致 `localStorage` 不互通）。

```bash
cd "/Users/wqy/Desktop/注采数据/01/diary_mvp"

# 可选：启用 DeepSeek（不要把 key 写进代码/前端）
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"

python server.py
```

浏览器打开终端打印的地址（默认是 `http://127.0.0.1:5179`）。

如果提示端口被占用：

```bash
lsof -iTCP:5179 -sTCP:LISTEN
kill <PID>
```

（不建议频繁换端口，否则“记录/总结”数据会分裂成多份。）

## DeepSeek 报错说明

- **HTTP 402 Payment Required**：账号需要充值/有可用额度才可调用。
- **HTTP 401 Unauthorized**：API Key 无效或已作废（建议重新生成新 key）。

## 切换到别的 AI（例如腾讯混元）

这个项目的 `/api/chat` 现在支持按环境变量切换提供商。

### 继续用 DeepSeek

```bash
export AI_PROVIDER="deepseek"
export DEEPSEEK_API_KEY="sk-xxxxxxxxxxxxxxxx"
python server.py
```

### 改用腾讯混元

```bash
export AI_PROVIDER="hunyuan"
export HUNYUAN_API_KEY="你的混元 API Key"
export HUNYUAN_MODEL="hunyuan-lite"
python server.py
```

腾讯混元目前提供 OpenAI 兼容接口，可用 `https://api.hunyuan.cloud.tencent.com/v1/chat/completions` 这类接口形式接入，适合直接复用本项目当前代理结构。[腾讯云官方说明](https://cloud.tencent.cn/document/product/1729/111007)

关于费用，腾讯混元目前官方文档显示新开通常有一定免费额度，且 `hunyuan-lite` 可免费使用；具体额度和计费以腾讯云当前页面为准。[腾讯云计费说明](https://www.tencentcloud.com/zh/document/product/1284/77186)

## 让别人也能用（公网部署）

### Render 一键部署（推荐）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/wqy-Claire/diary_memo)

点击按钮后：

1. 选择你的 Render 账号并确认创建服务（配置来自仓库中的 `render.yaml`）。
2. 在环境变量里填写 `DEEPSEEK_API_KEY=sk-...`（不写就只能离线回复）。
3. 等待部署完成，拿到 `https://xxx.onrender.com` 公网网址。

要让别人通过一个公网网址访问，并且能用 DeepSeek，需要把 `server.py` 部署到云端，并在平台配置环境变量：

- `DEEPSEEK_API_KEY`: 你的 DeepSeek key（只放在云端后台，不要放前端）
- 平台通常会自动注入 `PORT`，本项目会自动使用该端口并监听 `0.0.0.0`

推荐流程：

1. 先把本仓库推到你自己的 GitHub。
2. 在部署平台新建 Web Service，连接该 GitHub 仓库。
3. 启动命令设置为：`python server.py`
4. 在平台环境变量里新增：`DEEPSEEK_API_KEY`

如果你不想让公网用户消耗你的 DeepSeek 额度，可以在公网部署时不设置 `DEEPSEEK_API_KEY`（总结页会显示未连通，并回退离线参考）。

## 安全

- 不要把 `DEEPSEEK_API_KEY` 提交到 GitHub。
- 如果你曾经在聊天/截图里泄露过 key，请立刻在平台作废并重新生成。


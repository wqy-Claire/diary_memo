"""
server.py

本地开发用：静态文件 + AI 代理接口（/api/chat）

为什么要用本地代理？
- 不把模型 API Key 暴露在前端（否则任何人打开网页都能看到 key）
- 前端只调用同源 /api/chat

用法：
  cd diary_mvp
  export DEEPSEEK_API_KEY="sk-xxxx"
  python server.py

然后浏览器打开终端里打印的地址（默认 5179；若端口被占用会自动换 5180、5181…）

端口被占用时也可手动指定：
  DIARY_PORT=5180 python server.py
"""

from __future__ import annotations

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


if os.environ.get("PORT", "").strip():
    # 云平台（Render/Fly/Heroku 风格）通常会注入 PORT
    PORT = int(os.environ["PORT"])
else:
    PORT = int(os.environ.get("DIARY_PORT", "5179"))

HOST = os.environ.get("DIARY_HOST", "").strip()
if not HOST:
    HOST = "0.0.0.0" if os.environ.get("PORT", "").strip() else "127.0.0.1"
AUTO_FALLBACK = os.environ.get("DIARY_AUTO_FALLBACK", "0").strip() in ("1", "true", "True")
MAX_PORT_TRIES = 20


def _provider_info() -> tuple[str, str, str, str]:
    provider = os.environ.get("AI_PROVIDER", "deepseek").strip().lower() or "deepseek"
    if provider == "hunyuan":
        name = "腾讯混元"
        api_key = (os.environ.get("HUNYUAN_API_KEY") or os.environ.get("AI_API_KEY") or "").strip()
        base_url = (os.environ.get("HUNYUAN_BASE_URL") or os.environ.get("AI_BASE_URL") or "https://api.hunyuan.cloud.tencent.com/v1").strip()
        model = (os.environ.get("HUNYUAN_MODEL") or os.environ.get("AI_MODEL") or "hunyuan-lite").strip()
    else:
        provider = "deepseek"
        name = "DeepSeek"
        api_key = (os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("AI_API_KEY") or "").strip()
        base_url = (os.environ.get("DEEPSEEK_BASE_URL") or os.environ.get("AI_BASE_URL") or "https://api.deepseek.com").strip()
        model = (os.environ.get("DEEPSEEK_MODEL") or os.environ.get("AI_MODEL") or "deepseek-chat").strip()
    return provider, name, api_key, base_url.rstrip("/"), model


def _read_json(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def _send_json(handler: SimpleHTTPRequestHandler, obj: dict, status: int = 200) -> None:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _ai_chat(provider_name: str, api_key: str, base_url: str, model: str, payload: dict) -> str:
    persona = str(payload.get("persona") or "mom")
    user_text = str(payload.get("userText") or "").strip()
    messages = payload.get("messages") or []
    summary = payload.get("summary") or {}
    model_override = str(payload.get("model") or "").strip()
    model_name = model_override or model

    kw = summary.get("keywords") or []
    qs = summary.get("questions") or []

    custom_sys = str(payload.get("systemPrompt") or "").strip()
    if custom_sys:
        sys = custom_sys
    else:
        if persona == "mom":
            sys = (
                "你是一个温柔、可靠、会安抚情绪但不溺爱的妈妈。"
                "你的目标是帮用户把问题变成可执行的下一步，并给出清晰建议。"
            )
        elif persona == "friend":
            sys = (
                "你是一个真诚的朋友，语气轻松但有边界。"
                "你会用二选一、共情、以及小行动建议帮助用户前进。"
            )
        else:
            sys = (
                "你是一个高效的教练，重视结构化拆解。"
                "你会要求用户澄清目标/约束，并给出三步计划。"
            )

        sys += f"\n（背景信息：用户近30天关键词：{kw}；关键问题片段：{qs}）"

    ds_messages = [{"role": "system", "content": sys}]
    # 将前端记忆转成通用 chat messages
    for m in messages:
        role = m.get("role")
        content = str(m.get("content") or "")
        if role == "user":
            ds_messages.append({"role": "user", "content": content})
        elif role == "assistant":
            ds_messages.append({"role": "assistant", "content": content})

    ds_messages.append({"role": "user", "content": user_text})

    req_body = {
        "model": model_name,
        "messages": ds_messages,
        "temperature": 0.7,
        "max_tokens": 800,
        "stream": False,
    }

    req = Request(
        f"{base_url}/chat/completions",
        data=json.dumps(req_body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    try:
        with urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        msg = raw.strip() or str(e)
        try:
            err_j = json.loads(raw)
            err_obj = err_j.get("error")
            if isinstance(err_obj, dict):
                msg = str(err_obj.get("message") or err_obj.get("type") or raw).strip()
            elif isinstance(err_obj, str):
                msg = err_obj.strip()
        except Exception:
            pass
        err_line = f"{provider_name} HTTP {e.code}: {msg}"
        if provider_name == "DeepSeek" and e.code == 402:
            err_line += " | 需在开放平台充值或检查可用额度：https://platform.deepseek.com"
        elif e.code == 401:
            err_line += " | 请检查 API Key 是否正确、是否已重新生成"
        raise RuntimeError(err_line) from e
    except URLError as e:
        raise RuntimeError(f"无法连接{provider_name}：{e.reason!s}") from e

    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        if self.path == "/api/chat":
            _provider, provider_name, api_key, base_url, model = _provider_info()
            if not api_key:
                return _send_json(self, {"error": f"missing API key for {provider_name}"}, status=400)
            payload = _read_json(self)
            try:
                text = _ai_chat(provider_name, api_key, base_url, model, payload).strip()
                return _send_json(self, {"text": text})
            except Exception as e:
                print(f"[api/chat] {type(e).__name__}: {e}", file=sys.stderr)
                return _send_json(self, {"error": str(e)}, status=500)

        return _send_json(self, {"error": "not found"}, status=404)


def main() -> None:
    if AUTO_FALLBACK:
        server = None
        last_err: OSError | None = None
        for offset in range(MAX_PORT_TRIES):
            port = PORT + offset
            try:
                server = ThreadingHTTPServer((HOST, port), Handler)
                break
            except OSError as e:
                last_err = e
                continue
        if server is None:
            raise RuntimeError(
                f"无法在 {PORT}～{PORT + MAX_PORT_TRIES - 1} 上启动服务（端口均被占用）。"
                f"请关掉占用端口的进程，或设置 DIARY_PORT。原始错误: {last_err}"
            ) from last_err
        if port != PORT:
            print(f"注意: 端口 {PORT} 已被占用，已改用 {port}。")
    else:
        port = PORT
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
        except OSError as e:
            raise RuntimeError(
                f"端口 {port} 已被占用。为保证本地数据和网址固定，本次不自动换端口。"
                "请先结束占用进程后重启；或临时设置 DIARY_PORT=新端口。"
            ) from e
    _provider, provider_name, key, _base_url, model = _provider_info()
    if not key:
        print(f"警告: 未设置 {provider_name} 的 API Key，/api/chat 将返回 400。", file=sys.stderr)
    elif key in ("sk-你的真实密钥", "sk-xxxx", "你的deepseek_key"):
        print(f"警告: {provider_name} API Key 像是占位符，请换成平台里的真实密钥。", file=sys.stderr)
    shown_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    print(f"Serving on http://{shown_host}:{port}")
    print("请用上面这个地址打开网页（不要用旧端口，否则 /api/chat 会连错）。")
    print(f"API: POST /api/chat (provider={provider_name}, model={model})")
    server.serve_forever()


if __name__ == "__main__":
    main()


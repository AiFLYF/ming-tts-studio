# Ming TTS Studio · HTTP API 参考

这套接口由 `server/gateway.py` 与 `server/worker.py` 实现，也是前端唯一依赖的契约。任何实现了这些端点的服务都能被界面直接接管——换成你自己的推理后端，只要接口对得上。

- **网关**：`http://<host>:8081`，面向浏览器，做调度与同源托管
- **worker**：`:8091` 起，每张卡一个，直接吃 JSON 出 WAV。由 `./start.sh` 拉起时固定绑 `127.0.0.1`（只给网关用，不对外），手动跑 `worker.py` 才会用 `HOST` 环境变量（默认 `0.0.0.0`）
- 两者接口基本一致；差异只在 §2.1 的 `/health` 与 §2.2 的 `/cluster/status`

> 没有鉴权。网关默认监听 `0.0.0.0`，公网暴露前请套反向代理并加认证，见 [README · 安全与网络暴露](../README.md#安全与网络暴露)。

---

## 1. 通用约定

| 项目 | 取值 |
| --- | --- |
| 编码 | UTF-8，请求体 `Content-Type: application/json`（上传为 `multipart/form-data`） |
| 鉴权 | 默认无；设置 `STUDIO_PASSWORD` 后需登录 Cookie 或 HTTP Basic（用户名任意） |
| CORS | `Access-Control-Allow-Origin: *`，暴露 `X-Duration`、`X-Sample-Rate`、`X-Task` |
| Private Network Access | 预检请求带 `Access-Control-Request-Private-Network: true` 时回 `Access-Control-Allow-Private-Network: true` |
| 请求体上限 | 网关 55 MB，`/upload` 单文件 50 MB |
| 音频格式 | `.wav` / `.mp3` / `.flac` |
| 错误格式 | `{"detail": "人话描述"}` |
| 生成超时 | 前端 300 秒；网关对上游不设读超时 |

### 从 HTTPS 页面连 http:// 网关

浏览器默认禁止 HTTPS 页面请求 `http://` 地址（混合内容）。有两条路：

1. **打开网关自带的页面** `http://<网关IP>:8081/studio/` —— 同源，不用任何设置，推荐；
2. **继续用 Pages / HTTPS 页面**：点地址栏左侧图标 → 网站设置 → 把「不安全内容」设为「允许」→ 刷新。之后 `http://` 地址可以直连（服务端已回 PNA 头）。

局域网 IP 还受 Chrome Private Network Access 约束，服务端不回 `Access-Control-Allow-Private-Network` 就仍会被拦——本项目已处理。

### 访问密码

在 `.env` 中设置 `STUDIO_PASSWORD` 并重启网关后，密码保护才会启用；留空则保持完全开放。

- **浏览器**：访问受保护页面会 307 到 `/login?next=...`，输入密码后写入 HttpOnly 会话 Cookie（默认 24 小时）；`GET /logout` 退出。
- **脚本**：使用 HTTP Basic，密码正确即可，用户名任意：`curl -u studio:你的密码 http://127.0.0.1:8081/cluster/status`。
- **未认证响应**：页面导航返回 307 登录页，API 请求返回 `401 {"detail": "需要密码访问，请先登录 / password required"}`。
- **公开端点**：只有 `/health`、`/login`、`/logout`、`/favicon.ico` 不要求密码；`/studio/*`、`/uploads/*`、`/generate`、`/docs` 等其余路径全部受保护（OPTIONS 预检也放行）。
- **跨域页面拿到 401**：登录态是 HttpOnly Cookie，GitHub Pages 这类跨域前端无法共享。开启密码后请改用网关自带的 `http://<网关IP>:8081/studio/`，或用 Basic 头直接调 API。

### 状态码

| 码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数不合法（字段缺失、取值不在白名单、参考音频路径不在 `uploads/` 内） |
| 401 | 已开启访问密码但请求未认证 |
| 404 | 文件或路由不存在 |
| 413 | 请求体/文件过大 |
| 429 / 503 | 没有可用 worker，或模型仍在加载 |
| 502 | 网关转发上游失败 |
| 500 | 推理异常（细节只进服务端日志，不回显） |

---

## 2. 端点

### 2.1 `GET /health`

**网关**（可用性以 worker 数目为准）：

```json
{
  "status": "healthy",
  "model_loaded": true,
  "workers_available": 4,
  "workers_total": 4,
  "requests_in_flight": 0
}
```

`status` 取值 `healthy` / `degraded` / `offline`。没有可用 worker 时返回 **503**，`status` 为 `offline`。

**worker**（单卡自检）：`{"status": "healthy", "model_loaded": true}`

> 前端据此判定是否已连接：出现 `model_loaded` / `workers_available` / `workers_total` / `requests_in_flight` 任一字段即认；只有 `status` 时，值必须是上面这几个之一。所以直连 worker 端口也能被识别。

### 2.2 `GET /cluster/status`

仅网关。给出每张卡的端口、在途数、累计请求与最近错误：

```json
{
  "gateway": "ok",
  "mode": "least-in-flight",
  "uptime_seconds": 20.7,
  "workers_total": 4,
  "workers_available": 4,
  "requests_in_flight": 0,
  "workers": [
    {"index": 0, "gpu": 0, "port": 8091, "status": "up", "health": "ready",
     "active": 0, "requests": 0, "failures": 0, "last_error": ""}
  ]
}
```

### 2.3 `GET /tasks`

worker 暴露的任务名与条件方式，方便客户端自检：

```json
{"tasks": {"seed": "prompt_latent", "podcast": "multi_speaker", "basic": "speaker_only"}}
```

### 2.4 `POST /upload`

上传参考音频。

```bash
curl -F "file=@reference.wav" http://127.0.0.1:8081/upload
```

```json
{
  "filename": "a1b2c3d4e5_reference.wav",
  "url": "/uploads/a1b2c3d4e5_reference.wav",
  "path": "/uploads/a1b2c3d4e5_reference.wav",
  "size": 1072592,
  "size_kb": 1047.5,
  "uploaded_at": "2026-10-23T10:54:49",
  "original_name": "reference.wav",
  "duration": 6.08,
  "sample_rate": 44100,
  "channels": 1,
  "message": "文件 'reference.wav' 上传成功"
}
```

`path` 与 `url` 同值，都是 `/uploads/<文件名>`；把它直接作为 `prompt_wav` 传给 `/generate` 即可。服务端只接受落在上传目录内的文件。

### 2.5 `GET /uploads`

列出已上传文件，按时间倒序：`{"count": 3, "files": [ …同 §2.4 的字段… ]}`

### 2.6 `GET /uploads/{filename}`

直接取回音频（浏览器试听用），`Content-Type` 为 `audio/*`，支持 Range。

### 2.7 `DELETE /uploads/{filename}`

成功：`{"message": "文件 'xxx.wav' 已删除"}`。文件名不得含路径分隔符，也不能是 `.` / `..` / 点开头。

### 2.8 `POST /generate`

一次请求 = 一个任务。**不同任务的控件不能混用**，混用会得到 400。

```bash
curl -X POST http://127.0.0.1:8081/generate \
  -H "Content-Type: application/json" \
  -d '{"task":"seed","text":"傍晚的风从山口吹过来。","prompt_wav":"/uploads/a1b2c3d4e5_reference.wav","prompt_text":"诶，你今天有空吗？","target_language":"Chinese"}' \
  -D /tmp/headers.txt -o /tmp/speech.wav
```

成功返回 `audio/wav` 二进制，并带三个头：

| 响应头 | 示例 | 说明 |
| --- | --- | --- |
| `X-Duration` | `6.08` | 秒 |
| `X-Sample-Rate` | `44100` | Hz |
| `X-Task` | `seed` | 实际执行的任务 id |

#### 任务与字段

| 任务 | `task` | 参考音频 | 参考文本 | 其他字段 |
| --- | --- | --- | --- | --- |
| 语音克隆 | `seed` | 1 个 | 必需 | `target_language`: `Chinese` / `English` |
| 多语言合成 | `multilingual` | 1 个 | 必需 | `target_language`: 其余五种 |
| 副语言标签 | `paralinguistic` | 1 个 | 必需 | `target_language`: `Chinese` / `English`，正文内联标签 |
| 多人对话 | `podcast` | 每人 1 个 | 每人 1 个，顺序对应 | 正文每行 `speaker_N:` |
| 基础属性 | `basic` | 1 个 | 不接受 | `speed`、`pitch`、`volume` |
| 情感控制 | `emotion` | 1 个 | 不接受 | `emotion` |
| 方言控制 | `dialect` | 1 个 | 不接受 | `dialect` |
| 自由描述 | `freeform` | 可选（官方默认不传） | 不接受 | `instruction` |
| 声音设计 | `voice_design` | 无 | — | `style` |
| 内置声音 | `ip` | 无 | — | `ip` |

#### 取值与别名

服务端会归一化，下面几种写法都收：

| 字段 | 规范值 | 别名 |
| --- | --- | --- |
| `target_language` | `Chinese` `English` `Japanese` `Korean` `German` `French` `Spanish` | `zh` `en` `ja` `jp` `ko` `de` `fr` `es`，以及中文名（`中文`/`日语`…） |
| `dialect` | `川渝话` `广粤话` | `cantonese` `canton` `粤语` `广州话` `sichuan` `sichuanese` `chuanyu` `chuanyu dialect` `四川话` `重庆话` |
| `emotion` | `中性` `悲伤` `愤怒` `高兴` `惊讶` `恐惧` `厌恶` | `happy` `sad` `angry` `neutral` `surprised` `surprise` `fearful` `fear` `disgusted` `disgust` |
| `speed` | `慢速` `中速` `快速` | — |
| `pitch` / `volume` | `低` `中` `高` | — |
| `ip` | 见 [音色表](../README.md#功能特性)；带情绪变体的必须传全名，如 `灵信远_高兴` | — |

#### 14 个内联标签（`paralinguistic`）

`[Breathing]` `[Cough]` `[Sigh]` `[Laughter]` `[Uhm]` `[Surprise-ah]` `[Surprise-oh]` `[Dissatisfaction-hnn]` `[Confirmation-en]` `[Question-ei]` `[Question-ah]` `[Question-en]` `[Question-oh]` `[Question-huh]`

区分大小写、必须带方括号，可以直接写在句子任意位置。

#### 参考音频片段（`prompt_start` / `prompt_end`）

默认使用整段参考音频；传入起点和终点（秒，浮点数）即可只取其中一段，适合从长录音里挑出干净人声。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt_start` | number 或 number[] | 片段起点，≥ 0，缺省为 0 |
| `prompt_end` | number 或 number[] | 片段终点，≤ 音频时长，缺省为整段 |

- 片段长度必须在 0.5–30 秒之间，建议 3–15 秒；越界返回 400。
- `podcast` 可传与 `prompt_wav` 等长的数组，顺序对应；也可以传标量，作用于每一位说话人。
- 服务端从上传目录读取原文件，裁剪结果写入临时文件，生成结束后自动删除，不会改动原音频。

```json
{
  "task": "seed",
  "text": "只使用参考音频的第 2.0 到 8.0 秒。",
  "prompt_wav": "/uploads/a1b2c3d4e5_reference.wav",
  "prompt_text": "参考音频里实际说出的文本",
  "target_language": "Chinese",
  "prompt_start": 2.0,
  "prompt_end": 8.0
}
```

#### 播客脚本

```json
{
  "task": "podcast",
  "text": "speaker_1: 你最近是不是又去那家面馆了？\nspeaker_2: 对啊，排了半小时队，不过真的值得。",
  "prompt_wav": ["/uploads/a.wav", "/uploads/b.wav"],
  "prompt_text": ["诶，你今天有空吗？", "感谢你的认可。"]
}
```

两个数组长度必须一致、顺序对应；脚本里的 `speaker_N` 要覆盖 `1..N`，且不超出提供的参考音频数量。语言由正文推断，不接受 `target_language`。

### 2.9 `GET /docs` 与 `/studio/*`

- `/docs`：FastAPI 自带的 OpenAPI 交互文档（网关与 worker 都有）。
- `/studio/`、`/studio/index.html`、`/studio/sw.js`、`/studio/site.webmanifest`、`/studio/assets/*`：网关同源托管的界面。**除这些显式路由外的路径都会被转发给 worker**，所以新增静态文件时要同时加路由。

---

## 3. 客户端示例

```js
// 浏览器：直连网关
const base = "http://127.0.0.1:8081";
const health = await fetch(`${base}/health`).then(r => r.json());

const wav = await fetch(`${base}/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    task: "multilingual",
    text: "週末、駅前の小さな喫茶店で抹茶パフェを食べました",
    prompt_wav: "/uploads/a1b2c3d4e5_reference.wav",
    prompt_text: "参考音频里说出的日语文本",
    target_language: "ja"
  })
});
const blob = await wav.blob();
console.log(wav.headers.get("X-Duration"), wav.headers.get("X-Task"));
```

```python
import requests

BASE = "http://127.0.0.1:8081"

with open("reference.wav", "rb") as fh:
    upload = requests.post(f"{BASE}/upload", files={"file": fh}).json()

resp = requests.post(f"{BASE}/generate", json={
    "task": "seed",
    "text": "傍晚的风从山口吹过来。",
    "prompt_wav": upload["path"],
    "prompt_text": "诶，你今天有空吗？",
    "target_language": "Chinese",
}, timeout=300)
resp.raise_for_status()
open("out.wav", "wb").write(resp.content)
```

---

## 4. 界面是怎么用这套接口的

- 默认 API 地址 = 页面源（同源部署时自动可用），可用 `assets/js/config.js` 的 `apiBase` 固定；
- 也可用深链覆盖：`?api=http://192.168.1.20:8081`；
- 弹窗里保存的地址写进 `localStorage`，键为 `ming-tts-studio:api-base`；
- 每 20 秒轮询一次 `/health`，连续失败才降级为演示模式；生成过程中不因单次失败切换。

> 换后端时只要保证 `/health` 能被 `looksLikeMingHealth` 认出（§2.1 的字段），其余端点语义一致即可。

---

## 5. 已知限制

- 单 worker 内推理串行（模型不可重入），并发会在 worker 内排队；要吞吐就加卡，网关按最少在途请求分摊。
- 不带 `Content-Length` 的请求体按 55 MB 上限截断，超出直接 413。
- 网关无鉴权、无速率限制，默认绑 `0.0.0.0`。
- 克隆真实人物声音需取得授权；合成内容在可能被误认为真实录音的场景应明确标注。

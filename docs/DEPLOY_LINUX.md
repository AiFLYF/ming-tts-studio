# Linux 部署教程

本教程面向 Ubuntu 22.04 / 24.04（其他发行版同理），从零部署 Ming TTS Studio 的完整前后端。全部命令在项目根目录执行。

## 1. 环境要求

| 项目 | 要求 |
| --- | --- |
| GPU | NVIDIA，单卡显存 ≥ 24 GB（RTX 3090 / 4090 / A10 / L20 / H20 等） |
| 驱动 | NVIDIA 驱动 ≥ 525，支持 CUDA 11.8 |
| 系统内存 | ≥ 32 GB 建议 |
| 磁盘 | 系统与依赖约 10 GB，模型约 17 GB，合计预留 ≥ 30 GB |
| Python | **3.10.x**（固定版本，其他版本依赖不保证可用） |
| 网络 | 首次启动需下载约 17 GB 模型 |

多卡机器会自动为每张卡启动一个 worker，由网关按「最少在途请求」调度。4 张 3090 即可获得约 4 倍并发吞吐。

检查驱动：

```bash
nvidia-smi
```

### 安装 Python 3.10

Ubuntu 22.04 自带 3.10，直接安装 venv 支持：

```bash
sudo apt update
sudo apt install -y python3.10 python3.10-venv python3-pip git curl
```

Ubuntu 24.04 默认是 3.12，需要额外安装 3.10：

```bash
sudo add-apt-repository ppa:deadsnakes/ppa -y
sudo apt update
sudo apt install -y python3.10 python3.10-venv python3.10-dev
```

确认版本：

```bash
python3.10 -V   # Python 3.10.x
```

> 不需要单独安装 CUDA Toolkit。PyTorch 使用 `cu118` wheel，自带运行时；只要驱动满足要求即可。

## 2. 获取项目

```bash
git clone <你的仓库地址> ming-tts-studio
cd ming-tts-studio
```

没有使用 Git 时，解压 zip 后进入目录即可。zip 不保留可执行位，先补一次：

```bash
chmod +x scripts/setup_linux.sh start.sh stop.sh status.sh
```

## 3. 一键安装依赖

```bash
./scripts/setup_linux.sh
```

脚本会：

1. 查找 Python 3.10 并创建 `.venv`；
2. 安装 `server/requirements-server.txt`（torch 2.7.1+cu118、transformers 4.46.3、FastAPI 等）；
3. 安装魔搭下载器（可用 `SKIP_MODELSCOPE=1 ./scripts/setup_linux.sh` 跳过）；
4. 检查 `nvidia-smi` 并打印下一步命令。

依赖较大，首次安装通常需要 5–20 分钟。国内网络可先设置镜像：

```bash
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
./scripts/setup_linux.sh
```

## 4. 配置模型来源

复制配置模板（可选）：

```bash
cp .env.example .env
```

常用配置：

```dotenv
MODEL_SOURCE=auto            # auto / modelscope / huggingface
MODEL_ID=inclusionAI/Ming-3.0-tts-tiny
MODEL_PATH=./models/Ming-3.0-tts-tiny
GATEWAY_PORT=8081
# GPUS=0,1,2,3               # 留空使用全部 GPU
MIN_FREE_VRAM_MB=19000
```

各来源的行为：

| `MODEL_SOURCE` | 行为 |
| --- | --- |
| `auto`（默认） | 已安装魔搭时优先魔搭，失败自动切到 Hugging Face |
| `modelscope` | 只使用魔搭，失败直接报错（不会偷偷切换） |
| `huggingface` | 只使用 Hugging Face |

### 方式 A：魔搭 ModelScope（国内推荐）

```bash
./start.sh --source modelscope
```

首次启动会调用 `modelscope.snapshot_download` 下载到 `models/Ming-3.0-tts-tiny`。也可以提前单独下载：

```bash
.venv/bin/python server/download_model.py --source modelscope
```

### 方式 B：Hugging Face

```bash
./start.sh --source huggingface
```

大陆网络可启用镜像：

```bash
export HF_ENDPOINT=https://hf-mirror.com
./start.sh --source huggingface
```

私有仓库或限流场景可设置 token：

```bash
export HF_TOKEN=hf_xxx
```

### 方式 C：手动放置模型

已有模型权重时，把目录放到任意位置即可。加载时会校验 5 类文件，缺一个都会报 `incomplete Ming-3.0-tts-tiny bundle`：`config.json`、`model.safetensors.index.json`、`tokenizer.json`、`tokenizer_config.json`、`campplus.onnx`，外加 index 里列出的全部分片 `*.safetensors`。

```bash
./start.sh --model-path /data/models/Ming-3.0-tts-tiny
```

或写入 `.env` 的 `MODEL_PATH`。启动器检测到模型完整后会跳过下载。

检查模型是否完整：

```bash
.venv/bin/python server/download_model.py --check --output ./models/Ming-3.0-tts-tiny
```

## 5. 一键启动

```bash
./start.sh
```

启动流程：

1. 检查 Python 3.10 与依赖；
2. 缺失模型时按 `MODEL_SOURCE` 下载；
3. 查询 `nvidia-smi`，为每张可用 GPU 启动一个 worker（端口 8091 起）；
4. 等待每个 worker 的 `/health` 返回 `model_loaded: true`（首次 1–3 分钟/卡）；
5. 并行预热（每卡首次推理约 30 秒，多张卡同时进行）；
6. 启动网关（默认 8081）并等待全部副本就绪。

看到以下输出即部署成功：

```text
Ming TTS Studio is ready
  Studio:   http://127.0.0.1:8081/studio/
  API:      http://127.0.0.1:8081
  Health:   http://127.0.0.1:8081/health
  Docs:     http://127.0.0.1:8081/docs
```

浏览器打开 <http://127.0.0.1:8081/studio/>。前端与 API 同源，无需额外配置连接地址。

常用参数：

```bash
./start.sh --gpus 0,1                 # 只用 GPU 0 和 1
./start.sh --gpu-count 2              # 使用前 2 张卡
./start.sh --gateway-port 9000        # 只改网关端口；worker 端口由 --worker-base-port 决定（默认 8091 起）
./start.sh --no-warmup                # 跳过预热，启动更快但首次请求更慢
./start.sh --skip-model-download      # 强制要求本地已有模型
./start.sh --dry-run                  # 只打印部署计划，不启动进程
```

## 6. 日常运维

```bash
./status.sh      # PID 状态 + 网关 /health
./stop.sh        # 停止网关和全部 worker（SIGTERM，30 秒后强杀）
```

日志与运行状态：

```text
logs/worker_gpu0.log      # 每张卡一个 worker 日志
logs/gateway.log          # 网关日志
run/worker_0.pid          # PID 文件
run/gateway.pid
run/gateway.port
```

实时查看：

```bash
tail -f logs/gateway.log
tail -f logs/worker_gpu0.log
```

重启：

```bash
./stop.sh && ./start.sh
```

## 7. 开机自启（systemd，可选）

创建 `/etc/systemd/system/ming-tts-studio.service`，把路径和用户替换为实际值：

```ini
[Unit]
Description=Ming TTS Studio
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=ubuntu
WorkingDirectory=/opt/ming-tts-studio
ExecStart=/opt/ming-tts-studio/start.sh
ExecStop=/opt/ming-tts-studio/stop.sh
TimeoutStartSec=1800

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ming-tts-studio
sudo systemctl status ming-tts-studio
journalctl -u ming-tts-studio -f
```

> 启动器自身会把 worker/网关转为后台进程，所以 service 使用 `Type=oneshot` + `RemainAfterExit=yes`。

## 8. 开放给其他机器访问

启动器默认监听 `0.0.0.0:8081`。检查防火墙：

```bash
sudo ufw allow 8081/tcp
```

公网部署务必先阅读 [安全与网络暴露](../README.md#安全与网络暴露)：

- 服务没有内置鉴权，任何能访问端口的人都能合成语音、上传和删除文件；
- 建议放在 Nginx / Caddy 反向代理之后，加 HTTPS 与 Basic Auth / OAuth；
- 不要直接暴露 8091–8094 的 worker 端口，只开放网关。

Nginx 反向代理示例：

```nginx
server {
    listen 443 ssl;
    server_name tts.example.com;

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_request_buffering off;
    }
}
```

`proxy_read_timeout` 需要大于最长合成耗时；长文本 + 低配显卡可能超过 5 分钟。

## 9. 常见问题

**`Python 3.10.x is required`**

启动器只接受 3.10。用 `./scripts/setup_linux.sh` 创建 `.venv`，或 `PYTHON_BIN=/path/to/python3.10 ./start.sh`。

**`Missing Python packages`**

依赖未装进当前环境。重新执行 `./scripts/setup_linux.sh`，确认使用的是 `.venv/bin/python`。

**`GPU 0 has only ... MiB free`**

显存被其他进程占用。先 `nvidia-smi` 查看，释放后重启；或调低 `MIN_FREE_VRAM_MB`（不推荐低于 18000）。

**`Ports already in use`**

网关或 worker 端口被占用。执行 `./stop.sh`；若是其他程序占用，改用 `--gateway-port` / `--worker-base-port`。

**魔搭下载失败，想换 Hugging Face**

```bash
./start.sh --source huggingface
```

或删除不完整目录后重试（启动器会重新下载缺失文件）：

```bash
rm -rf models/Ming-3.0-tts-tiny
./start.sh --source modelscope
```

**`triton` 相关报错**

确认安装的是 `triton==3.3.1`（Linux）而不是 `triton-windows`。`pip show triton` 查看版本，必要时重装：

```bash
.venv/bin/python -m pip install --force-reinstall triton==3.3.1
```

**合成很慢 / 首次请求超时**

首次请求包含编译与缓存初始化，预热可避免。长文本建议先分段；并发高时增加 GPU 数量。

**页面一直显示演示模式**

确认 `curl http://127.0.0.1:8081/health` 返回 `healthy`。前端与 API 不同源时，检查 CORS 与 HTTPS 混合内容限制。

## 10. 更新

```bash
./stop.sh
git pull
./scripts/setup_linux.sh    # 依赖有变化时
./start.sh
```

模型文件在 `models/`，上传文件在 `uploads/`，均已被 `.gitignore` 排除，不会被更新覆盖。

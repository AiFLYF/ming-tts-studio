# Windows 部署教程

Windows 上有两种方式：

| 方式 | 状态 | 说明 |
| --- | --- | --- |
| **WSL2 + Ubuntu**（推荐） | 稳定 | 与 Linux 完全一致的依赖栈，GPU 直通，兼容性最好 |
| 原生 Windows `.venv` | 实验性 | 需要 `triton-windows`，部分算子/依赖可能出错 |

除非有明确理由，请使用 WSL2。

## 方案 A：WSL2（推荐）

### 1. 检查显卡驱动

在 PowerShell 执行：

```powershell
nvidia-smi
```

需要 Windows 端 NVIDIA 驱动 ≥ 525。**不要在 WSL 里安装显卡驱动**，WSL 直接复用 Windows 驱动；在 WSL 内安装 Linux 驱动反而会破坏 CUDA。

### 2. 安装 WSL2 与 Ubuntu

以管理员身份打开 PowerShell：

```powershell
wsl --install -d Ubuntu-22.04
```

完成后重启电脑，按提示创建 Linux 用户名和密码。验证：

```powershell
wsl --status
wsl --list --verbose     # VERSION 应为 2
```

如果已有 WSL 但版本是 1：

```powershell
wsl --set-version Ubuntu-22.04 2
wsl --set-default-version 2
```

### 3. 把项目放进 WSL 文件系统

在 WSL 终端中操作，不要放在 `/mnt/c`（跨文件系统 I/O 会显著拖慢模型加载）：

```bash
mkdir -p ~/apps && cd ~/apps
git clone <你的仓库地址> ming-tts-studio
cd ming-tts-studio
```

也可以在 Windows 资源管理器地址栏输入 `\\wsl$\Ubuntu-22.04\home\<用户名>` 拖入 zip 后解压。

### 4. 安装依赖

```bash
sudo apt update
sudo apt install -y python3.10 python3.10-venv python3-pip git curl
./scripts/setup_linux.sh
```

Ubuntu 22.04 自带 Python 3.10，可直接使用。

### 5. 启动

```bash
./start.sh
```

或在 Windows 的 PowerShell / 资源管理器里双击 `start.bat`。`start.bat` 的逻辑：

1. 存在 `.venv` → 用原生 Windows 环境启动；
2. 否则检测 `wsl.exe` → 通过 WSL2 调用 `./start.sh`。

但**仅当项目放在 Windows 盘（如 `D:\ming-tts-studio`）时才能双击 `start.bat`**——项目在 WSL 内部（`~/apps/...`）时 Windows 侧看不到这些文件，请直接在 WSL 终端执行 `./start.sh`。

### 6. 从 Windows 访问

WSL2 默认开启 localhost 转发，直接在 Windows 浏览器打开：

```text
http://127.0.0.1:8081/studio/
```

其他设备访问（同一局域网）：

1. 确认 WSL 内服务监听 `0.0.0.0:8081`（默认如此）；
2. 在管理员 PowerShell 中放行端口：

```powershell
New-NetFirewallRule -DisplayName "Ming TTS 8081" -Direction Inbound -Protocol TCP -LocalPort 8081 -Action Allow
```

3. 若仍无法访问，设置端口转发（每次 WSL 重启后 IP 可能变化）：

```powershell
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=$wslIp
```

删除转发：

```powershell
netsh interface portproxy delete v4tov4 listenport=8081 listenaddress=0.0.0.0
```

### 7. 停止与状态

```bash
./stop.sh
./status.sh
```

Windows 下同样可以双击 `stop.bat` / `status.bat`。

### 8. 模型下载（魔搭 / Hugging Face）

与 Linux 相同，在 WSL 终端执行：

```bash
./start.sh --source modelscope      # 魔搭（国内推荐）
./start.sh --source huggingface     # Hugging Face
```

Hugging Face 镜像：

```bash
export HF_ENDPOINT=https://hf-mirror.com
./start.sh --source huggingface
```

模型存放在 WSL 的 `~/apps/ming-tts-studio/models/Ming-3.0-tts-tiny`。想与 Windows 共享，可：

```bash
ln -s /mnt/d/models/Ming-3.0-tts-tiny models/Ming-3.0-tts-tiny
```

然后在 `.env` 中设置 `MODEL_PATH=./models/Ming-3.0-tts-tiny`。读取 `/mnt/d` 会慢一些，建议模型仍放在 WSL 内部磁盘。

### 9. WSL 内存限制（可选）

WSL2 默认最多占用一半物理内存。推理服务 + 4 个 worker 建议至少 32 GB。在 `C:\Users\<用户名>\.wslconfig` 中调整：

```ini
[wsl2]
memory=48GB
swap=8GB
```

执行 `wsl --shutdown` 后重新启动生效。

## 方案 B：原生 Windows（实验性）

官方 Triton 不支持 Windows，本项目改用 [`triton-windows`](https://pypi.org/project/triton-windows/)。`fla-core` 等依赖也可能存在未覆盖的 Windows 分支，遇到编译或算子错误时请回到 WSL2。

### 1. 准备

- 安装 [Python 3.10.x](https://www.python.org/downloads/)（安装时勾选 **Add python.exe to PATH**）；
- 安装 [Git for Windows](https://git-scm.com/download/win)；
- 确认 `nvidia-smi` 可用（驱动 ≥ 525）。

```powershell
python -V        # Python 3.10.x
nvidia-smi
```

项目路径尽量短且不含中文，例如 `D:\ming-tts-studio`。

### 2. 安装依赖

在项目根目录打开 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Native
```

脚本会创建 `.venv` 并安装 `server/requirements-server-windows.txt`，其中使用 `triton-windows==3.3.1.post21`。

国内网络可先设置镜像：

```powershell
$env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
```

### 3. 启动

```powershell
.\start.bat
```

或直接：

```powershell
.venv\Scripts\python.exe server\launcher.py start
```

打开 <http://127.0.0.1:8081/studio/>。

模型下载、GPU 选择、端口等参数与 Linux 完全一致：

```powershell
.\start.bat --source modelscope
.\start.bat --gpus 0
.\start.bat --dry-run
```

### 4. 停止 / 状态

```powershell
.\stop.bat
.\status.bat
```

### 5. 原生模式的已知限制

- 首次 `pip install` 可能编译部分包，需要可用的 MSVC Build Tools；
- `triton-windows` 版本必须与 torch 2.7.1 对应，不要随意升级；
- 若出现 `DLL load failed`，安装 [Microsoft Visual C++ 2015-2022 Redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe)；
- 部分融合算子可能回退到较慢路径，吞吐低于 Linux/WSL2；
- 无法启动时优先改用 WSL2，而不是继续修补原生环境。

## 通用配置

`.env.example` 复制为 `.env` 后即可调整：

```dotenv
MODEL_SOURCE=auto
MODEL_ID=inclusionAI/Ming-3.0-tts-tiny
MODEL_PATH=./models/Ming-3.0-tts-tiny
GATEWAY_PORT=8081
WORKER_BASE_PORT=8091
MIN_FREE_VRAM_MB=19000
# STUDIO_PASSWORD=           # 留空=不启用；填写后页面与 API 需要密码
# STUDIO_SESSION_HOURS=24
# GPUS=0,1
# HF_ENDPOINT=https://hf-mirror.com
# HF_TOKEN=hf_xxx
```

| 变量 | 作用 |
| --- | --- |
| `MODEL_SOURCE` | `auto` / `modelscope` / `huggingface` |
| `MODEL_PATH` | 权重目录，完整时跳过下载 |
| `GPUS` / `GPU_COUNT` | 指定显卡或使用前 N 张 |
| `GATEWAY_PORT` | 对外端口 |
| `WORKER_BASE_PORT` | 第一个 worker 端口，后续依次 +1 |
| `MIN_FREE_VRAM_MB` | 启动前要求的最小空闲显存 |
| `STUDIO_PASSWORD` | 访问密码；留空则关闭认证 |
| `STUDIO_SESSION_HOURS` | 登录会话有效期，默认 24 小时 |
| `HF_ENDPOINT` / `HF_TOKEN` | Hugging Face 镜像与令牌 |

## 常见问题

**`wsl --install` 下载失败**

在「启用或关闭 Windows 功能」中手动勾选 **适用于 Linux 的 Windows 子系统** 和 **虚拟机平台**，重启后再执行 `wsl --install`。商店不可用时可用 `wsl --install -d Ubuntu-22.04 --web-download`。

**WSL 中 `nvidia-smi` 不存在**

先确认 Windows 端 `nvidia-smi` 正常，然后执行 `wsl --update` 并重启 WSL（`wsl --shutdown`）。不要在 WSL 内安装 Linux 显卡驱动。

**`start.bat` 提示找不到 WSL 路径**

确认 `wsl --list --verbose` 至少有一个发行版，并且当前目录不是网络盘（`\\server\share`）。网络盘请先在 WSL 内手动 clone。

**端口被占用**

```powershell
netstat -ano | findstr :8081
```

停止占用进程，或 `.\start.bat --gateway-port 9000`。

**中文路径 / 空格路径**

项目路径含中文或空格时，WSL 脚本可能出错。请把项目移动到纯英文路径，如 `D:\ming-tts-studio`。

**想彻底重置环境**

```bash
./stop.sh
rm -rf .venv run logs
./scripts/setup_linux.sh
```

模型与上传文件不会被删除。

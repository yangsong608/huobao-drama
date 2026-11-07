# 本地 UVR 音频分离服务

MossHuobao「预览与混音」的可选 sidecar：把合片原声分离成 `vocals`（人物声）和
`instrumental`（原声背景），替代内置的 FFmpeg 中置提取。

后端只通过 `AUDIO_ENGINE_URL` 访问它，接口契约见
`backend/src/services/audio-engine.ts`：

```
GET  /v1/health
POST /v1/separate        { source_path, engine: "uvr", model?, output_dir, duration_ms? }
GET  /v1/jobs/{id}
POST /v1/jobs/{id}/cancel
```

## 环境要求

- macOS（Apple Silicon 或 Intel）、Linux
- Python 3.13（`uv` 会自动使用本机 Python 或下载）
- `ffmpeg` / `ffprobe` 在 PATH 中
- 首次运行需联网下载 UVR 模型（约 60–70 MB）；依赖（含 torch/onnxruntime）约 1 GB

## 安装与启动

```bash
cd tools/audio-engine
./setup.sh          # 建 .venv、装依赖、预下载 UVR-MDX-NET-Inst_HQ_3
./start.sh          # 默认监听 127.0.0.1:8199
```

只装依赖、不下载模型：`./setup.sh --no-model`。

## 接入应用

在 `backend/.env` 写入：

```
AUDIO_ENGINE_URL=http://127.0.0.1:8199
# 可选：与本机服务约定的 Bearer token
# AUDIO_ENGINE_TOKEN=<redacted>
```

重启后端后，新发起的分离会默认走 UVR；未配置或服务不可用时仍可手动选择
「基础分离」。桌面安装版的后端环境由 Electron 主进程注入，需要重新打包后才能
读取该变量。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AUDIO_ENGINE_HOST` | `127.0.0.1` | 绑定地址，非回环会给出警告 |
| `AUDIO_ENGINE_PORT` | `8199` | 监听端口 |
| `AUDIO_ENGINE_TOKEN` | 空 | 设置后所有请求必须带 `Authorization: Bearer <token>` |
| `AUDIO_ENGINE_MODEL_DIR` | `~/.cache/huobao-audio-engine/models` | 模型缓存目录 |
| `AUDIO_ENGINE_MODEL` | `UVR-MDX-NET-Inst_HQ_3` | 默认 UVR 模型 |
| `AUDIO_ENGINE_ALLOW_MODEL_DOWNLOAD` | `1` | 模型缺失时是否自动下载 |
| `AUDIO_ENGINE_ALLOWED_ROOTS` | `start.sh` 默认仓库 `data/` | 允许读写的目录白名单，`:` 分隔 |
| `AUDIO_ENGINE_TIMEOUT_MS` | `1800000` | 由后端读取的任务超时 |

数据目录不在仓库 `data/` 时（例如桌面版 userData），必须显式设置
`AUDIO_ENGINE_ALLOWED_ROOTS`，否则任务会被拒绝。

## 行为与限制

- 单任务队列：同时只跑一个分离，其余任务排队；取消会标记结果丢弃。
- 只支持 `engine: "uvr"`；Demucs 需要另配服务。
- 输出固定为 `vocals.wav` / `instrumental.wav`，路径必须落在 `output_dir` 内。
- 2-stem 分离仍会残留串音；角色声、群众声、环境声的细分需要 diarization 或专业
  工具，不在本服务范围内。
- 模型由 audio-separator 下载，商用/再分发前请自行确认对应模型许可。

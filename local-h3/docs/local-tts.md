# TTS 与 Voice Design 使用手册

更新日期：2026-11-04。适用于 191 服务器上已部署的 Qwen 语音服务。参数以当前 `server191_tts_api.py` 为准；部署版本和验收证据见[部署报告](validation/191节点语音部署.md)。

## 1. 选择生成方式

| 需求                 | `model`                 | 关键参数                                  | 实际后端                               |
| ------------------ | ----------------------- | ------------------------------------- | ---------------------------------- |
| 使用内置音色朗读文字         | `qwen3-tts-customvoice` | `voice`；可选 `instruct` 控制语气            | Qwen 官方 CustomVoice 1.7B / PyTorch |
| 根据年龄感、性别、性格等文字设计声音 | `qwen3-tts-voicedesign` | 必填 `instruct`，描述声音特征                  | Qwen 官方 VoiceDesign 1.7B / PyTorch |
| 使用现有合成参考音频生成新台词    | `qwen3-tts-base`        | HTTP 接口固定 `voice=synthetic-reference` | llama.cpp Base 1.7B Q4_K_M         |

Voice Design 生成的是一段带有设计音色的语音。把描述保存下来可以继续生成；相同描述和 seed 不保证不同台词始终具有完全一致的音色。需要延续具体角色音色时，应保存认可的样例作为参考音频。

## 2. 连接服务

服务器：`172.80.2.191`，SSH 账号：`xhubt`。密码不记录在本手册。

服务监听在服务器本机 `127.0.0.1:18190`。在服务器执行以下命令可直接使用：

```bash
curl --fail-with-body http://127.0.0.1:18190/health
curl --fail-with-body http://127.0.0.1:18190/v1/models
```

在自己电脑调用时，先打开一个终端并保持 SSH 转发连接：

```bash
ssh -N -L 18190:127.0.0.1:18190 xhubt@172.80.2.191
```

随后在自己电脑的另一个终端执行本手册中的 HTTP 示例。浏览器访问 `http://127.0.0.1:18190/docs` 可查看接口并填写参数。若本机 18190 已占用，可把 SSH 命令左侧端口改为 18191，并相应修改本机调用地址。

## 3. 固定音色 TTS

创建请求文件并生成 WAV：

```bash
cat > customvoice-request.json <<'JSON'
{
  "model": "qwen3-tts-customvoice",
  "input": "欢迎来到今天的健康课堂。我们一起学习科学的生活方式。",
  "voice": "Serena",
  "language": "Chinese",
  "instruct": "温暖自然，吐字清晰，语速适中，适合课程讲解。",
  "response_format": "wav",
  "max_new_tokens": 1024,
  "seed": 42
}
JSON

curl --fail-with-body --max-time 650 \
  http://127.0.0.1:18190/v1/audio/speech \
  -H 'Content-Type: application/json' \
  --data-binary @customvoice-request.json \
  -D customvoice-headers.txt \
  --output customvoice.wav
```

服务允许的内置音色名（大小写不敏感）：`Vivian`、`Serena`、`Uncle_Fu`、`Dylan`、`Eric`、`Ryan`、`Aiden`、`Ono_Anna`、`Sohee`。默认音色为 `Serena`；这些是模型音色名，不能填入自行起的角色名字。

`voice` 选择内置音色，`instruct` 调整表达方式，例如“轻快、有笑意”“平静、舒缓”“清晰、适合教学”。

## 4. Voice Design：阳光少年男声

已经生成的角色暂记为 `sunny-teen-boy`，设计方向为十四至十五岁的男性青少年、清亮、有少年感、阳光开朗、活泼亲切。

固定设计描述：

> 一位十四到十五岁的男性青少年，普通话标准自然。声音清亮干净，具有真实的少年感，处于青春期的年轻男声，中高音区，带一点轻微自然的变声期质感。性格阳光开朗、活泼友善，讲话时带着自然笑意和充沛朝气，像热情的同龄学习搭档。语速轻快适中，咬字清晰，语调有自然起伏，情绪积极，表达真诚放松。

完整请求：

```bash
cat > sunny-teen-request.json <<'JSON'
{
  "model": "qwen3-tts-voicedesign",
  "language": "Chinese",
  "input": "嗨，我是你的学习搭档！今天也要元气满满呀。遇到难题别着急，我们一起试试看，说不定下一秒就想明白啦！",
  "instruct": "一位十四到十五岁的男性青少年，普通话标准自然。声音清亮干净，具有真实的少年感，处于青春期的年轻男声，中高音区，带一点轻微自然的变声期质感。性格阳光开朗、活泼友善，讲话时带着自然笑意和充沛朝气，像热情的同龄学习搭档。语速轻快适中，咬字清晰，语调有自然起伏，情绪积极，表达真诚放松。",
  "max_new_tokens": 512,
  "seed": 42
}
JSON

curl --fail-with-body --max-time 650 \
  http://127.0.0.1:18190/v1/audio/speech \
  -H 'Content-Type: application/json' \
  --data-binary @sunny-teen-request.json \
  -D sunny-teen-headers.txt \
  --output sunny-teen.wav
```

生成其他台词时，修改 `input`；微调声音时，修改 `instruct`。例如调整为“语速稍慢，语气更沉稳”，或“更有笑意，语调更活泼”。`max_new_tokens` 是生成上限，不是语速控制参数。

### 已保存的角色资料

服务器目录：`/data/workspaces/llamacpp/tts/voices/sunny-teen-boy/`。

| 文件             | 用途                         |
| -------------- | -------------------------- |
| `request.json` | 原始台词、声音描述、seed 和生成参数       |
| `sample.wav`   | 已生成的 8.96 秒试听，可保留为合成参考音频   |
| `result.json`  | 任务 ID、耗时、采样率、时长与音频 SHA-256 |

项目内备份：[声音描述与请求](validation/artifacts/voice-design-sunny-teen-boy-20261103/request.json)、[试听](validation/artifacts/voice-design-sunny-teen-boy-20261103/sample.wav)、[生成记录](validation/artifacts/voice-design-sunny-teen-boy-20261103/result.json)。

`sunny-teen-boy` 是资料目录名，尚未注册为 HTTP 接口的 `voice` 值。VoiceDesign 调用时使用上述完整 `instruct`。

## 5. Base TTS 与参考音频

### 统一 HTTP 接口

当前接口固定使用 `/data/workspaces/llamacpp/tts/reference.wav`，它来自部署验收时的首个 CustomVoice 样例，当前不是上述少年样例。

```bash
curl --fail-with-body --max-time 650 \
  http://127.0.0.1:18190/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-tts-base","voice":"synthetic-reference","input":"合理膳食，适量运动，规律作息。","language":"Chinese","seed":42}' \
  --output base.wav
```

Base HTTP 请求必须使用 `voice=synthetic-reference`，指定具体语言，且不填写 `instruct`。当前没有参考音频上传或按角色选择参考音频的 HTTP 接口。

### 在服务器直接指定少年参考音频

原生 `llama-tts` 可以显式选择 `--tts-speaker-file`，用于尝试延续少年样例的音色：

```bash
cd /data/workspaces/llamacpp

./llama.cpp/build/bin/llama-tts \
  -m models/qwen-tts/Base-GGUF/Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf \
  -mm models/qwen-tts/Base-GGUF/mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf \
  -ngl 99 -t 8 -c 4096 -n 1024 \
  --tts-lang zh \
  --tts-speaker-file tts/voices/sunny-teen-boy/sample.wav \
  -p '今天我们一起学习一个有趣的新知识，准备好了吗？' \
  --seed 42 \
  --output tts/voices/sunny-teen-boy/new-line.wav
```

这条命令使用 Base 模型参考已设计声音，音色效果需要另行试听确认；已验收的 Base HTTP 样例使用的是默认参考。直接运行 CLI 会绕过 HTTP 服务的并发锁，应在服务空闲、没有其他 GPU 任务时执行。不要替换公共 `reference.wav` 来切换单个角色，以免改变其他调用的默认声音。

## 6. 参数表

| 参数                | 默认值／范围                  | 说明                                                                                                     |
| ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `model`           | `qwen3-tts-customvoice` | 三种模型 ID 见第 1 节                                                                                         |
| `input`           | 必填，1—500 字符             | 要朗读的文字，不能全为空白                                                                                          |
| `voice`           | `Serena`                | CustomVoice 用内置音色；Base 必须为 `synthetic-reference`；VoiceDesign 不用此字段设计声音                                 |
| `instruct`        | 空，最长 1000 字符            | VoiceDesign 必填；CustomVoice 可选；Base 必须为空                                                                |
| `language`        | `Chinese`               | 支持 Chinese、English、Japanese、Korean、German、French、Russian、Portuguese、Spanish、Italian、Auto；Base 不接受 Auto |
| `response_format` | `wav`                   | 当前只提供 WAV                                                                                              |
| `max_new_tokens`  | 1024；64—2048            | 音频生成上限；到达上限可能截断，须检查最后一句是否完整                                                                            |
| `seed`            | 42；0—2147483647         | 控制随机生成；Base 同时使用固定参考音频                                                                                 |

返回值为 WAV 二进制。成功响应头 `X-Job-Id` 用于查日志，`X-Synthesis-Seconds` 为服务端耗时。当前生成结果为 24kHz 单声道 PCM16 WAV。

长课程建议先按句或语义段拆分，逐段请求并保存顺序。服务每次重新加载模型，耗时包含加载；一次只执行一个合成任务。没有流式输出、任务查询或取消接口。

## 7. Python 调用

使用 Python 标准库即可调用。先按前文保存 `sunny-teen-request.json`，需要时修改文件中的台词：

```python
import json
import urllib.request
from pathlib import Path

body = json.loads(Path("sunny-teen-request.json").read_text(encoding="utf-8"))
body["input"] = "今天我们一起学习一个有趣的新知识，准备好了吗？"
request = urllib.request.Request(
    "http://127.0.0.1:18190/v1/audio/speech",
    data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=650) as response:
    Path("sunny-teen-new.wav").write_bytes(response.read())
    print("任务 ID:", response.headers.get("X-Job-Id"))
```

## 8. 服务管理与排错

以下命令用 `xhubt` 账号在 191 服务器执行：

```bash
systemctl --user status qwen-tts.service
systemctl --user start qwen-tts.service
systemctl --user restart qwen-tts.service
systemctl --user stop qwen-tts.service
journalctl --user -u qwen-tts.service -n 80 --no-pager
```

服务已设置开机启动，账号已启用 Linger。统一程序目录为 `/data/workspaces/llamacpp/tts/app/`，Python 环境为 `/data/workspaces/llamacpp/venv-qwen-tts/`。

| 现象       | 处理方式                                           |
| -------- | ---------------------------------------------- |
| 连接被拒绝    | 检查用户服务状态；从自己电脑访问时检查 SSH 转发是否保持连接               |
| HTTP 422 | 核对模型 ID、音色名、必填描述、输入长度与 Base 的限制；查看 JSON 错误响应   |
| HTTP 429 | 当前 GPU 合成任务正在执行，等待完成后重试                        |
| HTTP 409 | Base 缺少默认参考；先成功生成一次 CustomVoice                |
| HTTP 503 | 查看响应中的任务 ID 和对应日志；健康检查 503 时查看 `backends` 的缺失项 |
| HTTP 504 | 单次推理超过 600 秒；检查 GPU 任务与日志，缩短文本后再提交             |
| 语音末尾缺失   | 检查是否触及 token 上限；优先缩短分段，或适当提高上限                 |

按任务 ID 查文件：

```text
/data/workspaces/llamacpp/tts/logs/<job_id>.log
/data/workspaces/llamacpp/tts/outputs/<job_id>.request.json
/data/workspaces/llamacpp/tts/outputs/<job_id>.wav
/data/workspaces/llamacpp/tts/outputs/<job_id>.result.json
/data/workspaces/llamacpp/tts/outputs/<job_id>.metrics.json  # 官方 PyTorch 后端
```

普通任务输出会按服务的时间与数量策略清理。需要长期保存的声音样例应另存到 `tts/voices/<角色名>/`，并保留请求和生成记录；本次少年样例已经这样归档。

## 9. 接入信息与实测（2026-11-04 核对）

### 服务现状

`systemctl --user is-active qwen-tts.service` → `active`，`is-enabled` → `enabled`；`/health` 返回 `status=ok`、`busy=false`，三个后端 `ready`；GPU `NVIDIA GeForce RTX 3060 12GB`，驱动 575.64.03，空闲时占用 32MiB。

监听地址只有 `127.0.0.1:18190`（`uvicorn --host 127.0.0.1 --port 18190 --workers 1`），没有公网监听，也没有鉴权。因此**从自己电脑访问必须走 SSH 转发**，或在服务器上执行。

### 接口清单（全部，共 4 个）

| 方法   | 路径                 | 用途                    |
| ---- | ------------------ | --------------------- |
| GET  | `/health`          | 服务与三个后端就绪状态、`busy` 标志 |
| GET  | `/v1/models`       | 三个模型 ID 与后端名          |
| POST | `/v1/audio/speech` | 生成 WAV                |
| GET  | `/docs`            | OpenAPI 交互页（可填参数直接试）  |

没有流式、任务查询、取消、参考音频上传、音色注册接口。

### 模型与权重

| API model               | 后端                    | 权重目录                           |     体积 | 加载方式                             |
| ----------------------- | --------------------- | ------------------------------ | -----: | -------------------------------- |
| `qwen3-tts-customvoice` | Qwen 官方 PyTorch       | `models/qwen-tts/CustomVoice/` | 4.3 GB | BF16 + SDPA，每请求独立进程              |
| `qwen3-tts-voicedesign` | Qwen 官方 PyTorch       | `models/qwen-tts/VoiceDesign/` | 4.3 GB | 同上；`instruct` 必填                 |
| `qwen3-tts-base`        | llama.cpp `llama-tts` | `models/qwen-tts/Base-GGUF/`   | 1.4 GB | Q4_K_M 988MB + Q8_0 mmproj 426MB |

### 实测耗时（同一张 3060，含加载）

| 任务                   |    音频时长 |     加载 |      生成 |  生成倍率 |     端到端 |
| -------------------- | ------: | -----: | ------: | ----: | ------: |
| CustomVoice / Serena |  5.52 秒 | 3.19 秒 | 23.70 秒 | 4.29× | 33.97 秒 |
| CustomVoice / Serena | 32.08 秒 | 3.19 秒 | 134.2 秒 | 4.18× | 144.5 秒 |
| CustomVoice / Serena |  6.00 秒 | 3.22 秒 | 25.79 秒 | 4.30× |  36.3 秒 |
| VoiceDesign / 描述     |  5.52 秒 |  3.2 秒 |  24.0 秒 | 4.35× |  34.0 秒 |
| VoiceDesign / 描述     |  8.96 秒 |  3.2 秒 |  38.0 秒 | 4.25× |  48.3 秒 |
| Base / 合成参考          |  5.76 秒 |      — |       — |     — |  5.90 秒 |

**估算公式：端到端 ≈ 4.3 × 音频秒 + 10 秒**（加载 3.2 秒 + 进程启动与落盘约 7 秒）。llama.cpp Base 后端不重新加载 PyTorch 权重，5.76 秒音频 5.9 秒完成，接近实时。

按段落切分时，每段都要付一次 10 秒固定开销：11.5 秒的段落实际约 59 秒，折合 5.2×，比计划里的 4.5× 略高。整门估算可按 4.5× 走，但**按段预算时要用 5× 以上**。

### 给桌面应用的登记字段

`provider_configs`（`kind='tts'`）：

| 字段           | 值                                                                                                     | 说明                   |
| ------------ | ----------------------------------------------------------------------------------------------------- | -------------------- |
| `base_url`   | `http://127.0.0.1:18190`（不要带 `/v1`）                                                                   | 需先建 SSH 转发；断开会变成连接错误 |
| `model`      | `qwen3-tts-customvoice`                                                                               | 另两个 ID 见上表           |
| `params`     | `{"voice":"Serena","language":"Chinese","instruct":"温暖自然，吐字清晰，语速适中","max_new_tokens":1024,"seed":42}` | 字段名与请求体一致            |
| `secret_ref` | 空                                                                                                     | 服务无鉴权                |

隧道命令（本机 18190 被占用时改左侧端口）：

```bash
ssh -N -L 18190:127.0.0.1:18190 xhubt@172.80.2.191
```

### 火宝桌面应用配置

应用内选择服务商 `qwen3-tts`，按下面填写即可。`Base URL` 必须填到主机根，应用会自行拼接 `/v1/audio/speech`；若照抄成 `.../v1` 会变成 `/v1/v1/audio/speech` 并返回 404。

| 应用字段 | 值 |
| --- | --- |
| 服务商 | `qwen3-tts` |
| Base URL | `http://127.0.0.1:18190` |
| API Key | 留空 |
| 默认模型（首位） | `qwen3-tts-customvoice` / `qwen3-tts-voicedesign` / `qwen3-tts-base` |
| 音色 ID | `Serena`、`Vivian`、`Dylan` 等内置名；不能填自行起的角色名 |
| provider_settings | `{"timeoutMs":650000,"concurrency":1,"maxInputChars":500}` |

应用已针对 191 自动处理：

- 模型 ID 为 `qwen3-tts-*` 时，单次输入按 500 字上限自动切分，避免 422。
- 默认超时 650 秒，默认 `max_new_tokens` 2048，`concurrency` 默认 1。
- VoiceDesign 自动复用 `/v1/audio/speech` 并发送 `instruct`，不再调用 191 不存在的 `/v1/audio/speech/design`。
- 191 的 `/v1/audio/speech` 没有 `speed` 参数，应用对 `qwen3-tts-*` 不发送 `speed`；Base 模型同时不发送 `instruct`。
- 选择 `qwen3-tts-base` 时，应用强制发送 `voice=synthetic-reference`，忽略音色档案里的外部音色 ID 与设计描述，避免服务端校验失败。
- 参考音频克隆需要 multipart 上传，191 没有该 HTTP 接口，当前只有 Base 的固定参考音色 `synthetic-reference` 可用。

**接通范围：** CustomVoice 内置音色、VoiceDesign 与 Base 固定参考均已接通；按角色上传参考音频做克隆仍不支持。191 为单卡单任务，整集配音会明显慢于云端，建议先用于试听和短句验证。

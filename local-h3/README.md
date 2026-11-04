# 本地 H3 接入包（huobao ⇄ 自建 ComfyUI + MiniMax H3）

> 让火宝（huobao-drama）以为在调 MiniMax 云 API，实际落到我们自己的 4090 + ComfyUI。
> 本目录是**自包含**的：脚本、启动方式、隧道、排障全在里面。

---

## 一、整体链路

```
火宝前端/后端（本机 5679 / 3013）
        │  MiniMax v2 协议 / OpenAI Images 协议
        ▼
本机桥接：8190（视频）  8191（图片）
        │  HTTP
        ▼
本机 127.0.0.1:8188  ←── SSH 隧道 ──  服务器 <H3_SERVER_IP>:8188
                                          │
                                          ▼
                                 ComfyUI 0.43 + MiniMax H3
                                 （Director / ImageToVideo / ReferenceToVideo）
```

---

## 二、服务清单

| 服务 | 端口 | 位置 | 作用 | 脚本 |
|---|---|---|---|---|
| 火宝后端 | 5679 | 本机 | 项目/分镜/任务 API | `backend/ npm run dev` |
| 火宝前端 | 3013 | 本机 | 操作界面 | `frontend/ npm run dev` |
| **视频桥** | **8190** | 本机 | MiniMax v2 → H3 Director | `scripts/shim.py` |
| **图片桥** | 8191 | 本机 | OpenAI Images → Qwen-Image | `scripts/img_shim.py` |
| ComfyUI | 8188 | 服务器 | 出片/出图 | 见《部署》 |
| SSH 隧道 | 8188 | 本机→服务器 | 打通本机到 ComfyUI | `ssh_tunnel`（DSH）或 `ssh -f -N -L` |

---

## 三、启动步骤

### 1. 建隧道（必须先做）

先查状态，返回 `200` 说明隧道已通：

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/system_stats
```

方式 A：DSH 的 ssh_tunnel 工具（推荐，进程由宿主托管）

```
ssh_tunnel  action=start
            alias=<H3_SERVER_IP>
            localPort=8188
            remotePort=8188
            remoteHost=127.0.0.1
```

DSH 使用 `~/.dsh/dsh-ssh.json` 中已保存的主机凭据（本机为密码认证）。

方式 B：手工 SSH 转发（`-f` 认证成功后转后台）

```bash
export H3_HOST=<H3_SERVER_IP>
ssh -f -N -L 8188:127.0.0.1:8188 -o ExitOnForwardFailure=yes root@"$H3_HOST"
```

默认密钥未授权时，手工方式会在终端提示输入密码；密码只保存在本机 DSH 配置里，
不要写入脚本、命令历史或仓库。Mac 休眠/重启/切换网络后转发会断开，重跑同一条命令即可。

验证：

```bash
curl -s http://127.0.0.1:8188/system_stats | head -c 120
# 返回含 comfyui_version 的 JSON 即通；000/空 = 未通
```

`bash local-h3/scripts/health.sh` 会把这条连同 8188 监听、桥接与火宝一起检查；每次出片前建议先跑一遍。

停止：`lsof -nP -iTCP:8188 -sTCP:LISTEN` 找到 ssh 的 PID 后 `kill <PID>`。

### 2. 起两个桥接

```bash
bash 工具/huobao-drama/local-h3/scripts/start.sh
```

`start.sh` 会先检查 8188，再检查 8190/8191 上运行的是不是**本项目**的脚本：
`/health` 里的 `script` 与项目路径不一致时（例如旧副本 `mm-shim/shim.py`）会自动重启替换。
手动启动也可以：

```bash
cd 工具/huobao-drama/local-h3/scripts
(nohup python3 "$PWD/shim.py"     > /tmp/mm_shim.log  2>&1 &)   # 8190 视频
(nohup python3 "$PWD/img_shim.py" > /tmp/img_shim.log 2>&1 &)   # 8191 图片

# 验证：script 应指向 local-h3/scripts，且带 pid
curl -s http://127.0.0.1:8190/health
curl -s http://127.0.0.1:8191/health
```

**注意**：必须用绝对路径启动，否则工作目录不同会加载另一份 `state.json` / `files/`；
macOS 没有 `setsid`，用 `(nohup ... &)` 子 shell 方式，否则进程会随 shell 退出。

### 3. 起火宝

```bash
cd 工具/huobao-drama/backend  && nohup npm run dev > /tmp/hb_backend.log 2>&1 &
cd 工具/huobao-drama/frontend && nohup npm run dev > /tmp/hb_frontend.log 2>&1 &
```

打开 `http://localhost:3013`。

---

## 四、火宝里的配置（设置 → AI 服务）

| 类型 | provider | Base URL | API Key | Model |
|---|---|---|---|---|
| **视频** | `minimax` | `http://127.0.0.1:8190` | `local` | `MiniMax-H3` |
| **图片** | `openai` | `http://127.0.0.1:8191` | `local` | `qwen-image` |
| 文本 | `openai` | `https://api.deepseek.com` | 自己的 key | `deepseek-chat` |

> ⚠️ 火宝的 `GET /api/v1/ai-configs` **会明文返回 api_key**，别在多用户环境用。

---

## 五、桥接支持的参数（自有扩展）

### 视频桥（8190）

| 字段 | 取值 | 说明 |
|---|---|---|
| `duration` | 4–15（秒，官方 schema） | 吸附到最近的 `5+17k` 帧网格（5–362 帧），实际时长以查询回传为准 |
| `resolution` | `768P` / `2K`（也接受 `480p` 等档位名） | 官方字段；缺省按 480p |
| **`resolution_tier`** | `480p` / `720p` / `1080p` | **自有扩展**，优先于 resolution；火宝在本地配置下会自动发 |
| **`aspect_ratio`** | `16:9` / `9:16` / `4:3` / `21:9` | **自有扩展**，竖屏必带；火宝会自动发 |
| **`audio_mode`** | `native` / `ambient` / `silent` | `ambient` = 只要环境声（给后期 TTS 让路）；`silent` = 完全不要音轨并要求角色闭口不讲话；`native` 按提示词生成对白/环境声，只有提示词明确描述画外音旁白时才生成旁白 |
| **`quality`** | `preview` / `final` | **自有扩展**：`preview` = 4 步 turbo 快速预览，`final` = 8 步 LoRA 交付；缺省 `preview` |
| **`negative_prompt`** | 字符串 | **自有扩展**：空值用桥接内置质量兜底词 |
| **`seed`** | 整数 | **自有扩展**：固定种子便于复现；缺省随机 |
| **`cfg`** | 0.5–5.0 | **自有扩展**：缺省 1.0 |
| `content[].role` | `first_frame` / `last_frame` / `reference_image` | 首尾帧必须成对；有首帧走 fl2v，有参考图走 r2v |

画布换算（短边档位 × 比例，吸附 32 的倍数）：

| 档位 | 16:9 | 9:16 |
|---|---|---|
| 480p | 864×480 | 480×864 |
| 720p | **1376×768** | 768×1376 |
| 1080p | 1920×1088 | 1088×1920 |

> 火宝选中本地视频配置后：分辨率下拉会出现 480p，并自动带上比例与声音模式；
> 不传档位时桥接按 480p 兜底。720p 比 480p 慢约 2–2.5 倍，1080p 再慢，交付建议用 `quality=final`（8 步 LoRA）。
> 环境声/静音模式会先删除提示词里已有的 `音频：` / `Audio:` 行，再注入对应英文指令。
> native 模式不会无条件要求旁白：提示词没有真正的旁白描述时，只生成对白与环境声。
> 设置页的 minimax 视频配置可直接选质量档、填负向提示词与固定种子；这些字段只在本地 shim 发送。

### 图片桥（8191）

| 字段 | 取值 | 说明 |
|---|---|---|
| `size` | `宽x高` | 文生图与参考图编辑都会缩放到该尺寸（8 的倍数，256–2048） |
| `image[]` | multipart 图片 | 参考图；本地 Qwen-Image 只有 img2img 单图通道，**只使用第 1 张** |
| `response_format` | `url` / `b64_json` | 文生图支持；编辑固定返回 URL |

`GET /health` 的 `capabilities` 如实返回 `maxReferences=1`、`multiReference=false`；
多传参考图时响应带 `warning`，后端日志记 `provider-warning`，不再静默丢弃其余图片。

---

## 六、H3 健康检查（服务器）

```bash
# 版本与显存
curl -s http://127.0.0.1:8188/system_stats

# 节点是否加载
python3 -c "import json,urllib.request;o=json.load(urllib.request.urlopen('http://127.0.0.1:8188/object_info'));print([k for k in o if k=='MiniMaxH3Director'])"

# 模型
ls -lh /data/comfyui/models/diffusion_models/minimax*
ls /data/comfyui/models/loras/ | grep minimax
```

**正常基线（2026-11-04 实测）**：ComfyUI 0.43.0 / torch 2.9.0+cu128 / RTX 4090 / 显存 24.7 GB 空闲 / 核心节点 5 个全部在 / 两个 20G UNET + 4 个 LoRA 齐全。

---

## 七、端到端自测

```bash
# 5 秒、480p、竖屏、只留环境声
curl -s -X POST http://127.0.0.1:8190/v2/video_generation \
  -H 'Content-Type: application/json' \
  -d '{"model":"MiniMax-H3","duration":5,"resolution_tier":"480p","aspect_ratio":"9:16","audio_mode":"ambient",
       "content":[{"type":"text","text":"[Shot 1] 3D CG, a bamboo steamer on wet stone steps, steam drifting, slow push in. No dialogue."}]}'

# 拿 task_id 轮询；成功时返回 url 与实际 duration
curl -s http://127.0.0.1:8190/v2/query/video_generation/<task_id>
```

**实测**：提交 → 90 秒 → `succeeded` + mp4 URL。
`duration` 会吸附到最近的 `5+17k` 帧网格（24fps，5–362 帧）：10 秒→243 帧（10.125 秒）、
11 秒→260 帧（10.833 秒）、15 秒→362 帧（15.083 秒）；桥接会在查询结果里回传实际 `duration`，供火宝校正分镜时长。

---

## 八、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 桥接返回 `URLError: Connection refused` | 隧道断了（桥接要连 127.0.0.1:8188） | 重建隧道，`curl 8188/system_stats` 验证 |
| 任务失败含 `URLError: <urlopen error [Errno 32] Broken pipe>`（上传参考图阶段） | 8188 隧道在任务中途断开；8190 `/health` 仍可能是绿的 | 重建隧道并验证 8188；任务已终态，修复后重新提交 |
| 8190 `/health` 正常但出片失败 | `/health` 只证明桥接进程活着，不代表隧道通 | 跑 `bash scripts/health.sh`，它会同时检查 8188 监听与 `system_stats` |
| 任务失败且消息含 `MiniMaxH3Director` / `CUDA out of memory` | ComfyUI 执行报错 | 桥接已透传节点与异常信息；按提示降分辨率/重启 ComfyUI |
| 仍是 `no video in outputs` | 图确实没产出视频（输出被同名文件覆盖等） | 看 `/tmp/mm_shim.log` 与 ComfyUI 日志 |
| 画面糊 | 预览档 4 步 turbo，480p/1080p 偏软 | 设置里把本地 minimax 质量档切到 `final`（8 步 LoRA）；本地优先 720p |
| 环境声/静音不生效 | 提示词里已有 `音频：` 行，或请求没带 `audio_mode` | 桥接会在 ambient/silent 下删除原音频行并注入对应指令；检查火宝是否选中本地配置 |
| 出现中文字幕 | 提示词正文含中文 | 中文只放分镜文档，提示词用英文 |
| 人物不对 | 参考图传参格式错（嵌套 dict 被丢弃） | 必须 `ref_images.ref_image_0` 点号写法；角色卡要高分辨率正脸 |
| 桥接进程一停就没 | 用了 `nohup` 而非 `(nohup ... &)` | 见“启动步骤”里的写法 |

---

## 九、已知限制

1. **自有字段只对本地生效**：火宝识别到 Base URL 是本机/8190 时，会自动发送 `resolution_tier` / `aspect_ratio` / `audio_mode`；云端 H3 仍只发官方字段，不会收到这些扩展。
2. **480p 仅本地可选**：云端 H3 只有 `768P`/`2K`；火宝在本地配置下额外开放 480p，同一模型名在多个配置里会带配置名区分。
3. **参考图传参是坑**：ComfyUI 的 autogrow 输入必须点号写法，否则被静默丢弃（本项目踩过整晚）。
4. **预览档偏软**：`quality=preview` 用 4 步 turbo，480p/1080p 都建议切到 `final`（8 步 LoRA）；本地出片优先 720p（1376×768）。
5. **对白含糊**：H3 原生中文语音不清，推荐 `audio_mode=ambient` + 后期 edge-tts + 外挂 SRT；完全不要音轨用 `silent`。
6. **时长会吸附到帧网格**：请求时长取最近的 `5+17k` 帧（24fps，5–362 帧），例如 10 秒实际 10.125 秒；以查询结果回传的 `duration` 为准。
7. **图片桥只有单参考图**：本地 Qwen-Image 走 img2img，没有多图编辑节点；多传的参考图会在响应 `warning` 与 `/health` 中明确说明，不会静默生效。
8. **首尾帧必须成对**：只给尾帧会被后端拒绝；本地有首帧时走 fl2v，尾帧可选。

---

## 十、目录地图

```
local-h3/
├── README.md                 ← 本文件：链路/启动/配置/参数/排障
├── docs/
│   └── 隧道与访问.md          ← SSH 隧道两种建法 + 访问入口一览
├── scripts/                  ← 运行时脚本（拷出来就能跑）
│   ├── shim.py               ← 视频桥 8190（MiniMax v2 协议 → H3 Director）
│   ├── img_shim.py           ← 图片桥 8191（OpenAI Images → Qwen-Image）
│   ├── start.sh              ← 检查隧道 → 校验运行目录 → 起两个桥
│   ├── stop.sh               ← 按 /health pid 或端口精确定位后停桥
│   └── health.sh             ← 全链路体检（隧道/ComfyUI/节点/桥脚本路径/火宝）
├── tests/
│   └── test_shim.py          ← 音频/帧网格/画布/质量档/图片桥/错误提取
├── workflows/                ← ComfyUI 调度与图
│   ├── README.md             ← 图的用途、直接 POST 的方法、4 条注意
│   ├── graphs/               ← 9 个 API 格式 JSON（可直接 POST /prompt）
│   ├── ui-format/            ← 9 个 UI 格式 JSON（ComfyUI 界面「加载」可用）
│   └── scripts/              ← 23 个实验/管线 Python 脚本（生成上述 JSON 的源）
└── experiments/
    └── README.md             ← A/B/C/D + E1–E12 全部实验记录与结论
```

**最常用三条命令**：

```bash
bash scripts/health.sh                    # 体检（含桥接脚本路径校验）
bash scripts/start.sh                     # 起桥（会先检查隧道）
bash scripts/stop.sh                      # 停桥
python3 -m unittest discover -s tests -v  # 桥接纯函数回归
```

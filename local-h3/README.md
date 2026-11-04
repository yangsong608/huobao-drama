# 本地 H3 接入包（huobao ⇄ 自建 ComfyUI + MiniMax H3）

> 火宝按 MiniMax / OpenAI 通用协议直连服务器上的 H3 网关；网关用 Token 鉴权，
> 按业务选择服务器保存的 ComfyUI 工作流并回传签名媒体 URL。
> 不再需要本机桥接脚本与 SSH 隧道。

---

## 一、整体链路

```
火宝桌面端/后端
   │  MiniMax v2（视频）/ OpenAI Images（图片），Bearer Token
   ▼
服务器 8192：h3_gateway.py（systemd: huobao-h3-gateway）
   │  单 GPU worker，串行排队
   ▼
服务器 127.0.0.1:8188：ComfyUI 0.43 + MiniMax H3 / Qwen-Image
   │  workflows/manifest.json → video_t2v / video_fl2v / video_r2v / image_t2i / image_i2i
   ▼
产物写入 /var/lib/huobao-h3-gateway/files，返回 HMAC 签名 URL
```

- ComfyUI 仍只监听服务器本机，不新增公网监听。
- 网关对外只暴露 8192；`/comfyui/*` 是受控反向代理，供火宝的「ComfyUI 模式」使用。
- TTS 仍走独立服务（18190），不经过本网关。

---

## 二、服务与端口

| 服务 | 端口 | 位置 | 作用 |
|---|---|---|---|
| 火宝后端 | 5679 | 本机 | 项目/分镜/任务 API |
| 火宝前端 | 3013（开发） | 本机 | 操作界面 |
| **H3 网关** | **8192** | 服务器 | MiniMax v2 / OpenAI Images → ComfyUI 工作流 |
| ComfyUI | 8188 | 服务器本机 | 出片/出图 |
| TTS | 18190 | 服务器本机 | 独立语音服务，未改动 |

服务器目录：

```
/opt/huobao-h3-gateway/        # 程序 + workflows
/var/lib/huobao-h3-gateway/    # tasks.json + files/
/etc/huobao-h3-gateway.env     # Token / 签名密钥，0600
```

---

## 三、部署与升级

### 首次部署

```bash
# 在仓库根目录执行；install.sh 需要 root
sudo bash local-h3/gateway/deploy/install.sh

# 验证
systemctl status huobao-h3-gateway --no-pager
curl -s http://127.0.0.1:8192/health
curl -s -H "Authorization: Bearer $H3_GATEWAY_TOKEN" http://127.0.0.1:8192/v1/models
```

`install.sh` 会创建 `huobao-h3` 系统用户与数据目录，安装 systemd 单元；
首次写入 env 时用 `secrets` 在服务器本地生成 Token 与签名密钥，**不回显、不写命令行参数**。
已有 env 不会被覆盖。

### 升级

```bash
sudo bash local-h3/gateway/deploy/install.sh
sudo systemctl restart huobao-h3-gateway
```

数据目录不动，进行中的任务由 `tasks.json` 恢复。回滚时恢复上一版 `/opt/...` 后重启即可。

### 网络

- 云安全组/防火墙需放行 8192；建议前置 Nginx/Caddy 终止 TLS，App 配 `https://<域名>`。
- 若直连 8192，至少用安全组限制来源 IP，Token 保持 32 字节以上随机值。
- `H3_PUBLIC_BASE_URL` 可指定签名 URL 的对外前缀；留空时按请求 Host 生成。

---

## 四、火宝里的配置（设置 → AI 服务）

| 类型 | provider | Base URL | API Key | Model | 额外设置 |
|---|---|---|---|---|---|
| **视频** | `minimax` | `http://<H3_HOST>:8192` | 网关 Token | `MiniMax-H3` | 勾选 `h3_gateway` |
| **图片** | `openai` | `http://<H3_HOST>:8192` | 网关 Token | `qwen-image` | 无 |
| 文本 | `openai` | `https://api.deepseek.com` 等 | 自己的 key | 任意 | 无 |

> 视频配置必须勾选 `h3_gateway`：它让火宝发送 `resolution_tier` / `aspect_ratio` /
> `audio_mode` / `quality` 等扩展字段，并允许 480p 与短时长；云端 MiniMax 不会收到这些字段。
>
> 设置页的「测试」会：视频 POST `/v2/video_generation` 空体（不建任务）；
> 图片 GET `/v1/models`。两者都返回 200 即地址与 Token 正确。

---

## 五、接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活；`?deep=1` 需 Token，返回磁盘与任务统计 |
| GET | `/v1/models` | 图片模型列表（需 Token） |
| POST | `/v2/video_generation` | 提交视频任务；空体/无提示词返回 `{"ok":true,"probe":true}`，不建任务 |
| GET | `/v2/query/video_generation/<id>` | 轮询：`task.status` / `task.content.url` / `task.duration` |
| POST | `/v1/images/generations` | 文生图 |
| POST | `/v1/images/edits` | 参考图编辑，multipart `image[]`；只使用第 1 张 |
| GET | `/v1/images/task/<id>` | 图片任务轮询 |
| GET | `/files/<name>?expires=&sig=` | 签名下载，不带 Authorization；默认 1 小时过期 |
| ANY | `/comfyui/*` | ComfyUI 受控代理；Bearer 或 `?token=` |

除 `/health` 与签名 `/files` 外都需要 `Authorization: Bearer <Token>`。

---

## 六、视频参数

| 字段 | 取值 | 说明 |
|---|---|---|
| `duration` | 秒 | 吸附到最近的 `5+17k` 帧网格（5–362 帧，24fps），实际时长以查询回传为准 |
| `resolution` | `480P` / `768P` / `2K` | 官方字段；网关同时接受档位名 |
| `resolution_tier` | `480p` / `720p` / `1080p` | 扩展字段，优先于 `resolution` |
| `aspect_ratio` | `16:9` / `9:16` / `1:1` / `4:3` / `3:4` / `21:9` | 扩展字段；图生视频也按它定画布 |
| `ratio` | 同上 | 官方字段；仅文生视频必填 |
| `audio_mode` | `native` / `ambient` / `silent` | `ambient` 只保留不可辨环境声；`silent` 完全无音轨并要求闭口 |
| `quality` | `preview` / `final` | 4 步 turbo 预览 / 8 步 LoRA 交付，缺省 `preview` |
| `negative_prompt` | 字符串 | 缺省用内置质量兜底词 |
| `seed` | 整数 | 固定种子便于复现 |
| `cfg` | 0.5–5.0 | 缺省 1.0 |
| `content[].role` | `first_frame` / `last_frame` / `reference_image` | 首尾帧成对；有首帧走 fl2v，有参考图走 r2v |

画布换算（短边档位 × 比例，吸附 32 的倍数）：

| 档位 | 16:9 | 9:16 |
|---|---|---|
| 480p | 864×480 | 480×864 |
| 720p | 1376×768 | 768×1376 |
| 1080p | 1920×1088 | 1088×1920 |

参考图上限 9 张，建议单边 ≤1024。火宝会把本地/回环参考图压缩成 data URL 再上传，
服务器与云端都能直接读取。

---

## 七、图片参数

| 字段 | 取值 | 说明 |
|---|---|---|
| `size` | `宽x高` | 8 的倍数，256–2048 |
| `image[]` | multipart 图片 | 参考图；本地 Qwen-Image 只有单图 img2img 通道，只取第 1 张 |
| `response_format` | `url` / `b64_json` | 文生图支持；编辑固定返回 URL |

多传参考图时响应带 `warning`，日志记 `provider-warning`，不静默丢弃。

---

## 八、运维

```bash
# 健康（本机）
curl -s http://127.0.0.1:8192/health
curl -s -H "Authorization: Bearer $H3_GATEWAY_TOKEN" 'http://127.0.0.1:8192/health?deep=1'

# 日志
journalctl -u huobao-h3-gateway -f

# 重启（进行中的任务会恢复）
systemctl restart huobao-h3-gateway

# 测试
cd local-h3/gateway && python3 -m unittest discover -s tests -v
```

- 单 worker 串行执行，队列上限 32；超出直接返回忙。
- 任务与状态落盘 `tasks.json`，网关重启后接管已提交任务。
- 产物默认保留 7 天（`H3_RETENTION_DAYS`），过期清理。
- 环境变量：`H3_GATEWAY_TOKEN`（必需）、`H3_GATEWAY_SIGN_KEY`、`H3_GATEWAY_HOST/PORT`、
  `H3_COMFY_URL`、`H3_DATA_DIR`、`H3_PUBLIC_BASE_URL`、`H3_WORKERS`、`H3_QUEUE_LIMIT`、
  `H3_SIGN_TTL`、`H3_RETENTION_DAYS`、`H3_UPSTREAM_TIMEOUT`。

---

## 九、ComfyUI 模式

设置里新增 ComfyUI 配置：

| 字段 | 值 |
|---|---|
| Base URL | `http://<H3_HOST>:8192/comfyui` |
| API Key | 网关 Token |
| 工作流 | 使用本地保存的工作流 JSON |

火宝拼接 `/view?...` 时会自动带上 `token` 查询参数。代理只放行：
`GET/HEAD /system_stats`、`/history`、`/history/*`、`/view`；`POST /prompt`、`/upload/image`。

---

## 十、排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 | Token 缺失/错误 | 检查设置里的 API Key 与 `/etc/huobao-h3-gateway.env` 一致 |
| `{"error": "... comfy ..."}` / `/health` 里 `comfy.reachable=false` | 服务器 ComfyUI 未启动或 8188 不通 | `curl 127.0.0.1:8188/system_stats`，检查 ComfyUI 服务 |
| 任务失败含 `MiniMaxH3Director` / `CUDA out of memory` | 工作流节点报错/显存不足 | 看 journalctl，降低分辨率或重启 ComfyUI |
| 任务失败 `参考素材不是图片` | 上传内容不是有效图片 | 用 PNG/JPEG/WebP 等真实图片 |
| 签名 URL 403 | 过期或被篡改 | 重新查询任务获取新 URL（默认 1 小时） |
| 画面糊 | preview 4 步 turbo | 质量档切 `final`（8 步 LoRA），优先 720p |
| 出现中文字幕 | 提示词正文含中文 | 中文放分镜文档，提示词用英文 |
| 人物不对 | 参考图缺失或分辨率太低 | 检查角色卡与参考图；单边 ≤1024 压缩后上传 |
| 签名为空的下载地址 | 未配置 `H3_PUBLIC_BASE_URL` 且请求 Host 不可达 | 配置公网域名或反代 |

---

## 十一、已知限制

1. 扩展字段只对勾选 `h3_gateway` 的视频配置生效；云端 H3 仍只发官方字段。
2. 480p 仅本地可选，云端只有 `768P` / `2K`。
3. 图片网关为单参考图（Qwen-Image img2img），多图会在响应里明确 warning。
4. 时长会吸附到 `5+17k` 帧网格，以查询回传 `duration` 为准。
5. H3 原生中文语音不清，推荐 `audio_mode=ambient` + 后期 TTS；完全静音用 `silent`。
6. 单 GPU 串行执行，多人同时出片需要排队。

---

## 十二、目录地图

```
local-h3/
├── README.md                 ← 本文件：链路/部署/配置/接口/排障
├── gateway/
│   ├── h3_gateway.py         ← 网关主程序（Python 标准库）
│   ├── deploy/
│   │   ├── install.sh        ← 安装/升级（生成 Token、装 systemd）
│   │   └── h3-gateway.service
│   ├── workflows/
│   │   ├── manifest.json     ← 业务模式 → 工作流/质量档/音频指令
│   │   ├── video_t2v.json    ← 文生视频
│   │   ├── video_fl2v.json   ← 首尾帧生视频
│   │   ├── video_r2v.json    ← 参考主体生视频
│   │   ├── image_t2i.json    ← 文生图
│   │   └── image_i2i.json    ← 参考图编辑
│   └── tests/test_gateway.py ← 36 项网关回归（画布/时间线/签名/SSRF/恢复）
├── docs/local-tts.md         ← 独立 TTS 服务手册（18190，未改动）
├── workflows/                ← 早期实验工作流与脚本（保留作参考）
├── experiments/              ← A/B 实验记录
└── scripts/                  ← 旧桥接运行时缓存（可删除，不再使用）
```

**最常用三条命令**：

```bash
curl -s http://127.0.0.1:8192/health                     # 网关健康
journalctl -u huobao-h3-gateway -f                       # 网关日志
python3 -m unittest discover -s local-h3/gateway/tests -v # 网关回归
```

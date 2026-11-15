# H3 网关

服务端常驻的 ComfyUI 执行网关。客户端只需要三样东西：**网关地址、API Key、工作流名称**；
工作流本体（ComfyUI API 格式 JSON）保存在网关数据库里，由管理网页维护，不再下发给客户端。

```
客户端 ──(Bearer <API Key>)──> 网关 :8192 ──> ComfyUI :8188
                                   │
                          管理网页 :8193（仅 127.0.0.1，SSH 隧道访问）
                                   │
                              SQLite 数据库
```

## 组成

| 组件 | 说明 |
| --- | --- |
| `h3_gateway.py` | 网关本体，只依赖 Python 标准库；队列顺序执行，任务与产物落盘 |
| `admin/` | 管理端：数据库、ComfyUI 导入转换、FastAPI 网页、CLI |
| `workflows/` | 内置的 MiniMax v2 兼容工作流（旧接口仍保留） |
| `seed/` | 内置命名工作流：E12 整集时间线、Stable Audio Open |
| `deploy/` | systemd 单元与安装脚本 |

## 安装与升级

```bash
sudo ./deploy/install.sh            # 从当前目录安装/升级
```

脚本会：

1. 创建 `huobao-h3` 系统用户与 `/opt/huobao-h3-gateway`、`/var/lib/huobao-h3-gateway`；
2. 首次安装生成 `H3_GATEWAY_TOKEN`、`H3_GATEWAY_SIGN_KEY`、`H3_ADMIN_SECRET`（写入
   `/etc/huobao-h3-gateway.env`，权限 0600，**不回显**）；
3. 创建 `.venv-admin` 并安装 `requirements-admin.txt`；
4. 启动 `huobao-h3-gateway.service`（`:8192`）与 `huobao-h3-admin.service`（`127.0.0.1:8193`）；
5. 首次写入内置工作流 `e12-timeline`、`stable-audio`（已存在的同名 slug 不覆盖）。

首次安装后创建管理员：

```bash
sudo -u huobao-h3 /opt/huobao-h3-gateway/.venv-admin/bin/python -m admin.cli \
  --db /var/lib/huobao-h3-gateway/gateway.db create-admin --username admin
```

## 管理网页

管理端只监听 `127.0.0.1:8193`，通过 SSH 隧道访问：

```bash
ssh -L 8193:127.0.0.1:8193 <服务器>
# 浏览器打开 http://127.0.0.1:8193
```

页面能力：

- **概览**：工作流 / Key / 最近任务统计；
- **ComfyUI 设置**：填写 ComfyUI 地址，一键连通性测试（显示节点数）；
- **工作流**：新建、编辑、启停、删除、校验、试运行；
  **从 ComfyUI 导入**会列出 ComfyUI 中已保存的 UI 工作流（`/userdata`），
  自动转换成 API 格式并预填输入映射，保存后即可被客户端按名称调用；
- **API Key**：创建（完整 Key 只显示一次）、吊销；
- **审计**：登录、配置变更、工作流与 Key 操作记录。

## 客户端 API

除 `/files` 签名下载与 `/comfyui` 代理外，均需 `Authorization: Bearer <API Key>`
（`H3_GATEWAY_TOKEN` 也可用）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/workflows` | 列出启用的工作流（不含工作流 JSON） |
| GET | `/v1/workflows/{slug}` | 单个工作流详情与输入定义 |
| POST | `/v1/jobs` | 按名称提交任务 `{"workflow": "e12-timeline", "inputs": {...}}` |
| GET | `/v1/jobs/{id}` | 查询任务状态与产物 |
| GET | `/v1/jobs?limit=20` | 最近任务 |
| POST | `/v1/jobs/{id}/cancel` | 取消排队中的任务 |
| POST | `/v1/uploads` | 上传参考图（multipart `image`） |

`POST /v1/jobs` 返回：

```json
{"job_id": "…", "id": "…", "status": "queued", "workflow": "e12-timeline"}
```

`GET /v1/jobs/{id}` 返回 `queued / processing / succeeded / failed / cancelled`，
成功时带签名产物地址（`outputs[].url`）。

### 输入映射

管理端为每个工作流维护 `input_map`，客户端提交的 `inputs` 会写进对应节点：

```json
{
  "prompt": {"node": "2", "input": "text", "type": "text"},
  "seconds": {"node": "5", "input": "seconds", "type": "number", "optional": true},
  "seed": {"node": "6", "input": "seed", "type": "integer"}
}
```

一个输入写多个目标时用 `"targets": [{"node": "2", "input": "text"}, …]`。
类型支持 `text / number / integer / boolean / json / image / video`。

视频输入先通过 `POST /v1/uploads` 上传，返回 `{"name": "...", "kind": "video"}`，再把 `name` 作为 `video` 类型输入传给 `/v1/jobs`；也接受视频 data URL 或公网 http(s) 地址。视频大小由 `H3_MAX_VIDEO_BYTES` 和 `H3_MAX_BODY_BYTES` 限制。

### 独立换人实例

`deploy/install-swap.sh` 安装独立的换人网关：

| 项目 | 值 |
|---|---|
| 代理端口 | 8194 |
| 管理端 | 127.0.0.1:8195 |
| ComfyUI | 127.0.0.1:8189 |
| 数据目录 | /data/huobao-h3-gateway-swap |
| 服务名 | huobao-h3-gateway-swap / huobao-h3-admin-swap |

该脚本不修改生产 `/opt/huobao-h3-gateway`、8192、8193 或 8188。

### 换人工作流种子

`install-swap.sh` 会把 `seed/swap/` 复制到 `/opt/huobao-h3-gateway-swap/seed-swap/`，并在首次安装时导入：

| slug | 用途 | 依赖 |
|---|---|---|
| `h3-face-swap` | H3 单脸换脸，单人 | REF2VA 主模型、`SS_FaceSwap_MiniMax_H3_REF2VA.safetensors`、ComfyUI 原生视频栈（LoadVideo/GetVideoComponents/MiniMaxH3ReferenceToVideo），20 步无 Turbo |
| `h3-recast` | H3 Recast 角色替换，单人 | REF2VA 主模型、Turbo 4step、`h3_character_swap_v1.5.safetensors`、ComfyUI 0.43 原生 H3 节点 |
| `h3-recast-relay` | H3 Relay 2.0 长视频角色替换，单人 | ComfyUI-H3Relay、SAM3.1 `sam3.1_multiplex_fp16.safetensors`、`h3_character_swap_v1.5.safetensors`、Turbo 8step、ffmpeg/ffprobe |

种子只登记命名工作流，前端不接触工作流 JSON。FaceSwap 的输入映射为 `source_video`、`reference_face_1`、`prompt`、`seed`；Recast 为 `source_video`、`scene_reference`、`prompt`、`seed`；Relay 为 `source_video`、`scene_reference` 或 `reference_face_1`、`prompt`、`seed`，建议单次 20 秒。视频先走 `/v1/uploads`。

Relay 依赖 8189 内的 `ffmpeg`/`ffprobe`。持久化部署把静态 ffmpeg 与带依赖库的 ffprobe wrapper 放在 `/data/comfyui-whaletrans/ComfyUI/bin`，并在 compose 的 `PATH` 前加入 `/opt/ComfyUI/bin`；容器重建后已用 2 秒 Relay 任务验证。

许可：FaceSwap LoRA 仓库标注 Apache-2.0；Character Swap V1.5 继承 MiniMax H3 Community License（排除欧盟、英国、韩国、美国）；CRT-Nodes 为 MIT；VHS 为 GPL-3.0。部署前需按项目实际使用地域和商用条件复核。

## 旧接口

- `POST /v2/video_generation`、`GET /v2/query/video_generation/<id>`：MiniMax v2 兼容，
  工作流来自 `workflows/manifest.json`；
- `POST /v1/images/generations`、`POST /v1/images/edits`：OpenAI Images 兼容；
- `/comfyui/*`：受控反向代理，仅用于调试。

## CLI

```bash
.venv-admin/bin/python -m admin.cli --db <path> init-db
.venv-admin/bin/python -m admin.cli --db <path> create-admin --username admin
.venv-admin/bin/python -m admin.cli --db <path> reset-password --username admin
.venv-admin/bin/python -m admin.cli --db <path> create-key --name 客户端
.venv-admin/bin/python -m admin.cli --db <path> list-keys
.venv-admin/bin/python -m admin.cli --db <path> seed-workflows
.venv-admin/bin/python -m admin.cli serve --host 127.0.0.1 --port 8193
```

`--db` 缺省读 `H3_DB_PATH`，再缺省 `<gateway>/data/gateway.db`。

## 测试

```bash
python3 -m unittest discover -s tests -v          # 网关 / 数据库 / 导入 / CLI
.venv/bin/python -m unittest tests.test_admin_app # 管理网页（需要 fastapi/httpx）
```

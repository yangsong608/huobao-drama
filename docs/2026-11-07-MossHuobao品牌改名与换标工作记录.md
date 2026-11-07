# MossHuobao 品牌改名与换标工作记录（2026-11-07）

> 分支：`feat/mosshuobao-rebrand`
> 提交：`73b8a56`（本地提交，未推送）
> 范围：品牌名、应用名、安装标识、图标、旧数据迁移、发布脚本与文档
> 状态：源码改造与自动化验证完成；未执行前端 generate、桌面打包、安装与启动（按约定需另行授权）

## 1. 背景与目标

原项目对外品牌为「火宝短剧 / HuobaoDrama」，与代码仓库名 `huobao-drama`、上游服务商「火宝」重名，安装包、应用目录、进程名、更新源标识也全部沿用旧品牌。本次目标是把**产品自身的品牌与安装身份**统一改为 **MossHuobao**，同时不破坏已有用户数据、外部工具契约和上游服务配置。

用户确认的三项决策：

| 决策项 | 结论 |
|---|---|
| 改名范围 | 品牌 + 安装标识（UI 名称、窗口标题、安装包、图标、README、appId，并自动迁移旧 userData） |
| 品牌呈现 | 全语言统一 `MossHuobao`；四种语言的副标题本地化 |
| Logo 方向 | Moss 机械 / AI / 工业 / 太空 方向 |

## 2. 方法：分层改名，兼容优先

没有做全局字符串替换，而是分五层处理，避免把「产品品牌」和「协议/路径/上游品牌」混为一谈：

1. **品牌展示层**：前端标题、页头、四语言文案、README、启动页、诊断脚本。
2. **安装标识层**：`productName`、`appId`、`shortcutName`、安装包文件名、更新包内部 `.app` 名称、启动日志与缓存目录。
3. **图标资产层**：新主图标派生 ICNS / ICO / favicon / 页头 logo。
4. **数据迁移层**：旧 `HuobaoDrama` 用户目录一次性改名为 `MossHuobao`，失败即中止并给出可操作错误，不静默新建空目录。
5. **兼容保留层**：以下标识**刻意不改**，避免破坏已有数据与外部集成：
   - `HUOBAO_*` 环境变量；
   - 数据库文件名 `huobao.sqlite3`；
   - MCP 服务名 `huobao-drama`；
   - npm 包名、GitHub/COS 仓库地址与上传前缀、Docker 镜像名；
   - 上游服务商相关文案「火宝快捷配置 / 火宝 API Key / 火宝云端 MiniMax」。

## 3. 关键实现

### 3.1 用户数据迁移

新增 `desktop/src/user-data.ts`：

- 打包态：`appData/HuobaoDrama` → `appData/MossHuobao`；
- 开发态：`appData/HuobaoDrama-Dev` → `appData/MossHuobao-Dev`，与打包态互不影响；
- 目标目录不存在且旧目录存在时执行 `renameSync`，返回 `migratedFrom`；
- 新旧目录同时存在时保留旧目录作备份，返回 `retainedLegacy`；
- 改名失败抛出包含目标路径的错误，由 `main.ts` 弹窗后退出，不进入空数据状态；
- 文件系统操作可注入，便于测试失败分支。

`desktop/src/main.ts` 在单实例锁之前调用迁移，并把迁移/保留结果写入启动日志。

### 3.2 应用与安装标识

- `desktop/package.json`：`productName`、`description`、`author` 改为 MossHuobao；`name` 保持 `huobao-drama-desktop`。
- `desktop/electron-builder.yml`：`appId: com.mosshuobao.drama`、`productName: MossHuobao`、`shortcutName: MossHuobao`。
- `desktop/src/updater.ts`：临时目录、错误文案、更新包内期望的应用名改为 `MossHuobao.app`。
- `desktop/scripts/publish-release.mjs`、`make-update-feed.mjs`：DMG / ZIP / EXE 产物名改为 `MossHuobao-*`、`MossHuobao Setup *.exe`；COS 前缀与仓库地址不变。
- `desktop/src/runtime-resources.ts`：ProgramData 中文路径回退缓存目录改为 `MossHuobao`。
- `desktop/diagnostics/windows-diagnostics.ps1`、`使用说明.txt`：安装候选目录、进程名、启动日志路径、诊断输出目录全部改为 MossHuobao。
- 启动页、macOS「已损坏」修复脚本、迁移提示弹窗等用户可见文案同步更新。

### 3.3 前端与文案

- `frontend/nuxt.config.ts`：站点标题 `MossHuobao`，favicon 缓存版本 `?v=20261107`。
- `AppHeader.vue`：品牌名、fallback 字母 `M`、副标题走 i18n；品牌渐变改为苔绿到暖橙（`#66906a → #9dbe8a → #e8a33d`）。
- 四语言 `app.title` 统一为 `MossHuobao`，新增 `app.brandSub`：
  - 中文：AI 短剧工坊
  - 英文：AI Drama Studio
  - 日文：AI ドラマスタジオ
  - 韩文：AI 드라마 스튜디오
- 引导页、MCP 描述、小说旧描述中的旧品牌同步更新。

### 3.4 图标

- 用 ImageGen 生成 1024×1024 主图标（苔藓绿 + 机械/太空元素）。
- 生成图右下角带「AI生成」水印，采用 1024px、圆角半径 230 的 alpha 遮罩裁掉四角与水印，圆心保留不透明。
- 由 `desktop/node_modules/sharp` 缩放产出：
  - `desktop/assets/icon.png` 1024×1024
  - `desktop/assets/icon.icns`（`iconutil`，3,479,881 字节）
  - `desktop/assets/icon.ico`（手工按 PNG 组装 7 个尺寸，220,820 字节）
  - `frontend/app/assets/brand-logo.png` 256×256
  - `frontend/app/public/favicon.png` 32×32

## 4. 遇到的问题与处理

| 问题 | 处理 |
|---|---|
| 生成图标带「AI生成」水印 | 圆角 alpha 遮罩裁掉四角与水印；校验四角 alpha=0、圆心 alpha=255 |
| 环境无 PIL | 改用 `sharp`、`iconutil`，ICO 手工组装，未依赖 ImageMagick |
| 启动测试的 fs mock 缺少 `renameSync` | 在 `main-startup.test.mjs` 的 mock 中补 `renameSync() {}`，否则新代码会抛错 |
| 仓库 `desktop/dist/main.js` 是旧构建 | 未获打包授权，改用 esbuild 编译新 `main.ts`/`updater.ts` 到 `/tmp`，复制启动测试指向新 bundle 验证 6/6 通过 |
| 测试时 shell 工作目录残留 | 回到仓库根目录重新执行，避免相对路径与 `desktop/node_modules` 解析失败 |
| `Write` 写 Windows 诊断脚本反复报「未读取」 | 改用 `Edit` 批量替换 token，再做一次定向删除旧小写安装目录候选 |
| README 下载表仍是 4.0.5 旧产物名 | 本次仅做品牌字面更新，版本与链接留到首次发版时统一刷新（见风险 2） |

## 5. 验证证据

| 项目 | 结果 |
|---|---|
| `user-data` + `runtime-resources` TS 测试 | **8/8 通过**（2026-11-07 复跑） |
| 启动测试（仓库旧 dist） | 6/6 通过 |
| 启动测试（esbuild 新 bundle） | 6/6 通过 |
| `esbuild` 编译 `main.ts` / `updater.ts` | 通过 |
| `node --check` 发布脚本 | 通过 |
| 四语言 JSON、`package.json` 解析 | 通过 |
| `git diff --check` | 无空白错误 |
| 图标 | 1024/256/32 PNG、ICNS、7 尺寸 ICO；四角透明、中心不透明 |
| 残余旧品牌扫描 | `HuobaoDrama` 仅存在于迁移常量/注释与对应测试；`火宝` 仅存在于上游服务商快捷配置文案与历史文档 |

## 6. 进度与提交

- 分支在改动前创建：`feat/mosshuobao-rebrand`。
- 本地提交：`73b8a56 feat: 品牌升级为 MossHuobao——新图标、安装标识与旧数据迁移`。
- 变更规模：39 个文件，+342 / −190；新增 `desktop/assets/icon.png`、`desktop/src/user-data.ts`、`desktop/tests/user-data.test.ts`。
- 未推送、未打包、未安装、未启动。
- 说明：`desktop/package.json` 的版本号 `4.0.16` 是本次改动前工作区已有的未提交变更（HEAD 原为 `4.0.14`），随本次提交一并落入；如不希望绑定该版本需单独处理。
- 工作区中与本任务无关的 `docs/superpowers/plans|specs` 修改与未跟踪的 `docs/自测截图/` 未纳入提交。

## 7. 风险与后续

1. **旧版无法自动升级**：`appId` 与更新包内 `.app` 名称都变了，旧客户端即使读到新 feed，也会因找不到 `HuobaoDrama.app` 而失败。旧用户需要**手动安装一次** MossHuobao；首次启动会自动迁移用户数据。可考虑在旧 feed 保留一次桥接版本，或接受一次性人工迁移。
2. **发布前必须重建前端**：`desktop/resources/frontend/` 是 `npm run generate` 的产物（已 gitignore），当前仍是旧标题「火宝短剧」。首次打包前需先执行前端 generate，再打 desktop dist，否则安装包里仍是旧品牌。
3. **README 版本与链接**：下载表仍引用 4.0.5 产物名，改名后需在首次发版时替换为实际 `MossHuobao-*` 文件名与版本号。
4. **旧构建产物残留**：`desktop/release/` 中仍有 `HuobaoDrama.app` / `HuobaoDrama-4.0.16-mac.zip`（已 gitignore），打包前应清理，避免误传或误测。
5. **系统内旧应用残留**：`/Applications/HuobaoDrama.app` 不会自动删除，需要在手动安装新版本后由用户移除。
6. **历史文档不改名**：`docs/` 下既有设计、计划和日志保留原称谓，作为历史记录；仅在需要对外发布时再做统一说明。
7. **分支未推送**：如需评审或合并，需要单独执行 push / PR。

## 8. 文档与文件索引

- 迁移逻辑：[desktop/src/user-data.ts](../desktop/src/user-data.ts)
- 启动接入：[desktop/src/main.ts](../desktop/src/main.ts)
- 迁移测试：[desktop/tests/user-data.test.ts](../desktop/tests/user-data.test.ts)
- 更新器：[desktop/src/updater.ts](../desktop/src/updater.ts)
- 打包配置：[desktop/electron-builder.yml](../desktop/electron-builder.yml)
- 发布脚本：[desktop/scripts/publish-release.mjs](../desktop/scripts/publish-release.mjs)
- 前端页头：[frontend/app/components/AppHeader.vue](../frontend/app/components/AppHeader.vue)
- 语言包：[frontend/app/locales/zh.json](../frontend/app/locales/zh.json)
- 图标资产：`desktop/assets/icon.png|icns|ico`、`frontend/app/assets/brand-logo.png`、`frontend/app/public/favicon.png`
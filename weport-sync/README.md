## 一分钟上手（客户电脑）

交给客户电脑上的 Agent 时，先阅读 [部署清单](../docs/weport-sync-customer-deployment.md)。

```powershell
git clone https://github.com/wuhuqifeila/wechat-export.git weport
cd weport
npm install
npm run build:dir          # 首次构建，约 5-10 分钟；之后不用再跑

npm run sync:setup         # 填服务器地址、上传令牌、微信目录、数据库密钥
npm run sync:chats -- 采购  # 或直接用下一步的界面选
npm run sync:ui            # 浏览器打开 http://127.0.0.1:8799 勾选聊天
```

勾选后，管理员 PowerShell 里注册定时任务：

```powershell
powershell -ExecutionPolicy Bypass -File weport-sync\scripts\install-windows.ps1
```

之后每 5 分钟自动把新消息和附件传到服务器；断网会先存本地，恢复后自动补传。

# weport-sync

把指定的微信群/私聊**增量**导出（含图片、文件附件），每 5 分钟上传到接收服务器。
运行在客户电脑上，读取本机微信数据，只上传你选定的聊天。

```
微信数据库 ──► Weport 引擎（本仓库源码，--cli 模式）
                     │  export.range：单聊天 + 时间窗 + 附件
                     ▼
              weport-sync（本目录）
                 ├─ 本地游标：每个聊天"上次同步到哪一秒"
                 ├─ 待传队列：断网时先落盘，恢复后自动补传
                 └─ 打包上传：tar.gz + SHA-256，按服务器单批上限分卷
                     ▼
             接收服务器 PUT /batches/:batchId
```

## 前置条件

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11（开发验证在 Windows 11） |
| Node.js | 20 或更高（`node --version`） |
| 微信 | 电脑版已登录，且 Weport 已能读到聊天（数据库密钥可用） |
| 本仓库 | 已 clone 并完成一次构建（见下） |

## 首次部署

### 1. 装依赖并构建

在仓库根目录（有 `package.json` 的那层）：

```powershell
npm install
npm run build:dir
```

`build:dir` 会产出 `dist-electron/main.js` 与 `release/` 下的免安装程序；
同步功能只用 `dist-electron`，不需要打安装包。

### 2. 配置同步

```powershell
cd weport-sync
node bin/weport-sync.mjs setup
```

按提示填写：

| 提示 | 说明 |
|---|---|
| Weport 源码目录 | 仓库根目录，脚本会自动识别 |
| 接收服务器地址 | 形如 `https://your-host/wechat-sync`（不含 `/batches`） |
| 上传令牌 | 服务端发放的 Bearer token，只写进本机配置 |
| 微信数据目录 | `xwechat_files` 的路径 |
| 数据库密钥 | 客户电脑上已获取的密钥；只写进本机 Weport 配置，不进同步配置、不上传 |
| 当前 wxid | 可留空，Weport 会自己识别 |

配置写在 `%LOCALAPPDATA%\WeportSync\config.json`（权限 600），
微信账号信息写在 `%LOCALAPPDATA%\WeportSync\profile\Weport-config.json`。

### 3. 选择聊天

图形方式（推荐给客户）：

```powershell
node bin/weport-sync.mjs ui
```

浏览器打开 `http://127.0.0.1:8799`，搜索聊天名 → 勾选 → 保存选择，
还可以在这里改服务器、看待传批次、点"立即同步一次"。

命令行方式：

```powershell
node bin/weport-sync.mjs chats 采购        # 按关键词列聊天
node bin/weport-sync.mjs add "宇驰AGENT"   # 名称必须唯一匹配，否则改用会话ID
node bin/weport-sync.mjs targets
```

### 4. 启用定时同步

管理员 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

默认每 5 分钟运行一次 `once`；可用 `-IntervalMinutes 10` 改间隔，
`-StateDirectory D:\WeportSync` 把状态目录放到别的盘（兼容旧的 `-Home` 参数）。
任务只在安装任务的 Windows 用户登录期间运行，锁屏可运行；注销、休眠和关机期间不运行。
恢复登录后会补扫描中断期间的数据，但微信未同步到本机的数据无法读取。

也可以不用计划任务，改成常驻：

```powershell
node bin/weport-sync.mjs watch
```

> 两者不要同时启用：同步进程有单实例锁，同时运行会有一边直接跳过，但日志会变得难读。

## 日常命令

| 命令 | 用途 |
|---|---|
| `node bin/weport-sync.mjs status` | 每个聊天的游标、待传批次、今日上传量 |
| `node bin/weport-sync.mjs once` | 立刻跑一轮（计划任务用的就是它） |
| `node bin/weport-sync.mjs flush` | 只补传积压批次（忽略退避等待） |
| `node bin/weport-sync.mjs doctor` | 检查引擎、密钥、服务器连通性 |
| `node bin/weport-sync.mjs reset-cursor "宇驰AGENT"` | 重置游标，下次按"首次回看"时长重导 |
| `node bin/weport-sync.mjs remove "宇驰AGENT"` | 从同步清单移除 |

## 同步规则

- **首次范围**：默认本机当天零点至当前时间。需要历史数据时显式选择 `initialWindow: "lookback"`，并设置 `initialLookbackHours`。
- **游标和回查**：游标表示已确认扫描到的时间；每轮回查最近 72 小时，且不早于首次同步的起点。
  同秒晚到消息、回查期内稍后下载的图片/文件可以再次检出。无变化的窗口不会再上传。
  中断超过三天时，从旧游标向前扫描至当前时间，不会直接跳到最近三天。
  超出回查范围才到达的数据需扩大 `reconciliationHours` 或重置游标后明确选择历史范围重新同步；不保证无限期附件补齐。
- **附件**：默认导出图片和文件（单附件上限 `maxFileMb`，默认 5MB）；
  语音、视频默认关闭。超过单批上限的单个附件会跳过，并在批次的 `manifest.skipped` 里注明原因，
  不会截断文件。
- **分卷**：一批超过 `upload.maxBatchBytes`（默认 10MB）时自动切分成多个批次，
  每卷自带 `manifest.json`（`groupId` / `partIndex` / `partCount` / 文件清单与 SHA-256）。
- **断网**：上传失败进入待传队列，按 30s/2m/5m/15m/30m 退避重试；
  重启后继续补传；同一聊天补传完成前不导出新批次，其他聊天不受该聊天的待传批次阻塞。
  401/403/409/413/507 的拒绝批次保留但不自动重试，修复原因后用 `flush --retry-rejected` 显式恢复。
- **去重**：服务器按批次号幂等；同一批次重复上传返回 `duplicate=true`，不会重复保存。
  变化后的回查窗口作为 `payloadMode: "window-snapshot"` 再次上传，可能包含之前传过的消息。
  后续解析端必须按账号、会话及 `sourceIdentityHash`（或源数据库、源表、消息身份组合）合并；不能仅按 localId 去重。
- **本地清理**：已上传批次保留 7 天；未确认上传的批次不自动删除。
  批次总量超过 2GB 时先删除最旧已上传批次；仍超限则停止生成新批次，保留积压供补传。

## 接收服务器接口

同步端只依赖三个行为：

```http
GET  {baseUrl}/health
PUT  {baseUrl}/batches/{batchId}
     Authorization: Bearer <token>
     Content-Type: application/gzip
     X-Content-SHA256: <sha256>
     <gzip 后的 tar 内容>
```

成功回执必须是：

```json
{ "ok": true, "batchId": "…", "sha256": "…", "bytes": 12345, "duplicate": false }
```

失败语义：`401/403` 令牌错误（不重试）；`409` 批次号冲突（不重试）；
`413` 超单批上限（不重试，调小 `maxBatchBytes`）；`507` 服务器空间不足（不重试）；
`5xx/408/429` 视为可重试。

## 目录结构

```
%LOCALAPPDATA%\WeportSync\
  config.json          同步配置（服务器地址、令牌、聊天清单、策略）
  ledger.json          每个聊天的游标与最近成功时间
  profile\             Weport 引擎的独立配置目录（含账号与密钥）
  batches\<groupId>\   批次：export\（原始导出）、part-N.tar.gz、state.json
  logs\sync.log        运行日志（5MB 轮转）
  logs\runs.jsonl      每轮同步的结构化结果
```

## 性能与验证情况

本机实测（Windows 11、微信 PC 4.1.x、728 条消息的群、单次导出一天的消息）：

| 环节 | 实测 |
|---|---|
| 引擎启动 | 1.5-2.7 秒 |
| 单次导出（1 天窗口、31 条消息、无附件） | 约 26-30 秒 |
| 单次导出（1 天窗口、46 条消息、13 张图片 1.9MB） | 约 50 秒，含打包上传 |
| 聊天列表首次读取（751 个会话并解析备注名） | 约 33 秒，之后走 5 分钟缓存 |

导出耗时的大头是打开数据库和按会话建游标，跟窗口长短关系不大。
所以 5 分钟一跑时，单轮大约 30-60 秒；计划任务用"单实例"设置，跑到下一轮不会叠加。

已验证：

- 真实导出指定群（含中文群名、图片附件），压缩包内路径与消息 JSON 可正常解出。
- 断网时导出成功、上传失败，批次留在本地、游标不动；网络恢复后 `flush` 补传成功并自动推进游标。
- 同一批次重复上传，服务端返回 `duplicate=true`，只保存一份。
- 空时间窗（暂无新消息）按正常结束处理：不产生批次，游标推进。

未验证：

- 语音、视频附件（默认关闭，代码按同一路径处理，但没有真实样本跑过）。
- 超大批次（>10MB）自动分卷只做过单元测试，没有真实大文件端到端。
- 客户电脑的实际部署（构建耗时、权限、计划任务策略）需要在客户机上复跑一次。

## 常见问题

**导出的消息数为 0**
游标已经追到当前时刻；等有新消息，或 `reset-cursor` 后重跑。

**提示"所选聊天不存在"**
微信里改了群名或备注：重新执行 `chats` 刷新缓存后 `add`。

**图片是缩略图或缺失**
Weport 只能导出本机已有的图片版本；"尽可能导出"会带上可用版本，
"仅原图"只导出能确认的原图，缺原图的消息会在导出结果里说明原因。

**上传一直失败**
先 `doctor` 看服务器健康检查与令牌；`401` 是令牌问题，`507` 是服务器磁盘不够。

**磁盘空间**
本机按保留策略自动清理；服务器端需要单独配置配额与保留策略。

## 数据与隐私

- 只导出你显式加入清单的聊天，不导出其他会话正文。
- 微信密钥只保存在本机；选定聊天的正文和可用附件随导出包上传到配置的服务器。
- 上传令牌以 600 权限保存在本机配置里，不要提交、截图或外发。
- 本目录不含任何模型调用；接收端如何解析、是否送 AI，属于服务器侧的策略。

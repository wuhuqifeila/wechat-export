# 客户电脑部署 Weport 聊天同步

目标：选定聊天，首次导出今天的数据，之后每五分钟扫描并上传到现有接收端。服务器目前只存原始包，不解析报价、不更新商城价格。

## 交给客户电脑 Agent 的指令

> 在这台 Windows 电脑部署本仓库的 weport-sync。先阅读 AGENTS.md、weport-sync/README.md 和本文件。只同步用户明确选择的聊天，首次范围为今天零点。微信数据库密钥已由用户提供，写入本机独立 profile，不写进仓库或提交记录。完成一次真实上传、检查回执后安装每五分钟的计划任务。不要修改商城生产服务。遇到缺少上传令牌、数据库路径、聊天名称或解密失败时，向用户询问，不猜测。

## 部署前需要的四项输入

1. 客户自己的微信数据目录（xwechat_files）及数据库密钥。
2. 要同步的准确聊天名称；重名时用查询到的会话 ID。
3. 接收端：`https://test-api.sumgg.top/wechat-sync`。
4. 接收端管理员发放的上传令牌。它和微信密钥是两份不同凭证；仓库不包含令牌，不能用数据库密钥代替。

## 安装与构建

使用客户平时运行微信的 Windows 用户。保持 Windows 登录、微信正常同步，关闭自动休眠即可；锁屏不影响任务。电脑一直开机但用户注销时，本方案的任务不会运行。

先安装 Git、Node.js 22 LTS 或更高版本，在 PowerShell 执行：

```powershell
git clone https://github.com/wuhuqifeila/wechat-export.git C:\apps\wechat-export
cd C:\apps\wechat-export
npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
npm run build:dir
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
npm run sync:test
if ($LASTEXITCODE -ne 0) { throw '同步自检失败' }
npm run sync:setup
```

setup 按提示填写服务器、上传令牌、微信目录、数据库密钥。不要将本机或其他客户的 profile 拷到客户机。若原生引擎提示密钥不可用，先在客户机验证 Weport 能读取该账号。

构建阶段下载 Electron 失败，先修复网络；本机 `node_modules/electron/dist` 已完整存在而仅打包下载失败时，可使用：

```powershell
npx electron-builder --dir --publish never "--config.electronDist=node_modules/electron/dist"
```

不要跳过之前的编译失败，也不要修改 native 二进制来绕过运行检查。

## 选择聊天并验证第一批

```powershell
node weport-sync/bin/weport-sync.mjs chats "要同步的聊天名称" --refresh
node weport-sync/bin/weport-sync.mjs add "要同步的聊天名称"
node weport-sync/bin/weport-sync.mjs targets
node weport-sync/bin/weport-sync.mjs doctor
if ($LASTEXITCODE -ne 0) { throw '请修复自检问题' }
npm run sync:once
if ($LASTEXITCODE -ne 0) { throw '同步未全部完成，请检查 status' }
node weport-sync/bin/weport-sync.mjs status
```

也可运行 `npm run sync:ui`，在 `http://127.0.0.1:8799` 选择聊天。页面可以保持打开，读取聊天完成后会释放引擎。

验收时确认：targets 仅包含授权聊天；首批 range.start 是本机今天零点；有消息时批次各分卷均 uploaded、回执 SHA-256 和字节数一致、pendingGroups 为空。无消息只推进扫描游标，不产生空包；可在目标聊天发送一条测试消息，再执行 once 验证。

## 启用每五分钟任务

```powershell
powershell -ExecutionPolicy Bypass -File weport-sync\scripts\install-windows.ps1
Get-ScheduledTaskInfo -TaskName WeportSync
node weport-sync/bin/weport-sync.mjs status
```

如果权限不足，在同一个 Windows 用户下提升 PowerShell 权限后重试。脚本自检失败会停止，不替换已有任务。任务不并发，上一轮没结束会跳过新触发，不中断当前导出；实际频率会受导出耗时影响。

自定义状态目录时，setup、once、ui、status 和任务必须使用同一目录。例如给所有命令添加 `--home D:\WeportSync`，安装时加 `-StateDirectory D:\WeportSync`。默认目录 `%LOCALAPPDATA%\WeportSync`，也支持 `WEPORT_SYNC_HOME`；安装时建议显式指定自定义目录，避免任务读不到临时环境变量。

不要同时运行 watch 常驻进程和计划任务。不要用另一 Windows 用户运行任务，否则可能读不到用户加密的配置。

## 失败处理与恢复

```powershell
node weport-sync/bin/weport-sync.mjs status
Get-Content "$env:LOCALAPPDATA\WeportSync\logs\sync.log" -Tail 50
node weport-sync/bin/weport-sync.mjs flush
# 仅在管理员已修复令牌、配额等拒绝原因后：
node weport-sync/bin/weport-sync.mjs flush --retry-rejected
```

断网或服务器 5xx 会在后续任务补传；401/403/409/413/507 不自动循环重试。只补传不需要启动微信解密引擎。未上传的文件不会因超过十四天被删除；本地超过配置容量时停止拉取新包，先处理积压。

每轮回查最近 72 小时，不早于首次授权起点；这是晚到消息和后下载附件的补采范围，不代表能恢复本机没有的数据。需要更久回查时修改本机 config.json 的 reconciliationHours（1–720）；首次历史回看需明确设置 initialWindow 为 lookback，并设置 initialLookbackHours。已有游标不会因只改首次范围而重置。

## 更新、停用和交接

更新前停止计划任务，等待本轮结束，保留整个状态目录；执行 git pull --ff-only、npm ci、npm run build:dir、npm run sync:test，完成 once 验证后重新安装任务。不要删除 ledger.json 或 batches 来“修复”上传错误。

停用：`powershell -ExecutionPolicy Bypass -File weport-sync\scripts\uninstall-windows.ps1`，默认保留状态和待传文件。无需卸载微信。

交接验收记录只记提交号、聊天数量、首批消息/附件数量、批次号、校验结果、任务名称和上次运行时间；不要复制数据库密钥、上传令牌或聊天正文到文档。

## 服务端后续接入约定

接收端只存 tar.gz。批次 manifest.schemaVersion 为 2，payloadMode 为 window-snapshot；同一窗口变化后可能再次包含已传消息。解析报价前必须按账号/会话/源消息身份去重合并，保持原始批次可追溯。附件只包含本机可用且未超过配置上限的版本，不能把“上传成功”等同于“所有原图已齐全”。

本机测试不能替代客户电脑验收。请在客户机补验：一次真实上传、五分钟任务自动触发、锁屏运行、断网恢复、同一目标收到新消息后的上传。

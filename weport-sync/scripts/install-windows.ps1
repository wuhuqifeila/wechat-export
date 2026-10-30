<#
  在客户电脑上注册"每 5 分钟同步一次"的计划任务。

  计划任务在同一 Windows 用户保持登录时运行，锁屏可用，注销/休眠期间不运行。
  恢复登录后可补跑，
  每次运行都会先补传积压批次，再拉新消息。

  用法（管理员 PowerShell）：
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -IntervalMinutes 10 -Home "D:\WeportSync"
#>
param(
  [ValidateRange(1,1440)][int]$IntervalMinutes = 5,
  [Alias('Home')][string]$StateDirectory = "",
  [string]$TaskName = "WeportSync"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$entry = Join-Path $repo "bin\weport-sync.mjs"
if (-not (Test-Path $entry)) { throw "找不到同步入口：$entry，请在 weport-sync 目录里运行本脚本" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "没有找到 Node.js，请先安装 Node.js 20 或更高版本" }
$nodeVersion = (& $node --version) -replace "v", ""
if ([int]($nodeVersion.Split(".")[0]) -lt 20) { throw "Node.js 版本过低（$nodeVersion），需要 20 或更高" }

$arguments = "`"$entry`" once"
if ($StateDirectory) { $arguments += " --home `"$StateDirectory`"" }

Write-Host "Node：$node"
Write-Host "入口：$entry"
Write-Host "间隔：每 $IntervalMinutes 分钟"

# 先做一次 dry check：配置不完整时立刻告诉用户，而不是等计划任务静默失败
$doctorArguments = @($entry, 'doctor')
if ($StateDirectory) { $doctorArguments += @('--home', $StateDirectory) }
& $node @doctorArguments
if ($LASTEXITCODE -ne 0) { throw "doctor 检查失败，未更改计划任务，请先修复配置" }

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已注册计划任务：$TaskName（登录后每 $IntervalMinutes 分钟运行一次）"

try {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "已触发一次，稍后可用下面的命令查看结果："
} catch {
  Write-Warning "触发失败：$($_.Exception.Message)"
}
$statusArguments = $arguments.Replace(' once', ' status')
Write-Host "  node $statusArguments"
Write-Host "  Get-ScheduledTaskInfo -TaskName $TaskName"

param(
  [string]$TaskName = "WeportSync",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "已移除计划任务：$TaskName"

if ($RemoveData) {
  $home = if ($env:WEPORT_SYNC_HOME) { $env:WEPORT_SYNC_HOME } else { Join-Path $env:LOCALAPPDATA "WeportSync" }
  if (Test-Path $home) {
    Write-Host "删除本机同步数据：$home"
    Remove-Item -Recurse -Force $home
  }
  Write-Host "同步配置、游标和待传批次已删除"
} else {
  Write-Host "保留了同步配置、游标和待传批次；要一起删除请加 -RemoveData"
}

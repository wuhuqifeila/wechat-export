param(
  [string]$TaskName = "WeportSync",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "已移除计划任务：$TaskName"

if ($RemoveData) {
  $stateDirectory = if ($env:WEPORT_SYNC_HOME) { $env:WEPORT_SYNC_HOME } else { Join-Path $env:LOCALAPPDATA "WeportSync" }
  $resolvedDirectory = [System.IO.Path]::GetFullPath($stateDirectory)
  if ((Split-Path -Leaf $resolvedDirectory) -ne 'WeportSync') { throw '自动删除仅限名为 WeportSync 的状态目录，自定义目录请人工核对后处理' }
  if (Test-Path -LiteralPath $resolvedDirectory) {
    Write-Host "删除本机同步数据：$resolvedDirectory"
    Remove-Item -Recurse -Force -LiteralPath $resolvedDirectory
  }
  Write-Host "同步配置、游标和待传批次已删除"
} else {
  Write-Host "保留了同步配置、游标和待传批次；要一起删除请加 -RemoveData"
}

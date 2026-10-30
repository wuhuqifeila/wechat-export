#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import {
  addTargets,
  doctor,
  flushOnly,
  listChats,
  parseArgs,
  removeTargets,
  resetCursor,
  runSyncOnce,
  runWatch,
  setup,
  showStatus,
} from '../src/cli.mjs'
import { stateHome } from '../src/paths.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const options = parseArgs(argv)
const command = options._[0] || 'help'
const home = options.home ? path.resolve(String(options.home)) : stateHome()

function help() {
  console.log(`weport-sync ${pkg.version}

用法：node weport-sync.mjs <命令> [参数]

  setup        配置服务器、账号与微信数据目录（写入本机 Weport 配置）
  doctor       检查 Node、tar、配置、引擎、接收服务是否可用
  chats [词]   列出聊天；可带关键词过滤，--json 输出结构化结果
  add <名称…>  把聊天加入同步清单（名称必须唯一匹配，或用会话ID）
  remove <…>   从同步清单移除
  targets      查看同步清单
  once         立即执行一轮增量同步（适合计划任务）
  watch        常驻运行，按间隔循环同步
  flush        只补传积压批次；修复拒绝原因后加 --retry-rejected 恢复拒绝批次
  status       查看游标、待上传批次与今日上传量
  ui           打开本地网页控制台（选聊天、看状态、立即同步）
  reset-cursor <名称…>  重置这些聊天的游标（下次按首次范围重导，默认今天）

通用参数：
  --home <目录>   指定状态目录（默认 %LOCALAPPDATA%\\WeportSync）
  --json          以 JSON 输出（chats/status 支持）
  --refresh       忽略会话缓存，重新读取
`)
}

try {
  switch (command) {
    case 'setup':
      await setup(options, home)
      break
    case 'doctor':
      if ((await doctor(home)).problems.length) process.exitCode = 1
      break
    case 'chats':
      await listChats(options, home)
      break
    case 'add':
      await addTargets(options, home)
      break
    case 'remove':
      await removeTargets(options, home)
      break
    case 'targets': {
      const status = await showStatus(home)
      if (!status.targets.length) console.log('同步清单为空，先执行 add 或在 ui 里勾选')
      break
    }
    case 'once':
      if (!(await runSyncOnce(home)).ok) process.exitCode = 1
      break
    case 'watch':
      await runWatch(home)
      break
    case 'flush':
      { const result = await flushOnly(home, { retryRejected: Boolean(options['retry-rejected']) }); if (result.failed || result.remaining) process.exitCode = 1 }
      break
    case 'status':
      await showStatus(home)
      break
    case 'reset-cursor':
      await resetCursor(options._.slice(1), home)
      break
    case 'ui': {
      const { startUi } = await import('../src/ui.mjs')
      await startUi({ home, port: Number(options.port) || 8799 })
      break
    }
    case 'version':
    case '--version':
      console.log(pkg.version)
      break
    case 'help':
    case '--help':
    case '-h':
      help()
      break
    default:
      help()
      process.exitCode = 2
  }
} catch (error) {
  console.error(`错误：${error.message}`)
  process.exitCode = 1
}

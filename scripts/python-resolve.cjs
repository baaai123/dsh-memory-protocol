'use strict'
// 共享的 python 解释器解析——bootstrap 与 memory-mcp 入口共用，保证两边一致。
// 1. MEMORY_SKILL_PYTHON 显式指定优先
// 2. 平台候选：Windows 的 `python3` 常是 Store stub，依次探测 python3 → python → py
const { spawnSync } = require('node:child_process')

function resolvePython() {
  if (process.env.MEMORY_SKILL_PYTHON) return process.env.MEMORY_SKILL_PYTHON
  const candidates = process.platform === 'win32' ? ['python3', 'python', 'py'] : ['python3', 'python']
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    if (r.status === 0) return c
  }
  return 'python3' // 全部失败兜底，让后续错误提示自然暴露
}

module.exports = { resolvePython }

'use strict'
// memory-mcp 启动入口：先用共享逻辑解析真实 python（避免裸 python3 被 PATH
// 劫持到 conda/venv/WindowsApps stub），再透传 stdio 启动 MCP server。
// 本进程只做解析 + 转发，不打印任何内容到 stdout（MCP JSON-RPC 纯净性）。
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { resolvePython } = require('./python-resolve.cjs')

// 未显式指定 DB 时落到用户目录固定位置(而非相对 cwd 的 "memory.db")——
// 否则进程工作目录(如 dsh web 启动目录)会被误建 memory.db/chroma。
if (!process.env.MEMORY_SKILL_DB_PATH) {
  const dir = path.join(os.homedir(), '.memory-skill')
  fs.mkdirSync(dir, { recursive: true })
  process.env.MEMORY_SKILL_DB_PATH = path.join(dir, 'memory.db')
}

const python = resolvePython()
const child = spawn(python, ['-m', 'memory_skill.mcp_server'], {
  stdio: 'inherit',
  env: process.env,
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))

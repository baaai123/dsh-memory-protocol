'use strict'
// memory-mcp 启动入口：先用共享逻辑解析真实 python（避免裸 python3 被 PATH
// 劫持到 conda/venv/WindowsApps stub），再透传 stdio 启动 MCP server。
// 本进程只做解析 + 转发，不打印任何内容到 stdout（MCP JSON-RPC 纯净性）。
const { spawn } = require('node:child_process')
const { resolvePython } = require('./python-resolve.cjs')

const python = resolvePython()
const child = spawn(python, ['-m', 'memory_skill.mcp_server'], {
  stdio: 'inherit',
  env: process.env,
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig))
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))

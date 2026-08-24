#!/usr/bin/env node
/**
 * memory-protocol bootstrap — ensure the Python MCP server deps and the ONNX
 * embedding model exist, then exit. This is a one-shot setup helper; the MCP
 * server itself is started separately by cordis (python3 -m memory_skill.mcp_server).
 *
 * Fail-open by design: every path exits 0, all output goes to stderr, and
 * every step is wrapped so a failure never crashes the parent plugin.
 *
 * Env knobs:
 *   MEMORY_SKIP_BOOTSTRAP=1  skip everything
 *   MEMORY_SKILL_PYTHON      python interpreter (default: python3)
 *   MEMORY_SKILL_DIR         base dir for the model (default: process.cwd())
 *   MEMORY_SKIP_INSTALL=1    skip the pip install step
 *   MEMORY_SKIP_MODEL=1      skip the model download step
 *   MEMORY_MODEL_PATH        exact model dir (download skipped if model.onnx present)
 *   HF_ENDPOINT              huggingface_hub endpoint; hf-mirror.com fallback on failure
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const log = (...args) => console.error('[memory-bootstrap]', ...args)

const PY = process.env.MEMORY_SKILL_PYTHON ?? 'python3'
const MODEL_ID = 'BAAI/bge-large-en-v1.5'
const MODEL_DIR =
  process.env.MEMORY_MODEL_PATH ??
  path.join(process.env.MEMORY_SKILL_DIR ?? process.cwd(), 'models', 'bge-large-en-v1.5')

try {
  main()
} catch (error) {
  log('bootstrap crashed (fail-open, continuing):', error && error.stack ? error.stack : String(error))
}
process.exit(0)

function main() {
  if (process.env.MEMORY_SKIP_BOOTSTRAP === '1') {
    log('skipped (MEMORY_SKIP_BOOTSTRAP=1)')
    return
  }
  if (process.env.MEMORY_SKIP_INSTALL !== '1') installMemorySkill()
  if (process.env.MEMORY_SKIP_MODEL !== '1') ensureModel()
  log('bootstrap finished (fail-open: always exit 0)')
}

// pip 安装参数：venv 里 --user 被禁止（"User site-packages are not visible in
// this virtualenv"），系统 python 里 --user 避免权限问题。按解释器类型决定。
function pipInstallArgs() {
  const probe = spawnSync(PY, ['-c', 'import sys; print(sys.prefix != sys.base_prefix)'], {
    stdio: ['ignore', 'pipe', process.stderr],
  })
  const isVenv = probe.stdout && probe.stdout.toString().trim() === 'True'
  return isVenv ? ['-m', 'pip', 'install'] : ['-m', 'pip', 'install', '--user']
}

function installMemorySkill() {
  const check = spawnSync(PY, ['-c', 'import memory_skill'], {
    stdio: ['ignore', process.stderr, process.stderr],
  })
  if (check.status === 0) {
    log('memory-skill already installed, skipping pip install')
    return
  }
  const args = pipInstallArgs()
  log(`installing memory-skill via: ${PY} ${args.join(' ')} ...`)
  const result = spawnSync(
    PY,
    [...args, 'memory-skill[onnx]', 'optimum[onnxruntime]', 'huggingface_hub'],
    { stdio: ['ignore', process.stderr, process.stderr] },
  )
  if (result.status !== 0) {
    log('====================================================================')
    log('!! pip install FAILED. Manual fix:')
    log(`   ${PY} ${args.join(' ')} "memory-skill[onnx]" "optimum[onnxruntime]" huggingface_hub`)
    log('====================================================================')
    return
  }
  log('pip install complete')
}

function hasModel() {
  return (
    existsSync(path.join(MODEL_DIR, 'model.onnx')) ||
    existsSync(path.join(MODEL_DIR, 'onnx', 'model.onnx'))
  )
}

function ensureModel() {
  if (hasModel()) {
    log(`model already present (${MODEL_DIR})`)
    return
  }
  mkdirSync(MODEL_DIR, { recursive: true })
  log(`downloading ${MODEL_ID} -> ${MODEL_DIR} ...`)
  const snippet = modelSnippet()
  const attempt = (extraEnv) =>
    spawnSync(PY, ['-'], {
      input: snippet,
      stdio: ['pipe', process.stderr, process.stderr],
      env: { ...process.env, ...extraEnv },
    })
  let result = attempt({})
  if (result.status !== 0) {
    log(`download/convert failed (exit ${result.status}); retrying with HF_ENDPOINT=https://hf-mirror.com ...`)
    result = attempt({ HF_ENDPOINT: 'https://hf-mirror.com' })
    if (result.status !== 0) {
      log('====================================================================')
      log('!! model download FAILED. Manual fix:')
      log(`   HF_ENDPOINT=https://hf-mirror.com ${PY} -c "from huggingface_hub import snapshot_download; snapshot_download('${MODEL_ID}', local_dir='${MODEL_DIR}')"`)
      log(`   ${PY} -m optimum.onnxruntime --model ${MODEL_DIR} --task feature-extraction ${MODEL_DIR}`)
      log('====================================================================')
    }
  }
}

function modelSnippet() {
  const target = JSON.stringify(MODEL_DIR)
  return `import os, subprocess, sys
from pathlib import Path

def log(msg):
    sys.stderr.write('[memory-bootstrap] ' + msg + '\\n')

log('HF endpoint: ' + os.environ.get('HF_ENDPOINT', 'https://huggingface.co'))

try:
    from huggingface_hub import snapshot_download
except ImportError:
    log('huggingface_hub not installed; run: pip install "optimum[onnxruntime]" huggingface_hub')
    sys.exit(2)

target = ${target}
Path(target).mkdir(parents=True, exist_ok=True)
snapshot_download('${MODEL_ID}', local_dir=target)

if not (Path(target) / 'model.onnx').exists() and not (Path(target) / 'onnx' / 'model.onnx').exists():
    log('converting to ONNX via optimum ...')
    try:
        import optimum  # noqa: F401
    except ImportError:
        log('optimum not installed; run: pip install "optimum[onnxruntime]" huggingface_hub')
        sys.exit(2)
    sys.exit(subprocess.run([sys.executable, '-m', 'optimum.onnxruntime', '--model', target, '--task', 'feature-extraction', target]).returncode)

log('model ready at ' + target)
`
}

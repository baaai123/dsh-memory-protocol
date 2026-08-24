/**
 * Memory protocol enforcement plugin.
 *
 * Mirrors the opencode-side `solo-memory` hard protocol on DeepSeek Harness:
 *
 * 1. Force `memory_weave` once per agent turn before any non-memory tool may run.
 *    `tools/pre-execute` denies every tool call while the turn's weave is pending;
 *    the memory tools themselves (`mcp__opencode_memory__*`) are whitelisted so the
 *    weave can actually happen.
 * 2. Auto-inject the weave context into the first step of each turn via
 *    `agent/pre-step`, so the model sees the relevant memory without asking.
 * 3. Auto-ingest the completed turn at `agent/turn-stopping` from the buffered
 *    `session/event` stream, so every dialogue block is persisted without the
 *    model having to call the tool itself.
 * 4. Fail-open when the memory MCP tools are missing (a marketplace install
 *    that skipped the Python side): the gate passes instead of paralyzing the
 *    agent, a one-time loud guidance is surfaced, and the bootstrap script
 *    (scripts/bootstrap-memory.mjs) is spawned once to install the Python deps
 *    + embedding model. Strict mode resumes automatically the moment the
 *    tools register.
 *
 * The memory MCP server is reached through the registered MCP-bridged tools
 * (`ctx.tools.execute({ name: 'mcp__opencode_memory__memory_weave', ... })`), so this
 * plugin has no direct dependency on the Python server; it only requires the
 * `mcp__opencode_memory__` tools to be present (mounted via the mcp-client overlay).
 *
 * @module @deepseek-ai/dsh-memory-protocol
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** MCP-bridged tool name prefix for the opencode memory server. */
const MCP_PREFIX = 'mcp__opencode_memory__'

/** Raw tool names the protocol must allow through (the memory tools themselves). */
const MEMORY_TOOL_NAMES = new Set([
  'memory_weave',
  'memory_ingest',
  'memory_status',
  'memory_search',
  'memory_feedback',
  'memory_classify',
  'memory_teach_skill',
  'memory_update_skill',
  'memory_check_skill',
  'memory_learning_queue',
  'memory_learning_mark',
  'memory_distill',
  'memory_pending',
  'memory_pending_mark',
  'memory_conclusions',
])

/** Message source marking protocol-injected context as plugin-owned (log-rebuildable). */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'memory-protocol' }

/** One-time guidance surfaced when the memory MCP tools are missing. */
const MISSING_TOOLS_GUIDANCE =
  'memory-protocol: memory MCP tools NOT registered (python3 -m memory_skill.mcp_server unavailable). ' +
  'Fix: pip install "memory-skill[onnx]" + download bge-large-en-v1.5 (auto-bootstrap does this; ' +
  'set MEMORY_SKIP_BOOTSTRAP=1 to disable), or set MEMORY_SKILL_PYTHON to the right interpreter. ' +
  'Agent is running WITHOUT memory until the tools appear.'

// Fail-open bootstrap state — module-level, so each surface fires once per process.
let warnedMissing = false // logger.warn guidance emitted once while tools are missing
let guidanceInjected = false // guidance user-message injected once
let bootstrapSpawned = false // bootstrap script spawned at most once
let resumedLogged = false // transition log once when tools come back

/**
 * Per-agent protocol state: whether the CURRENT turn has already run its weave.
 * Reset to `false` at `agent/turn-stopping` so a fresh turn must weave again.
 */
const weavedThisTurn = new WeakMap<Agent, boolean>()

/** Per-session buffered text of user/assistant messages, flushed at turn-stopping. */
const turnBuffers = new WeakMap<Session, string[]>()

/** Returns true when the tool name is one of the memory protocol's own tools. */
function isMemoryTool(name: string): boolean {
  if (!name.startsWith(MCP_PREFIX)) return false
  return MEMORY_TOOL_NAMES.has(name.slice(MCP_PREFIX.length))
}

/** The MCP-bridged public name for a raw memory tool name. */
function memoryTool(raw: string): string {
  return `${MCP_PREFIX}${raw}`
}

/**
 * Dynamic check: memory tools may register after apply (MCP connect, restart,
 * reconnect), so this must be evaluated per hook invocation, never cached.
 */
function memoryToolsAvailable(ctx: Context): boolean {
  return ctx.tools.get(memoryTool('memory_weave')) !== undefined
}

/** Emit the loud missing-tools guidance to the log, at most once per process. */
function warnMissingOnce(ctx: Context): void {
  if (warnedMissing) return
  warnedMissing = true
  ctx.logger.warn(MISSING_TOOLS_GUIDANCE)
}

/** Log the missing → present transition once (strict gate resumes). */
function noteResumedOnce(ctx: Context): void {
  if (!warnedMissing || resumedLogged) return
  resumedLogged = true
  ctx.logger.warn('memory-protocol: memory MCP tools registered — strict gate resumed')
}

/**
 * Spawn the bootstrap script (pip install + model download) at most once per
 * process, non-blocking. A spawn failure must never throw out of a hook.
 */
function maybeSpawnBootstrap(ctx: Context, config: Config): void {
  if (bootstrapSpawned) return
  bootstrapSpawned = true
  try {
    const script = fileURLToPath(new URL('../scripts/bootstrap-memory.mjs', import.meta.url))
    spawn(process.execPath, [script], { detached: false, stdio: 'inherit', env: process.env })
    ctx.logger.warn('memory-protocol: bootstrap started — pip install + model download; restart dsh after it completes to mount the MCP server')
  } catch (error) {
    ctx.logger.warn(`memory-protocol: bootstrap spawn failed: ${String(error)}`)
  }
}

/** Invoke a memory MCP tool through the registered ToolRuntime. */
async function callMemoryTool(
  ctx: Context,
  agent: Agent | undefined,
  signal: AbortSignal,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const input: ToolExecutionInput = {
    callId: CallId(`memory-protocol-${name}-${Math.random().toString(16).slice(2, 10)}`),
    name: `${MCP_PREFIX}${name}`,
    arguments: args,
    signal,
    ...(agent === undefined ? {} : { agent }),
  }
  const result = await ctx.tools.execute(input)
  if (result.isError) {
    throw new Error(`memory tool ${name} failed: ${String(result.error)}`)
  }
  return result.value
}

/** Extract the model-visible text from the weave result (string, block array, or object). */
function weaveContextText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((block) => (block && typeof block === 'object' ? (block as { text?: unknown }).text : ''))
      .filter((text): text is string => typeof text === 'string')
      .join('\n')
  }
  if (value && typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
    const context = (value as { context?: unknown }).context
    if (typeof context === 'string') return context
    if (Array.isArray(context)) {
      return context
        .map((block) => (block && typeof block === 'object' ? (block as { text?: unknown }).text : ''))
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    }
  }
  return ''
}

/** Append one session event's text to its turn buffer. */
function bufferEventText(session: Session, event: SessionEvent): void {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return
  const data = event.data as { message?: { content?: Array<{ type: string; text?: string }> } }
  const content = data.message?.content ?? []
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  if (!text.trim()) return
  const buffer = turnBuffers.get(session) ?? []
  buffer.push(text)
  turnBuffers.set(session, buffer)
}

export const name = 'memory-protocol'
export const inject = ['tools']

export interface Config {
  /** Hard-deny tool calls while the turn's weave is pending. Default true. */
  enforceWeave: boolean
  /** Auto-inject the weave context into the first step of each turn. Default true. */
  injectWeave: boolean
  /** Auto-ingest each completed turn at turn-stopping. Default true. */
  autoIngest: boolean
  /** Additional tool names exempt from the weave gate. Default []. */
  allowlist: string[]
  /**
   * Fail-open when the memory MCP tools are missing: the gate passes, no
   * auto-weave/ingest is attempted, and a one-time loud guidance is surfaced.
   * Strict behavior is unchanged whenever the tools ARE present. Default true.
   */
  bootFailOpen: boolean
  /** Auto-run scripts/bootstrap-memory.mjs (once per process) when the tools are missing. Default true. */
  autoBootstrap: boolean
}

export const Config: Schema<Config> = Schema.object({
  enforceWeave: Schema.boolean().default(true),
  injectWeave: Schema.boolean().default(true),
  autoIngest: Schema.boolean().default(true),
  allowlist: Schema.array(Schema.string()).default([]),
  bootFailOpen: Schema.boolean().default(true),
  autoBootstrap: Schema.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const allow = new Set(config.allowlist)
  const bufferingAgents = new WeakSet<Agent>()

  // session/event is scope-filtered to the agent's own context, so the buffer
  // listener must live on agent.ctx, not the root ctx. Register once per agent
  // on first sight so user/assistant text is captured for turn ingest.
  function ensureBuffering(agent: Agent): void {
    if (bufferingAgents.has(agent)) return
    bufferingAgents.add(agent)
    agent.ctx.on('session/event', (session, event) => {
      bufferEventText(session, event)
    })
  }

  // tools/pre-execute: the protocol gate. Deny non-memory tools while the
  // current turn's weave is still pending.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    if (memoryToolsAvailable(ctx)) noteResumedOnce(ctx)
    if (exec.name === memoryTool('memory_weave')) {
      // An explicit model-driven weave also satisfies the gate for this turn.
      if (exec.agent) weavedThisTurn.set(exec.agent, true)
      return next()
    }
    if (isMemoryTool(exec.name) || allow.has(exec.name)) return next()
    const agent = exec.agent
    if (agent !== undefined && weavedThisTurn.get(agent)) return next()
    // Fail-open: without the memory tools the gate can never be satisfied —
    // let every non-memory tool through and surface the guidance once.
    if (config.bootFailOpen && !memoryToolsAvailable(ctx)) {
      warnMissingOnce(ctx)
      return next()
    }
    if (!config.enforceWeave) return next()
    return {
      kind: 'deny',
      reason:
        'Memory protocol: call mcp__opencode_memory__memory_weave first, ' +
        'then retry this tool. Every turn must consult memory before acting.',
    }
  })

  // agent/pre-step: weave once per turn and inject the context into the step.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    ensureBuffering(agent)
    // The first pre-step sees the turn's user messages; the session/event
    // listener (registered just above) only captures events after this point,
    // so seed the buffer with the user text to guarantee it is ingested.
    const session = agent.session
    const buffer = turnBuffers.get(session) ?? []
    if (buffer.length === 0) {
      const userText = messages
        .map((message) =>
          message.content
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text?: string }).text ?? '')
            .join(' '),
        )
        .filter(Boolean)
        .join('\n')
      if (userText) {
        buffer.push(userText)
        turnBuffers.set(session, buffer)
      }
    }
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    if (weavedThisTurn.get(agent)) return downstream

    if (!memoryToolsAvailable(ctx)) {
      if (config.bootFailOpen) {
        // Fail-open: skip the auto-weave branch entirely, spawn the bootstrap
        // once, and inject a one-time guidance message. The gate is open, so
        // weavedThisTurn is deliberately left unset.
        if (config.autoBootstrap) maybeSpawnBootstrap(ctx, config)
        if (!guidanceInjected) {
          guidanceInjected = true
          const injected = createUserMessage({
            content: [{ type: 'text', text: MISSING_TOOLS_GUIDANCE }],
            source: { ...PLUGIN_SOURCE, form: 'instructions' },
          })
          return { kind: 'enter', messages: [injected, ...downstream.messages] }
        }
        return downstream
      }
      if (config.injectWeave) {
        // Fail-closed: the gate stays closed until the tools appear.
        ctx.logger.warn('memory-protocol: memory_weave tool not registered yet; protocol gate stays closed')
      }
      return downstream
    }

    if (!config.injectWeave) {
      // Without auto-weave the gate stays closed until the model weaves on its own.
      return downstream
    }

    const userText = messages
      .map((message) =>
        message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text?: string }).text ?? '')
          .join(' '),
      )
      .join('\n')
      .slice(0, 2000)
    let context = ''
    try {
      const value = await callMemoryTool(ctx, agent, signal, 'memory_weave', { user_message: userText })
      context = weaveContextText(value)
    } catch (error) {
      // Fail-closed: a failed weave leaves the gate closed; the model must retry.
      ctx.logger.warn(`memory-protocol: memory_weave failed: ${String(error)}`)
      return downstream
    }
    if (!context) {
      // A successful but empty weave still counts as having consulted memory.
      weavedThisTurn.set(agent, true)
      return downstream
    }
    weavedThisTurn.set(agent, true)
    const injected = createUserMessage({
      content: [{ type: 'text', text: context.slice(0, 8000) }],
      source: { ...PLUGIN_SOURCE, form: 'instructions' },
    })
    return { kind: 'enter', messages: [injected, ...downstream.messages] }
  })

  // agent/turn-stopping: ingest the finished turn and reset the weave gate.
  ctx.on('agent/turn-stopping', async ({ agent }): Promise<void> => {
    weavedThisTurn.set(agent, false)
    if (!config.autoIngest) return
    const session = agent.session
    if (!memoryToolsAvailable(ctx)) {
      // No tools to call — drop this turn's buffer instead of ingesting.
      turnBuffers.delete(session)
      return
    }
    const buffer = turnBuffers.get(session) ?? []
    turnBuffers.delete(session)
    if (buffer.length === 0) return
    const text = buffer.join('\n\n').slice(0, 4000)
    try {
      await callMemoryTool(ctx, agent, new AbortController().signal, 'memory_ingest', { content: text, role: 'user' })
    } catch {
      // A failed ingest must not block the turn from closing.
    }
  })
}

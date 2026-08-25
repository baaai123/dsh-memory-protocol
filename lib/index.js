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
import Schema from '@deepseek-ai/schemastery';
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
/** MCP-bridged tool name prefix for the opencode memory server. */
const MCP_PREFIX = 'mcp__opencode_memory__';
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
]);
/** Message source marking protocol-injected context as plugin-owned (log-rebuildable). */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'memory-protocol' };
/** One-time guidance surfaced when the memory MCP tools are missing. */
const MISSING_TOOLS_GUIDANCE = 'memory-protocol: memory MCP tools NOT registered (python3 -m memory_skill.mcp_server unavailable). ' +
    'Fix: pip install "memory-skill[onnx]" + download bge-large-en-v1.5 (auto-bootstrap does this; ' +
    'set MEMORY_SKIP_BOOTSTRAP=1 to disable), or set MEMORY_SKILL_PYTHON to the right interpreter ' +
    '(Windows: point it at the real python.exe, e.g. D:\\Python\\Python313\\python.exe). ' +
    'Agent is running WITHOUT memory until the tools appear.';
/** One-time activation card injected once the memory tools ARE registered. */
const ACTIVATION_GUIDANCE = '[memory-protocol] 记忆系统已激活（memory_weave 等 15 个工具可用）。\n' +
    '• 状态/详情: 调 memory_status 查看（embedder 模式、库位置、记忆条目数）。\n' +
    '• 每轮协议: 回复前调 memory_weave(user_message=<当前用户消息>, assistant_content=<你上一轮回复原文>)，返回 8 块上下文（偏好/任务/技能/检索记忆/指令区）。\n' +
    '• 主动检索: 信息缺口时 memory_search(query)；关键决策/学到的新技能用 memory_ingest 或 memory_teach_skill 沉淀。\n' +
    '• 主动学习: memory_classify → learning_queue → check_skill → websearch → teach 是记忆系统的主动学习闭环。\n' +
    '• 排错: memory_status 里 embedder.mode=fallback 表示模型缺失（语义检索降级为 BM25）；memory_weave 被拒说明协议门未满足，先 memory_classify。';
// Fail-open bootstrap state — module-level, so each surface fires once per process.
let warnedMissing = false; // logger.warn guidance emitted once while tools are missing
let guidanceInjected = false; // guidance user-message injected once
let bootstrapSpawned = false; // bootstrap script spawned at most once
let resumedLogged = false; // transition log once when tools come back
let introInjected = false; // activation card injected once when tools are available
/**
 * Per-agent protocol state: whether the CURRENT turn has already run its weave.
 * Reset to `false` at `agent/turn-stopping` so a fresh turn must weave again.
 */
const weavedThisTurn = new WeakMap();
/** Per-session buffered text of user/assistant messages, flushed at turn-stopping. */
const turnBuffers = new WeakMap();
/** Returns true when the tool name is one of the memory protocol's own tools. */
function isMemoryTool(name) {
    if (!name.startsWith(MCP_PREFIX))
        return false;
    return MEMORY_TOOL_NAMES.has(name.slice(MCP_PREFIX.length));
}
/** The MCP-bridged public name for a raw memory tool name. */
function memoryTool(raw) {
    return `${MCP_PREFIX}${raw}`;
}
/**
 * Dynamic check: memory tools may register after apply (MCP connect, restart,
 * reconnect), so this must be evaluated per hook invocation, never cached.
 */
function memoryToolsAvailable(ctx) {
    return ctx.tools.get(memoryTool('memory_weave')) !== undefined;
}
/** Emit the loud missing-tools guidance to the log, at most once per process. */
function warnMissingOnce(ctx) {
    if (warnedMissing)
        return;
    warnedMissing = true;
    ctx.logger.warn(MISSING_TOOLS_GUIDANCE);
}
/** Log the missing → present transition once (strict gate resumes). */
function noteResumedOnce(ctx) {
    if (!warnedMissing || resumedLogged)
        return;
    resumedLogged = true;
    ctx.logger.warn('memory-protocol: memory MCP tools registered — strict gate resumed');
}
/**
 * Spawn the bootstrap script (pip install + model download) at most once per
 * process, non-blocking. A spawn failure must never throw out of a hook.
 */
function maybeSpawnBootstrap(ctx, config) {
    if (bootstrapSpawned)
        return;
    bootstrapSpawned = true;
    try {
        const script = fileURLToPath(new URL('../scripts/bootstrap-memory.mjs', import.meta.url));
        spawn(process.execPath, [script], { detached: false, stdio: 'inherit', env: process.env });
        ctx.logger.warn('memory-protocol: bootstrap started — pip install + model download; restart dsh after it completes to mount the MCP server');
    }
    catch (error) {
        ctx.logger.warn(`memory-protocol: bootstrap spawn failed: ${String(error)}`);
    }
}
/** Invoke a memory MCP tool through the registered ToolRuntime. */
async function callMemoryTool(ctx, agent, signal, name, args) {
    const input = {
        callId: CallId(`memory-protocol-${name}-${Math.random().toString(16).slice(2, 10)}`),
        name: `${MCP_PREFIX}${name}`,
        arguments: args,
        signal,
        ...(agent === undefined ? {} : { agent }),
    };
    const result = await ctx.tools.execute(input);
    if (result.isError) {
        throw new Error(`memory tool ${name} failed: ${String(result.error)}`);
    }
    return result.value;
}
/** Extract the model-visible text from the weave result (string, block array, or object). */
function weaveContextText(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        return value
            .map((block) => (block && typeof block === 'object' ? block.text : ''))
            .filter((text) => typeof text === 'string')
            .join('\n');
    }
    if (value && typeof value === 'object') {
        const text = value.text;
        if (typeof text === 'string')
            return text;
        const context = value.context;
        if (typeof context === 'string')
            return context;
        if (Array.isArray(context)) {
            return context
                .map((block) => (block && typeof block === 'object' ? block.text : ''))
                .filter((text) => typeof text === 'string')
                .join('\n');
        }
    }
    return '';
}
/** Append one session event's text to its turn buffer. */
function bufferEventText(session, event) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message')
        return;
    const data = event.data;
    const content = data.message?.content ?? [];
    const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');
    if (!text.trim())
        return;
    const buffer = turnBuffers.get(session) ?? [];
    buffer.push(text);
    turnBuffers.set(session, buffer);
}
export const name = 'memory-protocol';
export const inject = ['tools'];
export const Config = Schema.object({
    enforceWeave: Schema.boolean().default(true),
    injectWeave: Schema.boolean().default(true),
    autoIngest: Schema.boolean().default(true),
    allowlist: Schema.array(Schema.string()).default([]),
    bootFailOpen: Schema.boolean().default(true),
    autoBootstrap: Schema.boolean().default(true),
});
export function apply(ctx, config) {
    const allow = new Set(config.allowlist);
    const bufferingAgents = new WeakSet();
    // session/event is scope-filtered to the agent's own context, so the buffer
    // listener must live on agent.ctx, not the root ctx. Register once per agent
    // on first sight so user/assistant text is captured for turn ingest.
    function ensureBuffering(agent) {
        if (bufferingAgents.has(agent))
            return;
        bufferingAgents.add(agent);
        agent.ctx.on('session/event', (session, event) => {
            bufferEventText(session, event);
        });
    }
    // tools/pre-execute: the protocol gate. Deny non-memory tools while the
    // current turn's weave is still pending.
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (memoryToolsAvailable(ctx))
            noteResumedOnce(ctx);
        if (exec.name === memoryTool('memory_weave')) {
            // An explicit model-driven weave also satisfies the gate for this turn.
            if (exec.agent)
                weavedThisTurn.set(exec.agent, true);
            return next();
        }
        if (isMemoryTool(exec.name) || allow.has(exec.name))
            return next();
        const agent = exec.agent;
        if (agent !== undefined && weavedThisTurn.get(agent))
            return next();
        // Fail-open: without the memory tools the gate can never be satisfied —
        // let every non-memory tool through and surface the guidance once.
        if (config.bootFailOpen && !memoryToolsAvailable(ctx)) {
            warnMissingOnce(ctx);
            return next();
        }
        if (!config.enforceWeave)
            return next();
        return {
            kind: 'deny',
            reason: 'Memory protocol: call mcp__opencode_memory__memory_weave first, ' +
                'then retry this tool. Every turn must consult memory before acting.',
        };
    });
    // agent/pre-step: weave once per turn and inject the context into the step.
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
        ensureBuffering(agent);
        // The first pre-step sees the turn's user messages; the session/event
        // listener (registered just above) only captures events after this point,
        // so seed the buffer with the user text to guarantee it is ingested.
        const session = agent.session;
        const buffer = turnBuffers.get(session) ?? [];
        if (buffer.length === 0) {
            const userText = messages
                .map((message) => message.content
                .filter((block) => block.type === 'text')
                .map((block) => block.text ?? '')
                .join(' '))
                .filter(Boolean)
                .join('\n');
            if (userText) {
                buffer.push(userText);
                turnBuffers.set(session, buffer);
            }
        }
        const downstream = await next();
        if (downstream.kind !== 'enter')
            return downstream;
        if (weavedThisTurn.get(agent))
            return downstream;
        if (!memoryToolsAvailable(ctx)) {
            if (config.bootFailOpen) {
                // Fail-open: skip the auto-weave branch entirely, spawn the bootstrap
                // once, and inject a one-time guidance message. The gate is open, so
                // weavedThisTurn is deliberately left unset.
                if (config.autoBootstrap)
                    maybeSpawnBootstrap(ctx, config);
                if (!guidanceInjected) {
                    guidanceInjected = true;
                    const injected = createUserMessage({
                        content: [{ type: 'text', text: MISSING_TOOLS_GUIDANCE }],
                        source: { ...PLUGIN_SOURCE, form: 'instructions' },
                    });
                    return { kind: 'enter', messages: [injected, ...downstream.messages] };
                }
                return downstream;
            }
            if (config.injectWeave) {
                // Fail-closed: the gate stays closed until the tools appear.
                ctx.logger.warn('memory-protocol: memory_weave tool not registered yet; protocol gate stays closed');
            }
            return downstream;
        }
        if (!config.injectWeave) {
            // Without auto-weave the gate stays closed until the model weaves on its own.
            if (!introInjected) {
                introInjected = true;
                const injected = createUserMessage({
                    content: [{ type: 'text', text: ACTIVATION_GUIDANCE }],
                    source: { ...PLUGIN_SOURCE, form: 'instructions' },
                });
                return { kind: 'enter', messages: [injected, ...downstream.messages] };
            }
            return downstream;
        }
        const userText = messages
            .map((message) => message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join(' '))
            .join('\n')
            .slice(0, 2000);
        let context = '';
        try {
            const value = await callMemoryTool(ctx, agent, signal, 'memory_weave', { user_message: userText });
            context = weaveContextText(value);
        }
        catch (error) {
            // Fail-closed: a failed weave leaves the gate closed; the model must retry.
            ctx.logger.warn(`memory-protocol: memory_weave failed: ${String(error)}`);
            return downstream;
        }
        if (!context) {
            // A successful but empty weave still counts as having consulted memory.
            weavedThisTurn.set(agent, true);
            return downstream;
        }
        weavedThisTurn.set(agent, true);
        const intro = introInjected ? '' : ((introInjected = true), ACTIVATION_GUIDANCE + '\n\n');
        const injected = createUserMessage({
            content: [{ type: 'text', text: intro + context.slice(0, 8000) }],
            source: { ...PLUGIN_SOURCE, form: 'instructions' },
        });
        return { kind: 'enter', messages: [injected, ...downstream.messages] };
    });
    // agent/turn-stopping: ingest the finished turn and reset the weave gate.
    ctx.on('agent/turn-stopping', async ({ agent }) => {
        weavedThisTurn.set(agent, false);
        if (!config.autoIngest)
            return;
        const session = agent.session;
        if (!memoryToolsAvailable(ctx)) {
            // No tools to call — drop this turn's buffer instead of ingesting.
            turnBuffers.delete(session);
            return;
        }
        const buffer = turnBuffers.get(session) ?? [];
        turnBuffers.delete(session);
        if (buffer.length === 0)
            return;
        const text = buffer.join('\n\n').slice(0, 4000);
        try {
            await callMemoryTool(ctx, agent, new AbortController().signal, 'memory_ingest', { content: text, role: 'user' });
        }
        catch {
            // A failed ingest must not block the turn from closing.
        }
    });
}

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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "memory-protocol";
export declare const inject: string[];
export interface Config {
    /** Hard-deny tool calls while the turn's weave is pending. Default true. */
    enforceWeave: boolean;
    /** Auto-inject the weave context into the first step of each turn. Default true. */
    injectWeave: boolean;
    /** Auto-ingest each completed turn at turn-stopping. Default true. */
    autoIngest: boolean;
    /** Additional tool names exempt from the weave gate. Default []. */
    allowlist: string[];
    /**
     * Fail-open when the memory MCP tools are missing: the gate passes, no
     * auto-weave/ingest is attempted, and a one-time loud guidance is surfaced.
     * Strict behavior is unchanged whenever the tools ARE present. Default true.
     */
    bootFailOpen: boolean;
    /** Auto-run scripts/bootstrap-memory.mjs (once per process) when the tools are missing. Default true. */
    autoBootstrap: boolean;
    /** Append a backup signal to the ccmp-backup signal file after each finished turn. Default false. */
    autoBackup: boolean;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;

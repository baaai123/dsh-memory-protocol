# dsh-memory-protocol

[![npm](https://img.shields.io/npm/v/dsh-memory-protocol)](https://www.npmjs.com/package/dsh-memory-protocol)
[![GitHub](https://img.shields.io/badge/github-baaai123%2Fdsh--memory--protocol-blue)](https://github.com/baaai123/dsh-memory-protocol)
[![PyPI](https://img.shields.io/pypi/v/memory-skill)](https://pypi.org/project/memory-skill/)

[English](#dsh-memory-protocol) | [中文](#dsh-memory-protocol-1)

**为 DeepSeek Harness 打造的长期记忆插件** — 桥接 [opencode-memory](https://github.com/baaai123/solo-memory) MCP 服务器，并附加强制记忆协议。

> **哼，杂鱼又忘事了吧？** 工具调用前先给我 weave 记忆、每轮对话自动存档——省得你三秒重置、重复学习。才、才不是特地为你准备的，只是看不得你每次从零开始犯蠢。

## 作用

这个 bundle 装两样东西：

1. **memory-mcp** — 通过官方 `@deepseek-ai/dsh-mcp-client` 桥接 opencode-memory 的 Python MCP 服务器（15 个 `memory_*` 工具：weave/search/ingest/classify/teach_skill 等）
2. **memory-protocol** — 强制协议插件，三个 hook：
   - `tools/pre-execute` — 未 weave 就调其他工具 → **硬拒绝**
   - `agent/pre-step` — 每轮自动 weave 并注入记忆上下文
   - `agent/turn-stopping` — 每轮自动 ingest 对话

## 安装

```sh
# 1. 先装 opencode-memory 的 Python server（提供 memory_skill.mcp_server）
pip install memory-skill

# 2. 安装本插件
dsh plugin --profile web add dsh-memory-protocol
```

默认用 `python3 -m memory_skill.mcp_server` 启动 MCP server。路径可通过环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_SKILL_PYTHON` | `python3` | 解释器路径 |
| `MEMORY_SKILL_DIR` | `process.cwd()` | memory-skill 项目目录 |
| `MEMORY_SKILL_DB_PATH` | （未设） | 记忆库路径，server 默认 `memory.db` |
| `IMPORTANCE_API_KEY` | （未设） | LLM 重要性评分 key（可选） |

## 配置

`memory-protocol` 的配置项（`cordis.patch.yml` 中可调）：

```yaml
config:
  enforceWeave: true    # 工具调用前强制 weave（未 weave 拒绝）
  injectWeave: true     # 自动注入记忆上下文
  autoIngest: true      # 每轮自动存档
  allowlist: []         # 豁免工具名（除 memory_* 外）
```

## 工作原理

```
dsh (Web / headless)
  ├─ memory-mcp      @deepseek-ai/dsh-mcp-client ──> python3 -m memory_skill.mcp_server
  │                                                    └─ 15 个 mcp__opencode_memory__* 工具
  └─ memory-protocol 强制协议
       ├─ tools/pre-execute     未 weave → deny
       ├─ agent/pre-step        weave + 注入
       └─ agent/turn-stopping   自动 ingest
```

## License

MIT

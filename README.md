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

**前置依赖：Python MCP server（memory-skill）+ 嵌入模型（bge-large-en-v1.5）**。插件启动时会自动引导安装（`npm run bootstrap` 或插件 autoBootstrap）；也可手动安装（下面的命令）。可用 `MEMORY_SKIP_BOOTSTRAP=1` 关闭自动引导。

```sh
# 1. 先装 opencode-memory 的 Python server（提供 memory_skill.mcp_server）
pip install "memory-skill[onnx]" optimum[onnxruntime] huggingface_hub

# 2. 下载嵌入模型（约 1.3GB，自动转 ONNX；国内网络可加 HF_ENDPOINT=https://hf-mirror.com）

# 3. 安装本插件
dsh plugin --profile web add dsh-memory-protocol
```

默认用 `python3 -m memory_skill.mcp_server` 启动 MCP server。路径可通过环境变量覆盖：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_SKILL_PYTHON` | `python3` | 解释器路径 |
| `MEMORY_SKILL_DIR` | `process.cwd()` | memory-skill 项目目录 |
| `MEMORY_SKILL_DB_PATH` | （未设） | 记忆库路径，server 默认 `memory.db` |
| `IMPORTANCE_API_KEY` | （未设） | LLM 重要性评分 key（可选） |

### 自动引导

插件检测到 memory MCP 工具未注册时，会自动触发 `scripts/bootstrap-memory.mjs`（也可手动 `npm run bootstrap`）：

1. `pip install --user "memory-skill[onnx]" optimum[onnxruntime] huggingface_hub`（已安装则跳过）
2. 下载 `BAAI/bge-large-en-v1.5` 并转 ONNX（默认 `models/bge-large-en-v1.5/`；直连失败自动重试 `HF_ENDPOINT=https://hf-mirror.com`）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_SKIP_BOOTSTRAP` | （未设） | `=1` 关闭自动引导 |
| `MEMORY_SKIP_INSTALL` | （未设） | `=1` 跳过 pip install |
| `MEMORY_SKIP_MODEL` | （未设） | `=1` 跳过模型下载 |
| `MEMORY_MODEL_PATH` | `$MEMORY_SKILL_DIR/models/bge-large-en-v1.5` | 指定模型目录（已有 `model.onnx` 则跳过下载） |

> **没有 Python 侧时，插件以 fail-open 模式运行（不强制执行协议、agent 不被阻塞），并显示一次性引导提示。** 引导完成并重启 dsh 后，memory 工具注册、严格协议自动恢复。

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


## 截图

![cover](assets/screenshots/cover.png)

| 架构 | 强制执行演示 | 配置项 |
|---|---|---|
| ![architecture](assets/screenshots/architecture@2x.png) | ![demo](assets/screenshots/enforcement-demo.png) | ![config](assets/screenshots/config.png) |

> 演示为真实运行输出：未 weave 调工具 → ⛔ DENY；pre-step 自动 weave 并注入记忆上下文；turn-stopping 自动 ingest。

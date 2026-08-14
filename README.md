# dsh-of-your-own

> 装上它，DSH 就有了 `/fuck` —— 并行读取你与 Claude Code、Codex 等 agent 的对话记录，
> 分析你的偏好和惯用工具/命令，以插件形式迁移进 DSH，并且**一直记得**。

一个独立的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。
不改 agent loop、不打骨架补丁，一切通过文档化的 cordis 扩展接缝完成。

## 它做什么

```
/fuck
  │
  ├─ 并行扫描 ── ~/.claude/projects/**/*.jsonl   (Claude Code)
  │              ~/.codex/sessions/**/*.jsonl    (Codex)
  │
  ├─ 分析 ───── 工具使用频率 · slash 命令习惯 · 工作目录 · 回复语言(中/英)
  │
  ├─ 综合偏好 ── 有 ctx.llm 时走 LLM 生成要点；没有则用确定性模板兜底
  │
  ├─ 迁移 ───── profile.json 落盘 ~/.dsh/of-your-own/
  │              观测到的 slash 命令生成 commands/<name>.md 迁移存根
  │
  └─ 记住 ───── 偏好注入 systemPrompt.context()
               每次启动自动读回档案重新注入 —— 跨会话记忆
```

## 安装

```bash
git clone https://github.com/LaplaceYoung/dsh-of-your-own.git
cd dsh-of-your-own
pnpm install
pnpm build
```

挂载到 DSH 组合（`cordis.yml`）：

```yaml
- id: dsh-of-your-own
  name: '@dsh-external/dsh-of-your-own'
  # config:
  #   provider: deepseek-official   # LLM 偏好综合（可选，缺省用确定性模板）
  #   model: deepseek-v4-flash
  #   maxFilesPerSource: 50         # 每个源扫描最新的 N 份会话
  #   storeDir: ~/.dsh/of-your-own  # 档案目录
```

或直接应用 [`cordis.patch.yml`](cordis.patch.yml)。

## 用法

```
/fuck                  # 全量迁移：并行扫描 → 分析 → 落盘 → 注入偏好
```

运行后 agent 会报告学到了什么（示例）：

```
## Migration complete

Scanned claude-code (30 sessions), codex (30 sessions) — 274 user messages.

Tool habits: exec_command×201, Bash×183, Read×85, …
Migrated commands: /review, /memory
Profile: ~/.dsh/of-your-own/profile.json
Injected into the system prompt — future sessions will remember this.
```

两个检查工具（模型可调用，也可在会话里直接问）：

| 工具 | 作用 |
| --- | --- |
| `my_profile` | 查看已学偏好；`{ refresh: true }` 重新扫描并重建档案 |
| `my_commands` | 列出从其他 harness 迁移来的 slash 命令及观测次数 |

## 设计纪律

- **接缝，不是手术** — 只用 `ctx.commands`、`ctx.tools`、`ctx.systemPrompt`、`ctx.llm`、`ctx.fs`，全部缺省可降级。
- **注册即副作用** — `ctx.effect()` + disposer；卸载后命令与注入全部撤销。
- **无 LLM 也能跑** — 偏好综合缺省时退化为确定性模板，测试不需要真实 API key。
- **隐私本地化** — 对话记录只在本机读取、只把统计摘要与偏好写入本机档案，不出网。
- **并行读取** — 各源之间、每个源内部的文件读取都是并发的。

## 开发

```bash
pnpm test        # 38 个单测/集成测试（4 个 spec）
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → lib/
```

## 文件布局

```
src/
  sources.ts   # transcript 适配器：Claude Code / Codex JSONL 解析（纯函数）
  analyze.ts   # 频率统计 + LLM 偏好综合 + 档案组装
  store.ts     # 档案与命令存根持久化
  index.ts     # 插件入口：/fuck 命令、my_profile / my_commands、启动时记忆回读
tests/         # vitest：解析器、分析、持久化、插件集成
```

## License

MIT.

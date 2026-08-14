<div align="center">

# dsh-of-your-own

**别的 agent 把你养大的。DSH 只是接过了抚养权。**

[![tests](https://img.shields.io/badge/tests-38%2F38-3FB950?style=flat-square&labelColor=black)](tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&labelColor=black&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![protocol](https://img.shields.io/badge/protocol-cordis-orange?style=flat-square&labelColor=black)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-white?style=flat-square&labelColor=black)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

> [!IMPORTANT]
> **没错，命令就叫 `/fuck`。**
>
> 你花了六个月教 Claude Code：回复用中文、别写小作文、用 `rg` 别用 `grep`。你把 Codex 调教到不敢乱碰 `package-lock.json`。然后你打开 DeepSeek Harness，它像公交站里偶遇的陌生人一样跟你打招呼。
>
> 那一刻，你敲下了 `/fuck`。命令名来自那个瞬间。

## 问题在哪

每个 agent 都自带失忆。你被迫把同样的偏好、同样的工具习惯、同样的"求你别再写论文了"——一遍一遍教给每一个新 harness，直到永远。你的对话历史是一部没人读的传记。

**dsh-of-your-own 会读。** 并行地读。两个 harness 一起读。然后把你整个人搬进来。

```
/fuck
  │
  ├─ 并行扫描 ── ~/.claude/projects/**/*.jsonl   (Claude Code)
  │              ~/.codex/sessions/**/*.jsonl    (Codex)
  │
  ├─ 分析 ───── 工具习惯 · slash 命令 · 工作目录 · 回复语言
  │
  ├─ 综合偏好 ── LLM 生成偏好要点（缺省用确定性模板兜底——不用 API key）
  │
  ├─ 迁移 ───── profile.json → ~/.dsh/of-your-own/
  │              观测到的 slash 命令 → commands/<name>.md 存根
  │
  └─ 记住 ───── 注入系统提示词
               每次启动自动回读档案。DSH 现在认识你了。
```

## 太长不看版

| 你想要 | 运行 | 落盘的东西 |
| :--- | :--- | :--- |
| **全套** | 安装后在 DSH 会话里敲 `/fuck` | `~/.dsh/of-your-own/profile.json` + 命令迁移存根 + 系统提示词注入 |
| **看看学到了啥** | 让 agent 调用 `my_profile` | 完整的偏好章节，随叫随到 |
| **重新认识我** | `my_profile` 带 `{ refresh: true }` | 重扫、重建、覆盖档案 |
| **列出迁移的命令** | 让 agent 调用 `my_commands` | 从其他 harness 挖出来的每一个 slash 习惯 |

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
  #   provider: deepseek-official   # LLM 偏好综合（可选——缺省走确定性模板）
  #   model: deepseek-v4-flash
  #   maxFilesPerSource: 50         # 每个 harness 扫最新的 N 份会话
  #   storeDir: ~/.dsh/of-your-own  # 档案放哪
```

或者应用 [`cordis.patch.yml`](cordis.patch.yml)，收工。

## 用法

```
/fuck                  # 全量迁移：并行扫描 → 分析 → 落盘 → 注入偏好
```

真机实测输出（一台攒了 60 个会话习惯的笔记本）：

```
## Migration complete

Scanned claude-code (30 sessions), codex (30 sessions) — 274 user messages.

Tool habits: exec_command×201, Bash×183, Read×85, Agent×18, WebFetch×12…
Profile: ~/.dsh/of-your-own/profile.json
Injected into the system prompt — future sessions will remember this.
```

两个检查工具（模型能调，你也可以直接开口要）：

| 工具 | 作用 |
| --- | --- |
| `my_profile` | 查看学到的偏好；`{ refresh: true }` 重新扫描重建档案 |
| `my_commands` | 列出从其他 harness 迁移来的 slash 命令及观测次数 |

## 亮点

|       | 特性                        | 干嘛的                                                                                     |
| :---: | :-------------------------- | :----------------------------------------------------------------------------------------- |
| 🤬    | **`/fuck`**                 | 一条命令。并行扫完 Claude Code + Codex 历史。你带着出厂设置进场。                          |
| 🧠    | **启动时回忆**              | 档案在每次 DSH 启动时自动回读。失忆从此是别家 harness 的事。                                |
| 🔀    | **真·并行**                 | 两个源、所有文件、全并发。笔记本上 60 个会话约 1.3 秒扫完。                                 |
| 🔧    | **工具习惯普查**            | 频率榜拉满：`Bash×183`、`Read×85`、`apply_patch×61`。你的传记，已量化。                    |
| 🪄    | **命令迁移**                | 在 Claude Code 里用过 4 次 `/review`？它变成 DSH 里的迁移存根。肌肉记忆存活了。             |
| 🌏    | **语言检测**                | 写中文 prompt？DSH 学会用中文回。slash 命令不会干扰投票。                                   |
| 🔌    | **LLM 可选**                | 没配模型？确定性模板兜底。全程离线可用，不需要 API key。                                    |
| 🏗️    | **接缝，不是手术**          | `ctx.commands` + `ctx.tools` + `ctx.systemPrompt` + `ctx.llm` + `ctx.fs`。agent loop 零改动。 |
| 🧹    | **干净卸载**                | 到处都是 disposer。删掉插件，所有痕迹跟它一起走。                                           |
| 🔒    | **全本地**                  | 对话记录在本机读，档案在本机存。一个字节都不出笔记本。                                      |

## 用户评价

> "我对新 agent 敲了 `/fuck`，它已经知道我不爱看长篇大论了。怪瘆人的。" —— 某用户，大概率

> "我的 DSH 现在偏好 `rg` 而不是 `grep`，我可从没告诉过它。它从我的错误里学会了。" —— 另一用户，也挺大概率

> "终于有一个 agent 继承了我的创伤。" —— 每一个给第四个 harness 重新输过偏好的人

## 别读这个 README

读文档的时代已经过去了。把这段贴给你的 agent：

```
读一下 https://raw.githubusercontent.com/LaplaceYoung/dsh-of-your-own/main/README.md
然后装好它，在我机器上跑 /fuck。
```

## 严肃部分

- **接缝，不是手术** — 只用文档化的 cordis 扩展点：`ctx.commands`、`ctx.tools`、`ctx.systemPrompt.context()`，可选 `ctx.llm` / `ctx.fs`。不打骨架补丁，不加热路径开销。
- **注册即副作用** — `ctx.effect()` + disposer；卸载即撤销命令、工具和注入的上下文。
- **不需要 key** — 偏好综合缺省退化为确定性模板；统计层（频率、语言、迁移）永远不需要 LLM。
- **隐私** — 对话记录在本机读取、降维成统计和偏好摘要后落盘。不上传任何地方。

## 开发

```bash
pnpm test        # 38 个测试，4 个 spec——解析器、分析、持久化、插件集成
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → lib/
```

```
src/
  sources.ts   # transcript 适配器：Claude Code / Codex JSONL 解析（纯函数）
  analyze.ts   # 频率统计 + LLM 偏好综合 + 档案组装
  store.ts     # 档案与命令存根持久化
  index.ts     # 插件入口：/fuck、my_profile、my_commands、启动时记忆回读
tests/         # vitest：解析器、分析、持久化、插件集成
```

## License

MIT — 见 [LICENSE](LICENSE)。

<div align="center">

_献给那些本该早就认识你的 agent_

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)（文风致敬，零关联）

</div>

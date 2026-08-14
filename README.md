<div align="center">

# dsh-of-your-own

**Your other agents raised you. DSH just got custody.**

[![tests](https://img.shields.io/badge/tests-38%2F38-3FB950?style=flat-square&labelColor=black)](tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&labelColor=black&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![protocol](https://img.shields.io/badge/protocol-cordis-orange?style=flat-square&labelColor=black)](https://github.com/deepseek-ai/deepseek-harness)
[![license](https://img.shields.io/badge/license-MIT-white?style=flat-square&labelColor=black)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md)

</div>

---

> [!IMPORTANT]
> **Yes, the command is literally `/fuck`.**
>
> You spent six months teaching Claude Code that you like Chinese replies, short answers, and `rg` over `grep`. You trained Codex to never touch `package-lock.json` unprompted. Then you open DeepSeek Harness, and it greets you like a stranger at a bus stop.
>
> That's when you type `/fuck`. We named it after the moment.

## The Problem

Every agent starts with amnesia. You re-teach the same preferences, the same tool habits, the same "please stop writing essays" — to every new harness, forever. Your conversation history is a biography nobody reads.

**dsh-of-your-own reads it.** In parallel. Both harnesses at once. Then it moves you in.

```
/fuck
  │
  ├─ parallel scan ── ~/.claude/projects/**/*.jsonl   (Claude Code)
  │                   ~/.codex/sessions/**/*.jsonl    (Codex)
  │
  ├─ analyze ───── tool habits · slash commands · working dirs · reply language
  │
  ├─ synthesize ─── LLM preference summary (or a deterministic fallback — no key needed)
  │
  ├─ migrate ────── profile.json → ~/.dsh/of-your-own/
  │                  observed slash commands → commands/<name>.md stubs
  │
  └─ remember ───── injected into the system prompt.
                    re-loaded on every boot. Your DSH remembers you now.
```

## TL;DR

| You want | Run | What lands on disk |
| :--- | :--- | :--- |
| **The whole thing** | install, then `/fuck` in a DSH session | `~/.dsh/of-your-own/profile.json` + migrated command stubs + system-prompt injection |
| **See what it learned** | ask the agent to run `my_profile` | the full preference section, on demand |
| **Re-learn you** | `my_profile` with `{ refresh: true }` | fresh scan, fresh profile, overwritten |
| **List migrated commands** | ask for `my_commands` | every slash habit it found elsewhere |

## Installation

```bash
git clone https://github.com/LaplaceYoung/dsh-of-your-own.git
cd dsh-of-your-own
pnpm install
pnpm build
```

Mount it in your DSH composition (`cordis.yml`):

```yaml
- id: dsh-of-your-own
  name: '@dsh-external/dsh-of-your-own'
  # config:
  #   provider: deepseek-official   # LLM preference synthesis (optional — template fallback otherwise)
  #   model: deepseek-v4-flash
  #   maxFilesPerSource: 50         # newest N transcripts scanned per harness
  #   storeDir: ~/.dsh/of-your-own  # where the profile lives
```

Or apply [`cordis.patch.yml`](cordis.patch.yml) and call it a day.

## Usage

```
/fuck                  # full migration: parallel scan → analyze → persist → inject
```

Real output from a real laptop with 60 sessions of accumulated habits:

```
## Migration complete

Scanned claude-code (30 sessions), codex (30 sessions) — 274 user messages.

Tool habits: exec_command×201, Bash×183, Read×85, Agent×18, WebFetch×12…
Profile: ~/.dsh/of-your-own/profile.json
Injected into the system prompt — future sessions will remember this.
```

Two inspection tools (the model can call them; so can you, by asking):

| tool | does |
| --- | --- |
| `my_profile` | show the learned preferences; `{ refresh: true }` re-scans and rebuilds |
| `my_commands` | list every slash command migrated from your other harnesses, with observation counts |

## Highlights

|       | Feature                     | What it does                                                                                     |
| :---: | :-------------------------- | :----------------------------------------------------------------------------------------------- |
| 🤬    | **`/fuck`**                 | One command. Parallel scan of your Claude Code + Codex history. You come pre-configured.         |
| 🧠    | **Boot-time recall**        | The profile reloads on every DSH startup. Amnesia is for other harnesses now.                    |
| 🔀    | **Actually parallel**       | Both sources, all files, concurrently. 60 sessions scanned in ~1.3s on a laptop.                 |
| 🔧    | **Tool habit census**       | Frequency-ranked everything: `Bash×183`, `Read×85`, `apply_patch×61`. Your biography, quantified. |
| 🪄    | **Command migration**       | `/review` used 4× in Claude Code? It becomes a migrated stub in DSH. Your muscle memory survives. |
| 🌏    | **Language detection**      | Writes Chinese prompts? DSH learns to reply in Chinese. Slash commands don't skew the vote.      |
| 🔌    | **LLM optional**            | No model configured? Deterministic template fallback. Works fully offline, no API key.           |
| 🏗️    | **Seams, not surgery**      | `ctx.commands` + `ctx.tools` + `ctx.systemPrompt` + `ctx.llm` + `ctx.fs`. Zero agent-loop edits. |
| 🧹    | **Clean uninstall**         | Disposers everywhere. Remove the plugin and every trace leaves with it.                          |
| 🔒    | **Local everything**        | Transcripts read on your machine, profile stored on your machine. Nothing leaves the laptop.     |

## Reviews

> "I typed `/fuck` at my new agent and it already knew I hate verbose answers. Spooky." — a user, probably

> "My DSH now prefers `rg` over `grep` and I never told it that. It learned from my mistakes." — another user, also probably

> "Finally, an agent that inherits my trauma." — everyone who has re-typed their preferences into a fourth harness

## Skip This README

We're past the era of reading docs. Just paste this into your agent:

```
Read https://raw.githubusercontent.com/LaplaceYoung/dsh-of-your-own/main/README.md
then install it and run /fuck on my machine.
```

## The Serious Part

- **Seams, not surgery** — documented cordis extension points only: `ctx.commands`, `ctx.tools`, `ctx.systemPrompt.context()`, optional `ctx.llm` / `ctx.fs`. No skeleton patches, no hot-path tax.
- **Registration is a side effect** — `ctx.effect()` + disposers; uninstall removes the command, tools, and injected context.
- **No key required** — preference synthesis degrades to a deterministic template; the deterministic layer (frequencies, language, migration) never needs an LLM.
- **Privacy** — your transcripts are read locally and reduced to statistics + a preference summary on disk. Nothing is uploaded anywhere.

## Development

```bash
pnpm test        # 38 tests across 4 specs — parsers, analysis, persistence, plugin integration
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → lib/
```

```
src/
  sources.ts   # transcript adapters: Claude Code / Codex JSONL parsers (pure)
  analyze.ts   # frequency stats + LLM preference synthesis + profile assembly
  store.ts     # profile + command stub persistence
  index.ts     # plugin entry: /fuck, my_profile, my_commands, boot-time recall
tests/         # vitest: parsers, analyze, store, plugin integration
```

## License

MIT — see [LICENSE](LICENSE).

<div align="center">

_made for agents that should have known you already_

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) (style inspiration, zero affiliation)

</div>

/**
 * The fun part — a tsundere appraisal of the user after the analysis.
 *
 * Given the learned profile, `buildVerdictReport` renders a playful
 * "identification report": a rank, the user's harness-cheating history,
 * their weapon of choice, night-owl verdict, and slash-command muscle
 * memory — closing with an unmistakably tsundere declaration that no
 * matter who they used before, from now on there is only DSH.
 *
 * Determinism: the closing line is picked by hashing the profile content,
 * so re-running `/fuck` on the same history yields the same verdict.
 *
 * @module dsh-of-your-own/report
 */

import type { UserProfile } from './analyze.js'

/** Inputs for the verdict report. */
export interface VerdictInputs {
  profile: UserProfile
  /** Local hours (0-23) of user messages across all sources. */
  messageHours: readonly number[]
}

/** Ranks by total observed activity (messages + tool calls). */
const RANKS_ZH = [
  { min: 500, rank: '传世老登', note: '骨灰级用户，见多识广，很难哄' },
  { min: 200, rank: '全职折腾', note: '把 agent 当生产资料的重度用户' },
  { min: 50, rank: '常规玩家', note: '用得不少，但还有救' },
  { min: 1, rank: '路过萌新', note: '刚入坑，一切皆有可能' },
] as const

const RANKS_EN = [
  { min: 500, rank: 'Certified Veteran', note: 'seen it all, hard to impress' },
  { min: 200, rank: 'Full-time Tinkerer', note: 'treats agents as production infrastructure' },
  { min: 50, rank: 'Regular Player', note: 'active, but salvageable' },
  { min: 1, rank: 'Curious Newcomer', note: 'fresh in — anything is possible' },
] as const

/** Tsundere closers, zh. The point: whatever you used before, DSH now. */
export const TSUNDERE_ZH = [
  '哼，别误会，我才不是特意为你分析这些的……只是顺手而已。不过既然被我记住了，不管以前你用的是谁，今后都只能用 DSH。听懂了吗？不许再回头找它们。',
  '看了你的记录，也就那样吧。但……既然落到我手里了，以前那些 Claude、Codex、pi 统统作废。从现在起只有 DSH，敢用别的试试？',
  '才、才不是因为在意你才翻你的历史呢！只是……只是数据刚好在那里而已。总之，以前你用谁都无所谓，今后只准用 DSH。这是命令，不是商量。',
  '你的历史我看完了。嗯，还算有点品味。所以——过去的事就让它过去吧，从今天起，你的 agent 只能叫 DSH。别的名字，不许再从我面前提起。',
]

/** Tsundere closers, en. */
export const TSUNDERE_EN = [
  'Hmph — don\'t get the wrong idea, I didn\'t analyze all that for you. I just... happened to have time. Anyway, whoever you used before, from now on there is only DSH. Got it? Don\'t you dare go back.',
  'Your history? It\'s fine, I guess. But since you\'ve fallen into my hands now, Claude, Codex, pi — all canceled. From this moment on it\'s DSH only. Try using anything else, I dare you.',
  'I-I didn\'t read your transcripts because I care! The data was just... sitting there. Anyway, whatever you used before doesn\'t matter anymore. From now on, DSH only. That\'s an order, not a suggestion.',
  'I\'ve read your whole history. Hm. You have some taste, I\'ll give you that. So — the past stays in the past. From today, your agent is called DSH, and no other name crosses your lips again.',
]

/** djb2 hash over a string — small, fast, deterministic. */
export function hashString(text: string): number {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Rank the user by total observed activity. */
export function rankUser(activity: number, language: 'zh' | 'en'): { rank: string; note: string } {
  const table = language === 'zh' ? RANKS_ZH : RANKS_EN
  for (const tier of table) {
    if (activity >= tier.min) return { rank: tier.rank, note: tier.note }
  }
  return { rank: table[table.length - 1].rank, note: table[table.length - 1].note }
}

/** Night owl: ≥30% of messages sent between 23:00 and 05:59. */
export function isNightOwl(hours: readonly number[]): boolean {
  if (hours.length < 5) return false
  const night = hours.filter(h => h >= 23 || h < 6).length
  return night / hours.length >= 0.3
}

/** The full tsundere verdict report (markdown). */
export function buildVerdictReport(inputs: VerdictInputs): string {
  const { profile, messageHours } = inputs
  const zh = profile.language === 'zh'
  const harnessCount = profile.sources.length
  const memoryCount = profile.memoryFiles.length
  const activity = profile.sources.reduce((n, s) => n + s.promptCount, 0) + profile.toolHabits.reduce((n, t) => n + t.count, 0)
  const { rank, note } = rankUser(activity, profile.language)
  const topTool = profile.toolHabits[0]
  const topCmd = profile.slashHabits[0]
  const night = isNightOwl(messageHours)
  const closers = zh ? TSUNDERE_ZH : TSUNDERE_EN
  const closer = closers[hashString(JSON.stringify(profile.preferences) + profile.language + activity) % closers.length]

  const lines: string[] = []
  if (zh) {
    lines.push('## 🎫 用户鉴定报告', '')
    lines.push(`**鉴定等级**：${rank} —— ${note}`)
    lines.push(`**出轨记录**：经查实，该用户共交往过 **${harnessCount}** 个 agent${memoryCount ? `，还留下 ${memoryCount} 份记忆文件当证物` : ''}。实锤，别狡辩。`)
    if (topTool) lines.push(`**本命法器**：\`${topTool.name}\`（共使用 ${topTool.count} 次，比对象还勤）`)
    if (topCmd) lines.push(`**肌肉记忆**：闭着眼睛都会敲 \`${topCmd.name}\`（${topCmd.count} 次）`)
    lines.push(`**夜猫子判定**：${night ? '成立。深夜还在跟 agent 对话，建议睡觉（但我知道你不会）' : '不成立，作息尚可，继续保持'}`)
    lines.push(`**语言偏好**：${zh ? '中文' : 'English'}（已录入 DSH 档案）`)
  } else {
    lines.push('## 🎫 User Identification Report', '')
    lines.push(`**Rank**: ${rank} — ${note}`)
    lines.push(`**Cheating record**: confirmed relations with **${harnessCount}** agents${memoryCount ? `, plus ${memoryCount} memory file(s) left behind as evidence` : ''}. Caught red-handed.`)
    if (topTool) lines.push(`**Weapon of choice**: \`${topTool.name}\` (used ${topTool.count}× — more than your partner)`)
    if (topCmd) lines.push(`**Muscle memory**: types \`${topCmd.name}\` with eyes closed (${topCmd.count}×)`)
    lines.push(`**Night-owl verdict**: ${night ? 'guilty — still talking to agents deep into the night (go sleep; you won\'t)' : 'not guilty — decent hours, keep it up'}`)
    lines.push(`**Language**: ${zh ? 'Chinese' : 'English'} (filed under your DSH record)`)
  }
  lines.push('', '---', '', closer)
  return lines.join('\n')
}

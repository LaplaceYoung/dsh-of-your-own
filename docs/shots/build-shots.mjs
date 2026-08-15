#!/usr/bin/env node
/**
 * Build terminal-screenshot HTML pages from e2e/live-results.json.
 * Each command becomes one page with light syntax coloring.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const results = JSON.parse(readFileSync(join(root, '..', '..', 'e2e', 'live-results.json'), 'utf8'))
const template = readFileSync(join(root, 'template.html'), 'utf8')
mkdirSync(join(root, 'html'), { recursive: true })

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Very light tokenizer for terminal aesthetics. */
function paint(line) {
  let l = esc(line)
  l = l.replace(/^## (.*)$/m, '<span class="hdr">$1</span>')
  l = l.replace(/^\*\*(.*?)\*\*/m, '<span class="key">$1</span>')
  l = l.replace(/\*\*(.*?)\*\*/g, '<span class="hl">$1</span>')
  l = l.replace(/`([^`]+)`/g, '<span class="path">$1</span>')
  l = l.replace(/^┌─ \/(\S+).*$/m, m => `<span class="cmd">${m}</span>`)
  l = l.replace(/^└─$/m, m => `<span class="box">${m}</span>`)
  l = l.replace(/^│/m, m => `<span class="box">${m}</span>`)
  l = l.replace(/(✓)/g, '<span class="ok">$1</span>')
  l = l.replace(/(×\d+)/g, '<span class="num">$1</span>')
  return l
}

const pages = {
  '/fuck': { file: 'fuck', title: '/fuck — migrate & judge' },
  '/sessions': { file: 'sessions', title: '/sessions — resume catalog' },
  '/resume 1': { file: 'resume', title: '/resume 1 — handoff brief' },
  '/forget': { file: 'forget', title: '/forget — privacy exit', both: true },
}

for (const [line, meta] of Object.entries(pages)) {
  const recs = results.filter(r => r.line === line)
  let body = `<span class="cmd">╭─ π  &gt; ⬢ qwen3.8-max &gt; 📁 ~/Desktop/dsh</span>\n`
  body += `<span class="cmd">╰─ $ ${esc(line)}</span>\n<span class="spacer"></span>\n`
  for (const r of recs) {
    for (const ln of r.text.split('\n')) body += paint(ln) + '\n'
    if (meta.both && r !== recs[recs.length - 1]) body += '<span class="spacer"></span>'
  }
  const html = template
    .replace('<title>dsh-of-your-own — live DSH session</title>', `<title>dsh-of-your-own — ${meta.title}</title>`)
    .replace('<div class="body" id="out"></div>', `<div class="body" id="out">${body}</div>`)
  writeFileSync(join(root, 'html', `${meta.file}.html`), html)
  console.log(`built html/${meta.file}.html`)
}

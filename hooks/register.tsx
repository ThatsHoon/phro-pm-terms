import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Term } from '../types'

const PANE = 'pm-terms'
const terms = atom({ plugin: 'phro-pm-terms', key: 'terms' } as const, [])
const isArchiveView = atom({ plugin: 'phro-pm-terms', key: 'isArchiveView' } as const, false)

// ponytail: answers clipped to 12k chars per extraction; enough for one turn or a short session scan
const CLIP = 12000

const SYSTEM = `You extract IT terms a product manager (PM) in the software industry should know.
From the assistant text, pick technical acronyms, jargon and concepts (e.g. API, JSON, hook, cache, CI, hot reload, token, schema) a non-engineer PM would benefit from understanding.
Skip anything in the KNOWN list, trivial words, and project-specific names.
Write in Korean. For each: "meaning" = one sentence conceptual meaning; "example" = one line of a real-world application.
Output ONLY a JSON array, max 8 items: [{"term": "...", "meaning": "...", "example": "..."}]. Output [] if none.`

export function parseTerms(text: string, known: readonly string[]): Term[] {
  const json = text.match(/\[[\s\S]*\]/)?.[0]
  if (!json) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return [] // model output is untrusted; a bad reply adds nothing
  }
  if (!Array.isArray(raw)) return []
  const seen = new Set(known.map(k => k.toLowerCase()))
  const out: Term[] = []
  for (const item of raw) {
    const { term, meaning, example } = item ?? {}
    if (typeof term !== 'string' || typeof meaning !== 'string' || typeof example !== 'string') continue
    const key = term.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ term: term.trim(), meaning: meaning.trim(), example: example.trim(), isDone: false })
  }
  return out
}

async function save($: EngineInterface, change: (list: Term[]) => Term[]) {
  const list = await update($, terms, change)
  await $.store.set('terms', list)
}

async function extract($: EngineInterface, text: string) {
  const known = (await read($, terms)).map(t => t.term)
  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: `KNOWN: ${known.join(', ') || '(none)'}\n\nASSISTANT TEXT:\n${text.slice(-CLIP)}`,
    maxTokens: 2000,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!r.isAnswered) return 0
  const fresh = parseTerms(r.text, known)
  if (fresh.length === 0) return 0
  await save($, list => [...fresh, ...list])
  $.ui.toast(`📘 PM 용어 ${fresh.length}개 추가 — /pm-terms`)
  return fresh.length
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('terms')
    if (Array.isArray(stored)) await update($, terms, () => stored as Term[])
    await $.command.register({
      name: 'pm-terms',
      description: 'Open the PM terms checklist ("scan" extracts from this whole session)',
      argumentHint: '[scan]',
    })
    return next(e)
  })

  on('command.run', { command: 'pm-terms' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'PM 용어' })
    if (e.args.trim() !== 'scan') return { text: 'PM terms pane opened.' }

    const answers = (await $.session.messages())
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n\n')
    const added = await extract($, answers)
    return { text: `Scanned this session: ${added} new PM terms.` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer) {
      const answer = e.answer
      $.clock.after(0, () => void extract($, answer))
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, terms)
    const showArchive = await read($, isArchiveView)
    const todo = list.filter(t => !t.isDone)
    const done = list.filter(t => t.isDone)
    const shown = showArchive ? done : todo

    const toggle = (term: string) =>
      save($, all => all.map(t => (t.term === term ? { ...t, isDone: !t.isDone } : t)))

    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="tab-todo"
            label={`학습할 용어 (${todo.length})`}
            variant={showArchive ? 'secondary' : 'primary'}
            onPress={() => update($, isArchiveView, () => false)}
          />
          <Button
            key="tab-archive"
            label={`보관함 (${done.length})`}
            variant={showArchive ? 'primary' : 'secondary'}
            onPress={() => update($, isArchiveView, () => true)}
          />
        </Box>
        {shown.length === 0 && (
          <Text dimColor>
            {showArchive ? '보관함이 비어 있습니다.' : '아직 용어가 없습니다. /pm-terms scan 으로 이 세션을 훑어보세요.'}
          </Text>
        )}
        {shown.map(t => (
          <Box key={`row-${t.term}`} flexDirection="column" marginTop={1}>
            <Button key={`check-${t.term}`} plain onPress={() => toggle(t.term)}>
              {t.isDone ? '☑ ' : '☐ '}
              <Text bold>{t.term}</Text>
            </Button>
            <Text>  {t.meaning}</Text>
            <Text dimColor>  예) {t.example}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Term, TermsDb } from '../types'

const PANE = 'pm-terms'
const terms = atom({ plugin: 'phro-pm-terms', key: 'terms' } as const, [])
const isArchiveView = atom({ plugin: 'phro-pm-terms', key: 'isArchiveView' } as const, false)

const DB_PATH = '.claude/phro-pm-terms/terms.json'
const MAX_CANDIDATES = 40
const MAX_NEW = 8
const MAX_IGNORED = 5000

const STOPWORDS = new Set(
  'the and or of to in on for is are be it this that with as at by from an a if not no yes ok vs etc e g i e via per'.split(' '),
)

// Haiku sees only the unknown candidates, never the answer text or the known list.
// Pipe lines instead of JSON: fewer output tokens, and one bad line costs one term.
const SYSTEM = `You curate a glossary for an IT product manager (PM).
Input: comma-separated candidate words taken from an AI coding assistant's answer.
Rules:
- Keep only terms a non-engineer PM gains from knowing: acronyms, tech concepts, dev-process and infra jargon.
- Drop product/file/variable/function names, commands, generic English words, numbers.
- Merge candidates that name the same thing (e.g. "hot", "reload" -> "Hot reload"; "CI" + "Continuous Integration") into one term.
- At most ${MAX_NEW} terms. Output nothing else.
Format, one term per line, Korean text for meaning and example:
term | aliases separated by ; (full name, Korean name, spelling variants; may be empty) | meaning (one sentence, max 60 chars) | example (one real-world use, max 60 chars)
If none qualify, output a single line: -`

/** The dedup key: case, spaces, punctuation and a parenthesized note never make a term new. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s\-_./·:'"`]/g, '')
}

export function emptyDb(): TermsDb {
  return { version: 1, terms: [], ignored: [] }
}

function seenKeys(db: TermsDb): Set<string> {
  const seen = new Set(db.ignored)
  for (const t of db.terms) {
    seen.add(t.key)
    for (const a of t.aliases) seen.add(a)
  }
  return seen
}

// ponytail: regex candidates catch acronyms, `code` words and English runs inside Korean text;
// a concept written only in Korean (멱등성) is missed — add a Hangul noun pass if that matters
export function candidates(text: string, db: TermsDb): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,5}(?:\/[A-Z]{1,5})?(?=s?\b)/g)) found.push(m[0])
  for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9 -]{1,29})`/g)) found.push(m[1]!)
  const hangul = (text.match(/[가-힣]/g) ?? []).length
  if (hangul > text.length * 0.15) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+#]*(?:[ -][A-Za-z][A-Za-z0-9+#]*){0,2}/g)) {
      found.push(m[0])
    }
  }

  const seen = seenKeys(db)
  const out: string[] = []
  for (const raw of found) {
    const word = raw.trim()
    const key = normalize(word)
    if (key.length < 2 || key.length > 40 || /^\d+$/.test(key)) continue
    if (STOPWORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

export type Parsed = { term: string; aliases: string[]; meaning: string; example: string }

export function parseReply(text: string): Parsed[] {
  const out: Parsed[] = []
  for (const line of text.split('\n')) {
    const cells = line.split('|').map(c => c.trim())
    if (cells.length !== 4) continue
    const [term, aliases, meaning, example] = cells as [string, string, string, string]
    if (!term || !meaning || !example) continue
    out.push({ term, aliases: aliases.split(';').map(a => a.trim()).filter(Boolean), meaning, example })
  }
  return out
}

/** Adds the new terms (deduped by key and aliases) and ignores every candidate no term claimed. */
export function merge(db: TermsDb, asked: readonly string[], parsed: readonly Parsed[]): { db: TermsDb; added: number } {
  const seen = seenKeys(db)
  const fresh: Term[] = []
  const claimed = new Set<string>()
  for (const p of parsed) {
    const key = normalize(p.term)
    const aliases = [...new Set(p.aliases.map(normalize))].filter(a => a && a !== key)
    for (const k of [key, ...aliases]) claimed.add(k)
    if (!key || [key, ...aliases].some(k => seen.has(k))) continue
    for (const k of [key, ...aliases]) seen.add(k)
    fresh.push({ key, term: p.term, aliases, meaning: p.meaning, example: p.example, isDone: false })
  }
  const words = (s: string) => s.toLowerCase().split(/[ -]/).map(normalize)
  const claimedWords = new Set(parsed.flatMap(p => words(p.term)))
  const rejected = asked
    .map(normalize)
    .filter(k => !claimed.has(k) && !claimedWords.has(k) && !seen.has(k))
  return {
    db: {
      version: 1,
      terms: [...fresh, ...db.terms],
      ignored: [...db.ignored, ...rejected].slice(-MAX_IGNORED),
    },
    added: fresh.length,
  }
}

async function dbPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) throw new Error('pm-terms: neither USERPROFILE nor HOME is set')
  return `${home}/${DB_PATH}`
}

async function load($: EngineInterface): Promise<TermsDb> {
  const path = await dbPath($)
  const exists = await $.fs.stat(path).then(
    () => true,
    () => false,
  )
  if (!exists) return emptyDb()
  // a corrupt file throws here instead of being overwritten with an empty list
  const db = JSON.parse(await $.fs.read(path)) as TermsDb
  return { version: 1, terms: db.terms ?? [], ignored: db.ignored ?? [] }
}

async function save($: EngineInterface, db: TermsDb) {
  await $.fs.write(await dbPath($), JSON.stringify(db, null, 1) + '\n')
  await update($, terms, () => db.terms)
}

// One read-modify-write at a time, so two extractions never miss each other's terms.
// ponytail: module-level queue, reset on reload; fine for one session writing the file
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

function extract($: EngineInterface, text: string): Promise<number> {
  return serial(async () => {
    const db = await load($)
    const asked = candidates(text, db)
    if (asked.length === 0) return 0

    const r = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: asked.join(', '),
      maxTokens: 120 * MAX_NEW,
      effort: 'low',
      timeoutMs: 30000,
    })
    if (!r.isAnswered) return 0 // nothing judged, nothing ignored

    const { db: next, added } = merge(db, asked, parseReply(r.text))
    await save($, next)
    if (added > 0) $.ui.toast(`📘 PM 용어 ${added}개 추가 — /pm-terms`)
    return added
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const db = await serial(() => load($))
    await update($, terms, () => db.terms)
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

    const toggle = (key: string) =>
      serial(async () => {
        const db = await load($)
        await save($, { ...db, terms: db.terms.map(t => (t.key === key ? { ...t, isDone: !t.isDone } : t)) })
      })

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
          <Box key={`row-${t.key}`} flexDirection="column" marginTop={1}>
            <Button key={`check-${t.key}`} plain onPress={() => toggle(t.key)}>
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

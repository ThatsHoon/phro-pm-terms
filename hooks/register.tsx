import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Status, Term, TermsDb, Usage } from '../types'

const PANE = 'pm-terms'
const terms = atom({ plugin: 'phro-pm-terms', key: 'terms' } as const, [])
const tab = atom({ plugin: 'phro-pm-terms', key: 'tab' } as const, 'todo')

const DB_PATH = '.claude/phro-pm-terms/terms.json'
// The file is the one source of truth shared by every session; each polls its mtime.
const POLL_MS = 3000
const MAX_CANDIDATES = 40
const MAX_NEW = 8
const MAX_IGNORED = 5000
const MAX_SCAN_BATCHES = 5

const STOPWORDS = new Set(
  'the and or of to in on for is are be it this that with as at by from an a if not no yes ok vs etc e g i e via per'.split(' '),
)

// Haiku sees only the unknown candidates, never the answer text or the known list.
// Pipe lines instead of JSON: fewer output tokens, and one bad line costs one term.
const SYSTEM = `You curate a glossary for an IT product manager (PM).
Input: comma-separated candidate words taken from an AI coding assistant's answer.
Rules:
- Keep only terms a non-engineer PM gains from knowing: acronyms, tech concepts, dev-process and infra jargon.
- Drop product, brand, repo, file, variable and function names, CLI commands and subcommands (e.g. "plugin update", "marketplace add"), generic English words, numbers.
- Use only the given candidates; never add terms that are not among them.
- Merge candidates that name the same thing (e.g. "hot", "reload" -> "Hot reload"; "CI" + "Continuous Integration") into one term.
- At most ${MAX_NEW} terms. Output nothing else.
- If the term is an acronym or abbreviation, write it with its English full name in parentheses, no space: "WER(Word Error Rate)", "CI/CD(Continuous Integration/Continuous Delivery)", "bf16(Brain Floating Point 16)". A term already spelled out ("Hot reload", "Smoke test") stays as is.
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
    const short = initials(t.term) // terms saved before initials became aliases
    if (short) seen.add(short)
  }
  return seen
}

/** Prose only: code, inline code, URLs and paths name things, they do not explain them. */
export function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // paths: two or more separators, or one plus a file extension ("CI/CD" stays)
    .replace(/(?:[\w.~:-]*[\\/]){2,}[\w.-]*|[\w.-]+[\\/][\w-]*\.\w+/g, ' ')
}

// Lookarounds keep a token whole: one glued to a word character, slash, @, $, dash or
// a ".ext" is part of an identifier (repo/name, --flag, file.ts, 27ea05f) and is skipped.
const ACRONYM = /(?<![\w/@$.-])[A-Z][A-Z0-9]{1,5}(?:\/[A-Z]{1,5})?(?=s?(?![\w/@(]|\.\w))/g
const ENGLISH_RUN = /(?<![\w/@$.-])[A-Za-z][A-Za-z0-9+#]*(?:[ -][A-Za-z][A-Za-z0-9+#]*){0,2}(?![\w/@(]|\.\w)/g

/** A commit hash or similar id: hex only, with a digit. */
function isIdLike(word: string): boolean {
  return /\d/.test(word) && /^[0-9a-f]{5,}$/i.test(word)
}

// ponytail: regex candidates catch acronyms and English runs inside Korean prose;
// a concept written only in Korean (멱등성) is missed — add a Hangul noun pass if that matters
export function candidates(text: string, db: TermsDb): string[] {
  const body = prose(text)
  const found = [...body.matchAll(ACRONYM)].map(m => m[0])
  const hangul = (body.match(/[가-힣]/g) ?? []).length
  if (hangul > body.length * 0.15) found.push(...[...body.matchAll(ENGLISH_RUN)].map(m => m[0]))

  const seen = seenKeys(db)
  const out: string[] = []
  for (const raw of found) {
    const word = raw.trim()
    const key = normalize(word)
    if (key.length < 2 || key.length > 40 || /^\d+$/.test(key) || isIdLike(word)) continue
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

/** "Continuous Integration" -> "ci": lets an acronym and its spelled-out form meet. */
// ponytail: initials can collide (Hot reload vs HR); fine for a PM glossary, drop if it misfires
export function initials(term: string): string | undefined {
  // "WER(Word Error Rate)": the name is WER; its full name becomes an alias in merge()
  const words = term.replace(/\([^)]*\)/g, ' ').split(/[\s-]+/).filter(w => /^[A-Za-z]/.test(w))
  return words.length >= 2 && words.length <= 6 ? words.map(w => w[0]!.toLowerCase()).join('') : undefined
}

/**
 * Adds the new terms and ignores every candidate no term claimed. A term is new only when
 * none of its names (key, aliases, initials) is already known in any tab, removed included;
 * the meaning and example Haiku wrote never matter, so a reworded explanation is no new term.
 */
export function merge(db: TermsDb, asked: readonly string[], parsed: readonly Parsed[]): { db: TermsDb; added: number } {
  const seen = seenKeys(db)
  const fresh: Term[] = []
  const claimed = new Set<string>()
  for (const p of parsed) {
    const key = normalize(p.term)
    const spelled = [...p.term.matchAll(/\(([^)]*)\)/g)].map(m => normalize(m[1]!)) // "WER(Word Error Rate)" -> worderrorrate
    const names = [...p.aliases.map(normalize), ...spelled, initials(p.term) ?? '']
    const aliases = [...new Set(names)].filter(a => a && a !== key)
    for (const k of [key, ...aliases]) claimed.add(k)
    if (!key || [key, ...aliases].some(k => seen.has(k))) continue
    for (const k of [key, ...aliases]) seen.add(k)
    fresh.push({ key, term: p.term, aliases, meaning: p.meaning, example: p.example, status: 'todo' })
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

export function addUsage(total: Usage | undefined, r: ModelCompleteResult): Usage {
  const t = total ?? { calls: 0, failed: 0, input: 0, output: 0, since: new Date().toISOString().slice(0, 10) }
  return {
    ...t,
    calls: t.calls + 1,
    failed: t.failed + (r.isAnswered ? 0 : 1),
    input: t.input + r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens,
    output: t.output + r.usage.output_tokens,
  }
}

export function formatUsage(u: Usage | undefined): string {
  if (!u) return 'No Haiku calls yet.'
  const per = (n: number) => Math.round(n / Math.max(1, u.calls))
  return (
    `Since ${u.since}: ${u.calls} Haiku calls (${u.failed} failed), ` +
    `${u.input} input + ${u.output} output tokens (avg ${per(u.input)} in / ${per(u.output)} out per call).`
  )
}

async function dbPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) throw new Error('neither USERPROFILE nor HOME is set')
  return `${home}/${DB_PATH}`
}

/** Older files carried `isDone` instead of `status`. */
type StoredTerm = Omit<Term, 'status'> & { status?: Status; isDone?: boolean }

export function migrate(raw: { terms?: StoredTerm[]; ignored?: string[] }): TermsDb {
  const terms = (raw.terms ?? []).map(({ isDone, status, ...t }): Term => ({
    ...t,
    status: status ?? (isDone ? 'done' : 'todo'),
  }))
  return { version: 1, terms, ignored: raw.ignored ?? [] }
}

async function load($: EngineInterface): Promise<TermsDb> {
  const path = await dbPath($)
  const exists = await $.fs.stat(path).then(
    () => true,
    () => false,
  )
  if (!exists) return emptyDb()
  // a corrupt file throws here, so nothing below ever overwrites it with an empty list
  return migrate(JSON.parse(await $.fs.read(path)))
}

// mtime of the file as this session last read or wrote it; another session's write moves it
let lastMtime = -1

async function mtime($: EngineInterface): Promise<number> {
  return $.fs.stat(await dbPath($)).then(
    s => s.mtimeMs,
    () => 0,
  )
}

async function save($: EngineInterface, db: TermsDb) {
  await $.fs.write(await dbPath($), JSON.stringify(db, null, 1) + '\n')
  lastMtime = await mtime($)
  await update($, terms, () => db.terms)
}

// One read-modify-write at a time within this session.
// ponytail: in-process queue; two sessions writing at once can still race in the ms between
// load and write (the Haiku call is outside that window) — a file lock if that ever bites
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** Picks up what another session wrote: the pane redraws from the file whenever its mtime moved. */
function refresh($: EngineInterface): Promise<void> {
  return serial(async () => {
    const now = await mtime($)
    if (now === lastMtime) return
    lastMtime = now // set first: a corrupt file is reported once per change, not every poll
    const db = await load($)
    await update($, terms, () => db.terms)
  })
}

/** Asks Haiku about one batch of unseen candidates; -1 when there were none to ask. */
async function extract($: EngineInterface, text: string): Promise<number> {
  const asked = candidates(text, await serial(() => load($)))
  if (asked.length === 0) return -1

  const r = await $.model.complete({
    model: 'haiku',
    system: SYSTEM,
    prompt: asked.join(', '),
    maxTokens: 120 * MAX_NEW,
    effort: 'low',
    timeoutMs: 30000,
  })
  await serial(async () => $.store.set('usage', addUsage((await $.store.get('usage')) as Usage | undefined, r)))
  if (!r.isAnswered) return 0 // nothing judged, nothing ignored

  // merge into the file as it is now, not as it was before the call
  const added = await serial(async () => {
    const { db, added } = merge(await load($), asked, parseReply(r.text))
    await save($, db)
    return added
  })
  if (added > 0) $.ui.toast(`📘 PM 용어 ${added}개 추가 — /pm-terms`)
  return added
}

/** Moves one term to a tab; idempotent, so a press on a stale row never flips it back. */
function setStatus($: EngineInterface, key: string, status: Status): Promise<void> {
  return serial(async () => {
    const db = await load($)
    await save($, { ...db, terms: db.terms.map(t => (t.key === key ? { ...t, status } : t)) })
  })
}

function reportFailure($: EngineInterface, err: unknown) {
  $.ui.toast(`pm-terms: ${DB_PATH} 를 읽거나 쓰지 못했습니다 (${String(err).slice(0, 120)})`)
}

const TABS: { status: Status; label: string; empty: string }[] = [
  { status: 'todo', label: '배울 용어', empty: '아직 용어가 없습니다. /pm-terms scan 으로 이 세션을 훑어보세요.' },
  { status: 'done', label: '보관', empty: '보관한 용어가 없습니다.' },
  { status: 'removed', label: '제거', empty: '제거한 용어가 없습니다. 제거한 용어는 다시 추가되지 않습니다.' },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pm-terms',
      description: 'Open the PM terms checklist ("scan" extracts from this session, "stats" shows Haiku token use)',
      argumentHint: '[scan|stats]',
    })
    await refresh($).catch(err => reportFailure($, err))
    $.clock.every(POLL_MS, () => {
      refresh($).catch(err => reportFailure($, err))
    })
    return next(e)
  })

  on('command.run', { command: 'pm-terms' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats') return { text: formatUsage((await $.store.get('usage')) as Usage | undefined) }

    await $.ui.open({ id: PANE, title: 'PM 용어' })
    if (arg !== 'scan') return { text: 'PM terms pane opened.' }

    const answers = (await $.session.messages())
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n\n')
    let total = 0
    for (let i = 0; i < MAX_SCAN_BATCHES; i++) {
      const added = await extract($, answers)
      if (added < 0) break
      total += added
    }
    return { text: `Scanned this session: ${total} new PM terms.` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer) {
      const answer = e.answer
      $.clock.after(0, () => {
        extract($, answer).catch(err => reportFailure($, err))
      })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, terms)
    const current = await read($, tab)
    const shown = list.filter(t => t.status === current)
    const move = (key: string, status: Status) => () => setStatus($, key, status).catch(err => reportFailure($, err))

    return (
      <Box flexDirection="column">
        <Box>
          {TABS.map(t => (
            <Button
              key={`tab-${t.status}`}
              label={`${t.label} (${list.filter(x => x.status === t.status).length})`}
              variant={t.status === current ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => t.status)}
            />
          ))}
        </Box>
        {shown.length === 0 && <Text dimColor>{TABS.find(t => t.status === current)!.empty}</Text>}
        {shown.map(t => (
          <Box key={`row-${t.key}`} flexDirection="column" marginTop={1}>
            <Box>
              {current === 'removed' ? (
                <Text bold>✕ {t.term} </Text>
              ) : (
                <Button key={`check-${t.key}`} plain onPress={move(t.key, current === 'todo' ? 'done' : 'todo')}>
                  {current === 'done' ? '☑ ' : '☐ '}
                  <Text bold>{t.term}</Text>
                </Button>
              )}
              {current === 'removed' ? (
                <Button key={`restore-${t.key}`} label="복원" onPress={move(t.key, 'todo')} />
              ) : (
                <Button key={`remove-${t.key}`} label="제거" onPress={move(t.key, 'removed')} />
              )}
            </Box>
            <Text>  {t.meaning}</Text>
            <Text dimColor>  예) {t.example}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

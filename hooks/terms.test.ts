import { expect, test } from 'claude-code/testing'

import { addUsage, candidates, emptyDb, formatUsage, fromPmTerms, initials, merge, migrate, normalize, parseReply, sameTerms, visible } from './register'

test('normalize folds case, spacing, punctuation and notes', async () => {
  expect(normalize('Hot reload')).toBe(normalize('hot-reload'))
  expect(normalize('API (Application Programming Interface)')).toBe('api')
  expect(normalize('CI/CD')).toBe('cicd')
})

test('candidates skip known terms, aliases and ignored words', async () => {
  const db = merge(emptyDb(), ['hot', 'reload', 'foo'], [
    { term: 'Hot reload', aliases: ['핫 리로드'], meaning: 'm', example: 'e' },
  ]).db
  const text = '수정하면 `hot-reload` 로 반영되고 API 와 JSON 을 씁니다. foo 도 있음. 핫 리로드 는 빠름.'
  expect(candidates(text, db)).toEqual(['API', 'JSON'])
  expect(candidates('짧은 답', db)).toEqual([])
})

test('parseReply keeps four-cell lines only', async () => {
  const reply = 'API | Application Programming Interface;에이피아이 | 뜻 | 예시\n-\nbad | line\n | x | y | z'
  expect(parseReply(reply)).toEqual([
    { term: 'API', aliases: ['Application Programming Interface', '에이피아이'], meaning: '뜻', example: '예시' },
  ])
})

test('merge dedupes by key and alias, ignores unclaimed candidates', async () => {
  const first = merge(emptyDb(), ['CI', 'xyz'], [
    { term: 'CI', aliases: ['Continuous Integration'], meaning: 'm', example: 'e' },
  ])
  expect(first.added).toBe(1)
  expect(first.db.ignored).toEqual(['xyz'])

  const second = merge(first.db, ['Continuous Integration'], [
    { term: 'Continuous Integration', aliases: [], meaning: 'm2', example: 'e2' },
  ])
  expect(second.added).toBe(0)
  expect(second.db.terms.length).toBe(1)
})

test('candidates skip code, URLs, paths, ids and identifier fragments', async () => {
  const text = [
    '커밋 27ea05f 와 a8b178c 를 https://github.com/ThatsHoon/phro 에 push 했고 CI/CD 와 OAuth 를 씁니다.',
    '`phro-pm-terms` 와 hooks/register.tsx 수정, ThatsHoon/phro 저장소, --force 옵션.',
    '```bash',
    'claude plugin update phro-pm-terms@phro',
    '```',
  ].join('\n')
  expect(candidates(text, emptyDb())).toEqual(['CI/CD', 'push', 'OAuth'])
})

test('usage adds up across calls', async () => {
  const ok = { isAnswered: true, text: '', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as const
  const u = addUsage(addUsage(undefined, ok as never), { ...ok, isAnswered: false, reason: 'empty-reply' } as never)
  expect([u.calls, u.failed, u.input, u.output]).toEqual([2, 1, 200, 40])
  expect(formatUsage(u)).toContain('avg 100 in / 20 out')
})

test('a reworded explanation or another name of a known term is no new term', async () => {
  const base = merge(emptyDb(), ['API'], [{ term: 'API', aliases: [], meaning: '프로그램끼리 대화하는 규약', example: 'e' }]).db
  const reworded = merge(base, ['API'], [{ term: 'API', aliases: [], meaning: '전혀 다른 설명', example: '다른 예시' }])
  expect(reworded.added).toBe(0)
  expect(reworded.db.terms[0]!.meaning).toBe('프로그램끼리 대화하는 규약')

  const ci = merge(emptyDb(), ['CI'], [{ term: 'CI', aliases: [], meaning: 'm', example: 'e' }]).db
  expect(merge(ci, ['x'], [{ term: 'Continuous Integration', aliases: [], meaning: 'm', example: 'e' }]).added).toBe(0)
  expect(initials('Continuous Integration')).toBe('ci')
  expect(initials('API')).toBe(undefined)
})

test('an acronym written with its full name keeps the acronym as key and the full name as alias', async () => {
  const db = merge(emptyDb(), ['WER'], [{ term: 'WER(Word Error Rate)', aliases: [], meaning: 'm', example: 'e' }]).db
  expect(db.terms[0]!.key).toBe('wer')
  expect(db.terms[0]!.aliases).toEqual(['worderrorrate'])
  expect(initials('WER(Word Error Rate)')).toBe(undefined)
  expect(merge(db, ['x'], [{ term: 'Word Error Rate', aliases: [], meaning: 'm', example: 'e' }]).added).toBe(0)
  expect(candidates('WER 이 낮다', db)).toEqual([])
})

test('removed terms still count as known', async () => {
  const db = merge(emptyDb(), ['CI'], [{ term: 'CI', aliases: [], meaning: 'm', example: 'e' }]).db
  const removed = { ...db, terms: db.terms.map(t => ({ ...t, status: 'removed' as const })) }
  expect(merge(removed, ['CI'], [{ term: 'ci', aliases: [], meaning: 'm2', example: 'e2' }]).added).toBe(0)
  expect(candidates('CI 를 씁니다', removed)).toEqual([])
})

test('migrate turns isDone into a status', async () => {
  const db = migrate({ terms: [
    { key: 'a', term: 'A', aliases: [], meaning: 'm', example: 'e', isDone: true } as never,
    { key: 'b', term: 'B', aliases: [], meaning: 'm', example: 'e', isDone: false } as never,
  ] })
  expect(db.terms.map(t => t.status)).toEqual(['done', 'todo'])
  expect('isDone' in db.terms[0]!).toBe(false)
})

test('an extraction that adds no term leaves the list as it was, so the pane is not redrawn', async () => {
  const db = merge(emptyDb(), ['api'], [{ term: 'API(Application Programming Interface)', aliases: [], meaning: 'm', example: 'e' }]).db
  const next = merge(db, ['foo', 'bar'], []).db
  expect(next.ignored.length).toBe(db.ignored.length + 2)
  expect(sameTerms(next.terms, db.terms)).toBe(true)
  const more = merge(next, ['ci'], [{ term: 'CI(Continuous Integration)', aliases: [], meaning: 'm', example: 'e' }]).db
  expect(sameTerms(more.terms, next.terms)).toBe(false)
})

test('what Haiku is sent does not grow with the glossary', async () => {
  let db = emptyDb()
  for (let i = 0; i < 300; i++) db = merge(db, [], [{ term: `Term ${i} word`, aliases: [], meaning: 'm', example: 'e' }]).db
  const words = Array.from({ length: 60 }, (_, i) => 'Q' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))
  expect(candidates('새 답변입니다 ' + words.join(' ') + ' 끝', db).length).toBe(40)
})

test('search matches term, meaning, example and other names; order sorts by time, abc or 가나다', async () => {
  const t = (term: string, aliases: string[], meaning: string) =>
    ({ key: normalize(term), term, aliases, meaning, example: 'e', status: 'todo' as const })
  // stored newest first
  const list = [
    t('WER(Word Error Rate)', ['worderrorrate', '단어오류율'], '음성 인식 오류 비율'),
    t('API(Application Programming Interface)', ['applicationprogramminginterface'], '프로그램끼리 부르는 약속'),
    t('Hot reload', ['핫리로드'], '고치면 바로 반영'),
    { ...t('CI', [], '자동 빌드'), status: 'done' as const },
  ]
  const names = (r: { term: string }[]) => r.map(x => x.term.split('(')[0])
  expect(names(visible(list, 'todo', '', 'time'))).toEqual(['WER', 'API', 'Hot reload'])
  expect(names(visible(list, 'todo', '', 'abc'))).toEqual(['API', 'Hot reload', 'WER'])
  expect(names(visible(list, 'todo', '', 'ganada'))).toEqual(['WER', 'Hot reload', 'API']) // 단어오류율, 핫리로드, 그 뒤 한글 이름 없는 API
  expect(names(visible(list, 'todo', 'error', 'time'))).toEqual(['WER'])
  expect(names(visible(list, 'todo', '핫 리로드', 'time'))).toEqual(['Hot reload'])
  expect(names(visible(list, 'todo', '반영', 'time'))).toEqual(['Hot reload'])
  expect(names(visible(list, 'todo', 'ci', 'time'))).toEqual([]) // other tab
  expect(names(visible(list, 'done', 'ci', 'time'))).toEqual(['CI'])
})

test('the old PM list carries its terms and tabs over but forgets what the PM rule rejected', async () => {
  const pm = migrate({ terms: [{ key: 'api', term: 'API', aliases: [], meaning: 'm', example: 'e', isDone: true }], ignored: ['mlflow', 'kubernetes'] })
  const board = fromPmTerms(pm)
  expect(board.terms.map(t => [t.term, t.status])).toEqual([['API', 'done']])
  expect(board.ignored).toEqual([])
  expect(candidates('MLflow 와 Kubernetes 를 씁니다', board)).toEqual(['MLflow', 'Kubernetes'])
})

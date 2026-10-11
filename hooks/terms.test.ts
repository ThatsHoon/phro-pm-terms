import { expect, test } from 'claude-code/testing'

import { candidates, emptyDb, merge, normalize, parseReply } from './register'

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

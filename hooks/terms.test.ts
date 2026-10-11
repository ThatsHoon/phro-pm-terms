import { expect, test } from 'claude-code/testing'

import { parseTerms } from './register'

test('parseTerms keeps valid, new, unique terms', async () => {
  const reply = `Here:
[{"term":"API","meaning":"m1","example":"e1"},
 {"term":"Hook","meaning":"m2","example":"e2"},
 {"term":"api","meaning":"dup","example":"dup"},
 {"term":"CI","meaning":3,"example":"bad"}]`
  expect(parseTerms(reply, ['hook'])).toEqual([
    { term: 'API', meaning: 'm1', example: 'e1', isDone: false },
  ])
  expect(parseTerms('[]', [])).toEqual([])
  expect(parseTerms('no json', [])).toEqual([])
  expect(parseTerms('[{broken', [])).toEqual([])
})

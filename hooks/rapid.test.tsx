import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'pm-terms',
  props: { title: 'PM 용어', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as never

test('tabs pressed many times at once leave the pane working', async $ => {
  const ui = await $.ui.mount({ plugin: 'phro-pm-terms', surface: 'desktop', ...(PANE as object) } as never)
  const keys = ['tab-done', 'tab-removed', 'tab-todo', 'tab-todo']
  await Promise.allSettled(Array.from({ length: 40 }, (_, i) => ui.press({ key: keys[i % 4]! })))
  await ui.press({ key: 'tab-removed' })
  expect(await ui.find({ type: 'Text', text: /제거한 용어가 없습니다/ })).toBeDefined()
  await ui.press({ key: 'tab-todo' })
  expect(await ui.find({ type: 'Text', text: /아직 용어가 없습니다/ })).toBeDefined()
  await ui.unmount()
})

import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'pm-terms',
  props: { title: 'PM 용어', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as never

test('the pane draws on every surface with input, empty search or not', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'phro-pm-terms', surface, ...(PANE as object) } as never)
    expect(await ui.find({ type: 'Text', text: /아직 용어가 없습니다/ })).toBeDefined()
    await ui.input({ key: 'search', text: 'api' })
    expect(await ui.find({ type: 'Text', text: /검색 결과 0개/ })).toBeDefined()
    await ui.press({ key: 'clear' })
    expect(await ui.find({ type: 'Text', text: /아직 용어가 없습니다/ })).toBeDefined()
    await ui.unmount()
  }
})

export type Term = { term: string; meaning: string; example: string; isDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'phro-pm-terms': { terms: Term[]; isArchiveView: boolean }
  }
}

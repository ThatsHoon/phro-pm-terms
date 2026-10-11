export type Term = {
  /** normalize(term): the dedup key */
  key: string
  term: string
  /** normalized other names (full name, Korean name, spelling variants) */
  aliases: string[]
  meaning: string
  example: string
  isDone: boolean
}

/** ~/.claude/phro-pm-terms/terms.json */
export type TermsDb = {
  version: 1
  terms: Term[]
  /** normalized candidates Haiku already judged not PM-worthy; never sent again */
  ignored: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'phro-pm-terms': { terms: Term[]; isArchiveView: boolean }
  }
}

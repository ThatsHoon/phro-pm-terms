/** Which tab a term sits in: to learn, archived, or removed. Removed terms stay for dedup. */
export type Status = 'todo' | 'done' | 'removed'

export type Term = {
  /** normalize(term): the dedup key */
  key: string
  term: string
  /** normalized other names (full name, Korean name, spelling variants, initials) */
  aliases: string[]
  meaning: string
  example: string
  status: Status
}

/** ~/.claude/phro-pm-terms/terms.json */
export type TermsDb = {
  version: 1
  terms: Term[]
  /** normalized candidates Haiku already judged not PM-worthy; never sent again */
  ignored: string[]
}

/** How the pane sorts a tab: newest first (stored order), Latin names A-Z first, Korean names 가-힣 first. */
export type Order = 'time' | 'abc' | 'ganada'

/** Cumulative Haiku spend, kept in $.store under "usage". */
export type Usage = { calls: number; failed: number; input: number; output: number; since: string }

declare module 'claude-code' {
  interface PluginState {
    'phro-pm-terms': { terms: Term[]; tab: Status; query: string; order: Order; limit: number }
  }
}

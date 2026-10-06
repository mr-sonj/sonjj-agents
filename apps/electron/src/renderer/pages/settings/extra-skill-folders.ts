/**
 * Rows of the extra skill folders editor (ExtraSkillFolders.tsx). A row knows the entry it
 * shows from the workspace config; a row the server has not taken (new, or rejected) has none.
 * A change saves the saved entries plus that one change, so a rejected row never blocks edits
 * or removals in other rows.
 */

export interface FolderRow {
  value: string
  /** The saved entry this row shows; undefined for a row not saved yet */
  saved?: string
}

/**
 * Rows for a saved list: one per saved entry, then the rows of `previous` holding text the
 * server has not taken (a rejected entry stays as typed until it is fixed or removed).
 */
export function rowsForSaved(saved: string[], previous: FolderRow[] = []): FolderRow[] {
  const pending = previous.filter(row => {
    const value = row.value.trim()
    return value !== '' && value !== row.saved && !saved.includes(value)
  })
  return [...saved.map(dir => ({ value: dir, saved: dir })), ...pending.map(row => ({ value: row.value }))]
}

/** The list to save when row `index` holds `value`; every other row keeps its saved entry. */
export function listWithRow(rows: FolderRow[], index: number, value: string): string[] {
  return rows.flatMap((row, i) => {
    const entry = i === index ? value : row.saved
    return entry?.trim() ? [entry] : []
  })
}

/** The list to save without row `index`. */
export function listWithoutRow(rows: FolderRow[], index: number): string[] {
  return rows.flatMap((row, i) => (i !== index && row.saved !== undefined ? [row.saved] : []))
}

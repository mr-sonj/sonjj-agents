/**
 * Rows of the extra skill folders editor (ExtraSkillFolders.tsx). A row knows the entry it
 * shows from the workspace config; a row the server has not taken (new, or rejected) has none.
 *
 * A change saves the saved entries plus that one change, so a rejected row never blocks edits
 * or removals in other rows. Saves run one at a time, each built from the rows as they are when
 * it starts, so a row typed just before another row is removed or picked is not lost. The
 * server may write an entry another way (`/Users/me/x` as `~/x`), so the row that was saved
 * takes the entry the server returned rather than being matched by its text.
 */

export interface FolderRow {
  /** Stable for the row's life (React key, focus) */
  id: number
  value: string
  /** The saved entry this row shows; undefined for a row not saved yet */
  saved?: string
}

/** Saves the whole list; resolves to the list the server saved, or null when it was rejected */
export type SaveFolders = (dirs: string[]) => Promise<string[] | null>

export interface FolderList {
  rows(): FolderRow[]
  /** Add an empty row; returns its id */
  add(): number
  edit(id: number, value: string): void
  /** Save the row's text (on blur, Enter, or after Browse filled it in) */
  commit(id: number): Promise<void>
  remove(id: number): Promise<void>
  /** Take in the list saved in the workspace config (loaded, or saved elsewhere) */
  sync(saved: string[]): void
}

export function createFolderList(save: SaveFolders, onChange: (rows: FolderRow[]) => void): FolderList {
  let rows: FolderRow[] = []
  // The list the server has
  let saved: string[] = []
  let lastId = 0
  const nextId = () => ++lastId
  let queue: Promise<void> = Promise.resolve()

  const setRows = (next: FolderRow[]) => {
    rows = next
    onChange(rows)
  }

  // Saves the list built when the job starts; `id` is the row whose text is saved, if any
  const enqueueSave = (id?: number): Promise<void> => {
    const job = async () => {
      const row = id === undefined ? undefined : rows.find(r => r.id === id)
      if (id !== undefined && !row) return // removed meanwhile; its removal saves
      const list = row ? listWithRow(rows, row.id, row.value) : listWithRow(rows)
      if (sameList(list, saved)) return
      const result = await save(list)
      if (!result) return
      saved = result
      setRows(mergeSaved(rows, result, nextId, row && { id: row.id, value: row.value }))
    }
    queue = queue.then(job).catch(error => console.error('Failed to save extra skill folders:', error))
    return queue
  }

  return {
    rows: () => rows,
    add() {
      const id = nextId()
      setRows([...rows, { id, value: '' }])
      return id
    },
    edit(id, value) {
      setRows(rows.map(row => (row.id === id ? { ...row, value } : row)))
    },
    commit: id => enqueueSave(id),
    remove(id) {
      setRows(rows.filter(row => row.id !== id))
      return enqueueSave()
    },
    sync(list) {
      if (sameList(list, saved)) return
      saved = [...list]
      setRows(mergeSaved(rows, list, nextId))
    },
  }
}

/** The list to save: each row's saved entry, with row `id` holding `value` instead (blank removes it). */
export function listWithRow(rows: FolderRow[], id?: number, value?: string): string[] {
  return rows.flatMap(row => {
    const entry = (row.id === id ? value : row.saved)?.trim()
    return entry ? [entry] : []
  })
}

/**
 * Rows for a saved list, in place: a row keeps its text while the list still holds its saved
 * entry, the committed row takes the entry no other row holds (none when it repeated another
 * row or was emptied), rows not saved yet stay as typed, and entries no row holds are added.
 */
export function mergeSaved(
  rows: FolderRow[],
  saved: string[],
  nextId: () => number,
  committed?: { id: number; value: string },
): FolderRow[] {
  const unclaimed = [...saved]
  const claim = (entry: string) => {
    const index = unclaimed.indexOf(entry)
    if (index !== -1) unclaimed.splice(index, 1)
    return index !== -1
  }
  const kept = rows.filter(row => row.id === committed?.id || row.saved === undefined || claim(row.saved))
  const entry = committed ? unclaimed.shift() : undefined

  const merged = kept.flatMap(row => {
    if (row.id !== committed?.id) return [row]
    if (entry === undefined) return []
    // Show the entry as the server wrote it, unless the text changed while it was saving
    return [{ ...row, value: row.value === committed.value ? entry : row.value, saved: entry }]
  })
  return [...merged, ...unclaimed.map(dir => ({ id: nextId(), value: dir, saved: dir }))]
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

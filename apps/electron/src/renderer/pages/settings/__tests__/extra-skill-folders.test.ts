import { describe, it, expect } from 'bun:test'
import { createFolderList, type FolderRow } from '../extra-skill-folders'

/**
 * A stand-in for the workspace settings RPC: it rejects entries containing "typo", keeps the
 * first entry for each folder and writes entries under /home/me as ~/…, like the real server.
 */
function fakeServer(initial: string[] = []) {
  let saved = [...initial]
  const calls: string[][] = []
  const portable = (dir: string) => dir.replace(/^\/home\/me\//, '~/')
  return {
    saved: () => saved,
    calls,
    save: async (list: string[]): Promise<string[] | null> => {
      calls.push(list)
      await new Promise(resolve => setTimeout(resolve, 1))
      if (list.some(dir => dir.includes('typo'))) return null
      saved = Array.from(new Set(list.map(portable)))
      return saved
    },
  }
}

function setup(initial: string[] = []) {
  const server = fakeServer(initial)
  let rows: FolderRow[] = []
  const list = createFolderList(server.save, next => { rows = next })
  list.sync(initial)
  const view = () => rows.map(({ value, saved }) => (saved === undefined ? { value } : { value, saved }))
  const idOf = (value: string) => rows.find(row => row.value === value)!.id
  const addRow = (value: string) => {
    const id = list.add()
    list.edit(id, value)
    return id
  }
  return { server, list, view, idOf, addRow }
}

describe('extra skill folder list', () => {
  it('shows each saved entry as a saved row', () => {
    const { view } = setup(['~/a', '~/b'])
    expect(view()).toEqual([
      { value: '~/a', saved: '~/a' },
      { value: '~/b', saved: '~/b' },
    ])
  })

  it('shows a picked folder the way the server wrote it, without a leftover row', async () => {
    const { list, view, addRow, server } = setup()
    await list.commit(addRow('/home/me/x'))
    expect(view()).toEqual([{ value: '~/x', saved: '~/x' }])
    expect(server.saved()).toEqual(['~/x'])
  })

  it('keeps the row that was saved, so focus stays on it', async () => {
    const { list, addRow } = setup()
    const id = addRow('/home/me/x')
    await list.commit(id)
    expect(list.rows()[0].id).toBe(id)
  })

  it('drops a row that names a folder already listed', async () => {
    const { list, view, addRow, server } = setup(['~/x'])
    await list.commit(addRow('/home/me/x'))
    expect(view()).toEqual([{ value: '~/x', saved: '~/x' }])
    expect(server.saved()).toEqual(['~/x'])
  })

  it('keeps a rejected row as typed without blocking the other rows', async () => {
    const { list, view, idOf, addRow, server } = setup(['~/a'])
    await list.commit(addRow('~/typo'))
    expect(view()).toEqual([{ value: '~/a', saved: '~/a' }, { value: '~/typo' }])

    await list.remove(idOf('~/a'))
    expect(server.saved()).toEqual([])
    expect(view()).toEqual([{ value: '~/typo' }])
  })

  it('does not save when nothing changed', async () => {
    const { list, idOf, server } = setup(['~/a'])
    await list.commit(idOf('~/a'))
    const empty = list.add()
    await list.commit(empty)
    await list.remove(empty)
    expect(server.calls).toEqual([])
  })

  it('removes a saved entry when its row is emptied', async () => {
    const { list, view, idOf, server } = setup(['~/a', '~/b'])
    const id = idOf('~/a')
    list.edit(id, ' ')
    await list.commit(id)
    expect(server.saved()).toEqual(['~/b'])
    expect(view()).toEqual([{ value: '~/b', saved: '~/b' }])
  })

  it('keeps a row typed just before another row is removed', async () => {
    const { list, view, idOf, addRow, server } = setup(['~/a'])
    const typed = list.commit(addRow('~/b')) // the input loses focus...
    const removed = list.remove(idOf('~/a')) // ...because another row's remove button is clicked
    await Promise.all([typed, removed])
    expect(server.saved()).toEqual(['~/b'])
    expect(view()).toEqual([{ value: '~/b', saved: '~/b' }])
  })

  it('keeps a row typed just before a folder is picked for another row', async () => {
    const { list, view, idOf, addRow, server } = setup(['~/a'])
    const typed = list.commit(addRow('~/b'))
    const a = idOf('~/a')
    list.edit(a, '/home/me/p')
    const picked = list.commit(a)
    await Promise.all([typed, picked])
    expect(server.saved()).toEqual(['~/p', '~/b'])
    expect(view()).toEqual([
      { value: '~/p', saved: '~/p' },
      { value: '~/b', saved: '~/b' },
    ])
  })

  it('does not bring back a row removed while its save was running', async () => {
    const { list, view, addRow, server } = setup()
    const id = addRow('~/b')
    const typed = list.commit(id)
    const removed = list.remove(id)
    await Promise.all([typed, removed])
    expect(server.saved()).toEqual([])
    expect(view()).toEqual([])
  })

  it('keeps what is being typed in another row while a save runs', async () => {
    const { list, view, idOf, addRow, server } = setup(['~/a'])
    const saving = list.commit(addRow('~/c'))
    list.edit(idOf('~/a'), '~/a-typing')
    await saving
    expect(server.saved()).toEqual(['~/a', '~/c'])
    expect(view()).toEqual([
      { value: '~/a-typing', saved: '~/a' },
      { value: '~/c', saved: '~/c' },
    ])
  })

  it('takes in a list saved elsewhere and keeps rows not saved yet', () => {
    const { list, view, addRow } = setup(['~/a', '~/b'])
    addRow('~/typo')
    list.sync(['~/a', '~/c'])
    expect(view()).toEqual([
      { value: '~/a', saved: '~/a' },
      { value: '~/typo' },
      { value: '~/c', saved: '~/c' },
    ])
  })
})

import { describe, it, expect } from 'bun:test'
import { listWithoutRow, listWithRow, rowsForSaved } from '../extra-skill-folders'

describe('extra skill folder rows', () => {
  it('shows each saved entry as a saved row', () => {
    expect(rowsForSaved(['~/a', '~/b'])).toEqual([
      { value: '~/a', saved: '~/a' },
      { value: '~/b', saved: '~/b' },
    ])
  })

  it('keeps a rejected entry as typed after the saved ones', () => {
    const rows = [...rowsForSaved(['~/a']), { value: '~/typo' }]
    expect(rowsForSaved(['~/a', '~/b'], rows)).toEqual([
      { value: '~/a', saved: '~/a' },
      { value: '~/b', saved: '~/b' },
      { value: '~/typo' },
    ])
  })

  it('drops rows the saved list now holds, blank rows and saved rows left unedited', () => {
    const rows = [{ value: '~/gone', saved: '~/gone' }, { value: ' ~/b ' }, { value: '' }]
    expect(rowsForSaved(['~/b'], rows)).toEqual([{ value: '~/b', saved: '~/b' }])
  })

  it('saves a row with the other rows saved entries, not their pending text', () => {
    const rows = [{ value: '~/edited', saved: '~/a' }, { value: '~/new' }, { value: '~/typo' }]
    expect(listWithRow(rows, 1, '~/new')).toEqual(['~/a', '~/new'])
  })

  it('leaves a blank row out of the list it saves', () => {
    expect(listWithRow([...rowsForSaved(['~/a']), { value: '' }], 1, ' ')).toEqual(['~/a'])
  })

  it('removes a saved row even when another row was rejected', () => {
    const rows = [...rowsForSaved(['~/a', '~/b']), { value: '~/typo' }]
    expect(listWithoutRow(rows, 0)).toEqual(['~/b'])
  })

  it('removes the saved entry of an edited row', () => {
    const rows = [{ value: '~/edited', saved: '~/a' }, { value: '~/b', saved: '~/b' }]
    expect(listWithoutRow(rows, 0)).toEqual(['~/b'])
  })

  it('keeps the saved list when an unsaved row is removed', () => {
    expect(listWithoutRow([...rowsForSaved(['~/a']), { value: '~/typo' }], 1)).toEqual(['~/a'])
  })
})

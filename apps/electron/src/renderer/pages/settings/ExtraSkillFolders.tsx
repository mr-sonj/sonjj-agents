/**
 * ExtraSkillFolders
 *
 * Editable list of the workspace's extra skill folders (`extraSkillDirs`). A row is typed by
 * hand or filled with Browse, and is saved when it loses focus or on Enter; removing a row
 * saves at once. The server cleans up and checks the list, so a rejected row stays as typed
 * next to the error toast. Each save sends the saved entries plus the one change
 * (extra-skill-folders.ts), so a rejected row does not block the other rows.
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { SettingsCard } from '@/components/settings'
import { listWithoutRow, listWithRow, rowsForSaved, type FolderRow } from './extra-skill-folders'

interface ExtraSkillFoldersProps {
  /** Saved entries, as written in the workspace config */
  dirs: string[]
  /** Save the whole list */
  onSave: (dirs: string[]) => Promise<void>
}

const iconButton =
  'shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors'

export function ExtraSkillFolders({ dirs, onSave }: ExtraSkillFoldersProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<FolderRow[]>(() => rowsForSaved(dirs))
  // Row that gets focus when it mounts (a newly added one)
  const [addedIndex, setAddedIndex] = useState<number | null>(null)
  // Row the folder picker fills in; a ref because the native dialog's callback is made before a re-render
  const browseIndex = useRef(0)

  useEffect(() => setRows(previous => rowsForSaved(dirs, previous)), [dirs])

  // An empty row stays until it is filled or removed (Browse blurs it before the picker returns)
  const save = useCallback(async (list: string[]) => {
    const cleaned = list.map(dir => dir.trim())
    if (cleaned.length === dirs.length && cleaned.every((dir, i) => dir === dirs[i])) return
    await onSave(list)
  }, [dirs, onSave])

  const removeRow = (index: number) => {
    setRows(rows.filter((_, i) => i !== index))
    void save(listWithoutRow(rows, index))
  }

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(
    useCallback((path: string) => {
      const index = browseIndex.current
      setRows(current => current.map((row, i) => (i === index ? { ...row, value: path } : row)))
      void save(listWithRow(rows, index, path))
    }, [rows, save])
  )

  const browse = (index: number) => {
    browseIndex.current = index
    pickDirectory()
  }

  const addRow = () => {
    setAddedIndex(rows.length)
    setRows([...rows, { value: '' }])
  }

  const browsePath = rows[browseIndex.current]?.value

  return (
    <>
      <SettingsCard>
        {rows.map(({ value }, index) => (
          <div key={index} className="flex items-center gap-1.5 px-4 py-2.5">
            <Input
              value={value}
              autoFocus={index === addedIndex}
              placeholder="~/Projects/my-app/.agents/skills"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              onChange={(e) => setRows(rows.map((row, i) => (i === index ? { ...row, value: e.target.value } : row)))}
              onBlur={() => void save(listWithRow(rows, index, value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button type="button" className={iconButton} title={t('common.browse')} aria-label={t('common.browse')} onClick={() => browse(index)}>
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={iconButton}
              title={t('common.remove')}
              aria-label={t('common.remove')}
              onClick={() => removeRow(index)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
        <div className="px-4 py-2.5">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 h-8 px-3 text-sm rounded-lg bg-background shadow-minimal hover:bg-foreground/[0.02] transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('settings.workspace.addExtraSkillFolder')}
          </button>
        </div>
      </SettingsCard>
      <ServerDirectoryBrowser
        open={showServerBrowser}
        mode={serverBrowserMode}
        onSelect={confirmServerBrowser}
        onCancel={cancelServerBrowser}
        initialPath={browsePath || undefined}
      />
    </>
  )
}

/**
 * ExtraSkillFolders
 *
 * Editable list of the workspace's extra skill folders (`extraSkillDirs`). A row is typed by
 * hand or filled with Browse, and is saved when it loses focus or on Enter; removing a row
 * saves at once. The server cleans up and checks the list, so a rejected row stays as typed
 * next to the error toast. Saving and the rows' state live in extra-skill-folders.ts.
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Plus, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { SettingsCard } from '@/components/settings'
import { createFolderList, type FolderRow, type SaveFolders } from './extra-skill-folders'

interface ExtraSkillFoldersProps {
  /** Saved entries, as written in the workspace config */
  dirs: string[]
  /** Save the whole list; resolves to the list the server saved, or null when it was rejected */
  onSave: SaveFolders
}

const iconButton =
  'shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-colors'

export function ExtraSkillFolders({ dirs, onSave }: ExtraSkillFoldersProps) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<FolderRow[]>([])
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])
  const [list] = useState(() => createFolderList((next) => onSaveRef.current(next), setRows))
  // Row that gets focus when it mounts (a newly added one)
  const [addedId, setAddedId] = useState<number | null>(null)
  // Row the folder picker fills in; a ref because the native dialog's callback is made before a re-render
  const browseId = useRef<number | null>(null)

  useEffect(() => list.sync(dirs), [list, dirs])

  const {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
  } = useDirectoryPicker(
    useCallback((path: string) => {
      const id = browseId.current
      if (id === null) return
      list.edit(id, path)
      void list.commit(id)
    }, [list])
  )

  // An empty row stays until it is filled or removed (Browse blurs it before the picker returns)
  const browse = (id: number) => {
    browseId.current = id
    pickDirectory()
  }

  const addRow = () => setAddedId(list.add())

  const browsePath = rows.find(row => row.id === browseId.current)?.value

  return (
    <>
      <SettingsCard>
        {rows.map(({ id, value }) => (
          <div key={id} className="flex items-center gap-1.5 px-4 py-2.5">
            <Input
              value={value}
              autoFocus={id === addedId}
              placeholder="~/Projects/my-app/.agents/skills"
              spellCheck={false}
              className="h-8 font-mono text-xs"
              onChange={(e) => list.edit(id, e.target.value)}
              onBlur={() => void list.commit(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button type="button" className={iconButton} title={t('common.browse')} aria-label={t('common.browse')} onClick={() => browse(id)}>
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={iconButton}
              title={t('common.remove')}
              aria-label={t('common.remove')}
              onClick={() => void list.remove(id)}
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

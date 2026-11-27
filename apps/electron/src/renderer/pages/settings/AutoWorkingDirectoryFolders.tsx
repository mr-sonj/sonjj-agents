/**
 * AutoWorkingDirectoryFolders
 *
 * The workspace's auto working directory folder list (`autoWorkingDirectoryFolders`): the only
 * folders a session's first message may move to, one `path: when to pick it` line each, saved
 * shortly after typing stops. The server checks the lines; those naming no usable folder are
 * listed under the box. The edit button lets an agent in the working directory update the list
 * (it reads the project folders and writes the notes); the box reloads when its popover closes.
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SettingsCard, SettingsSection, SettingsTextarea } from '@/components/settings'
import { EditButton, EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { useActiveWorkspace } from '@/context/AppShellContext'
import type { AutoWorkingDirectoryIssue } from '../../../shared/types'

/** Wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 800

export function AutoWorkingDirectoryFolders({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  // Folder holding config.json (on the server for a remote workspace)
  const workspaceRootPath = useActiveWorkspace()?.rootPath ?? ''
  const [text, setText] = useState('')
  const [issues, setIssues] = useState<AutoWorkingDirectoryIssue[]>([])
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [editOpen, setEditOpen] = useState(false)
  // Typed but not saved yet: a reload must not overwrite it
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (keepText: boolean) => {
    const settings = await window.electronAPI.getWorkspaceSettings(workspaceId)
    if (!settings) return
    setIssues(settings.autoWorkingDirectoryIssues ?? [])
    setWorkingDirectory(settings.workingDirectory ?? '')
    if (!keepText) setText((settings.autoWorkingDirectoryFolders ?? []).join('\n'))
  }, [workspaceId])

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const value = pending.current
    if (value === null) return
    pending.current = null
    try {
      await window.electronAPI.updateWorkspaceSetting(workspaceId, 'autoWorkingDirectoryFolders', value.split('\n'))
      // Fresh issues for what was saved; the text stays as typed
      await load(true)
    } catch (error) {
      toast.error(t("settings.workspace.failedToSave", { setting: t("settings.workspace.autoWorkingDirectory") }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [workspaceId, load, t])

  useEffect(() => {
    load(false).catch(error => console.error('Failed to load the auto working directory folders:', error))
  }, [load])

  // Save what is still pending when the page closes
  const saveRef = useRef(save)
  useEffect(() => { saveRef.current = save }, [save])
  useEffect(() => () => { void saveRef.current() }, [])

  const handleChange = useCallback((value: string) => {
    setText(value)
    pending.current = value
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { void save() }, SAVE_DELAY_MS)
  }, [save])

  const handleEditOpenChange = useCallback((open: boolean) => {
    setEditOpen(open)
    if (open) {
      // The agent edits the saved list
      void save()
    } else {
      // It may have changed the list
      load(pending.current !== null).catch(error => console.error('Failed to reload the auto working directory folders:', error))
    }
  }, [save, load])

  // Literal t() keys keep the i18n coverage check effective.
  const issueText = (issue: AutoWorkingDirectoryIssue): string => {
    const values = { line: issue.line, path: issue.path }
    switch (issue.kind) {
      case 'no_path': return t("settings.workspace.autoWorkingDirectoryIssueNoPath", values)
      case 'outside_root': return t("settings.workspace.autoWorkingDirectoryIssueOutsideRoot", values)
      case 'missing': return t("settings.workspace.autoWorkingDirectoryIssueMissing", values)
      case 'duplicate': return t("settings.workspace.autoWorkingDirectoryIssueDuplicate", values)
      case 'too_many': return t("settings.workspace.autoWorkingDirectoryIssueTooMany", values)
    }
  }

  const editConfig = getEditConfig('auto-working-directory', workspaceRootPath)

  return (
    <SettingsSection
      title={t("settings.workspace.autoWorkingDirectory")}
      description={t("settings.workspace.autoWorkingDirectoryDesc")}
      action={
        workspaceRootPath && workingDirectory ? (
          <EditPopover
            trigger={<EditButton />}
            {...editConfig}
            // The agent looks for the projects in the working directory
            workingDirectory={workingDirectory}
            open={editOpen}
            onOpenChange={handleEditOpenChange}
          />
        ) : null
      }
    >
      <SettingsCard divided={false}>
        <SettingsTextarea
          value={text}
          onChange={handleChange}
          placeholder={t("settings.workspace.autoWorkingDirectoryPlaceholder")}
          rows={6}
          inCard
        />
      </SettingsCard>
      {!workingDirectory && (
        <p className="mt-1 text-label-sm text-tertiary">{t("settings.workspace.autoWorkingDirectoryNoRoot")}</p>
      )}
      {issues.length > 0 && (
        <ul role="status" className="mt-1 space-y-0.5 text-label-sm text-destructive">
          {issues.map(issue => <li key={`${issue.line}-${issue.kind}`}>{issueText(issue)}</li>)}
        </ul>
      )}
    </SettingsSection>
  )
}

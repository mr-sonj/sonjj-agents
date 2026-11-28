/**
 * AutoWorkingDirectoryFolders
 *
 * Everything about the workspace's auto working directory on one card: the switch
 * (`autoWorkingDirectory`), which model picks (the decision model when it is on, else the
 * connection's small model), and the folder list (`autoWorkingDirectoryFolders`): the only folders
 * a session's first message may move to, one `path: when to pick it` line each, saved shortly
 * after typing stops. The server checks the lines; those naming no usable folder are listed under
 * the box. The edit button lets an agent in the working directory update the list (it reads the
 * project folders and writes the notes); the box reloads when its popover closes.
 */

import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SettingsCard, SettingsSection, SettingsTextarea, SettingsToggle } from '@/components/settings'
import { EditButton, EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { DECISION_SETTINGS_CHANGED_EVENT } from '@/atoms/permission-modes'
import type { AutoWorkingDirectoryIssue } from '../../../shared/types'

/** Wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 800

/** Lines that name a folder (not blank, not a `#` comment). */
function hasFolderLine(text: string): boolean {
  return text.split('\n').some(line => line.trim() !== '' && !line.trim().startsWith('#'))
}

export function AutoWorkingDirectoryFolders({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  // Folder holding config.json (on the server for a remote workspace)
  const workspaceRootPath = useActiveWorkspace()?.rootPath ?? ''
  const [enabled, setEnabled] = useState(false)
  // The decision model is on and can be called: it picks, else the connection's small model
  const [usesJev, setUsesJev] = useState(false)
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
    setEnabled(settings.autoWorkingDirectory === true)
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

  // Which model picks, kept current when the AI settings page saves decision model settings
  useEffect(() => {
    if (typeof window.electronAPI?.getDecisionLayerStatus !== 'function') return
    let cancelled = false
    const refresh = () => {
      window.electronAPI.getDecisionLayerStatus().then((status) => {
        // As the server resolves it: a chosen connection must still be a usable gateway connection
        // (no fallback to a provider key); otherwise the provider needs a key, unless it is keyless.
        const { settings } = status
        const preset = status.presets.find(p => p.id === settings.provider)
        const hasKey = settings.connectionSlug
          ? status.reusableConnections.some(c => c.slug === settings.connectionSlug)
          : status.providersWithKey.includes(settings.provider) || preset?.requiresKey === false
        if (!cancelled) setUsesJev(settings.enabled && hasKey)
      }).catch(error => console.error('Failed to load the decision model status:', error))
    }
    refresh()
    window.addEventListener(DECISION_SETTINGS_CHANGED_EVENT, refresh)
    return () => {
      cancelled = true
      window.removeEventListener(DECISION_SETTINGS_CHANGED_EVENT, refresh)
    }
  }, [])

  const handleEnabledChange = useCallback(async (checked: boolean) => {
    setEnabled(checked)
    try {
      await window.electronAPI.updateWorkspaceSetting(workspaceId, 'autoWorkingDirectory', checked)
    } catch (error) {
      setEnabled(!checked)
      toast.error(t("settings.workspace.failedToSave", { setting: t("settings.workspace.autoWorkingDirectory") }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [workspaceId, t])

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
      <SettingsCard>
        <SettingsToggle
          label={t("settings.workspace.autoWorkingDirectoryToggle")}
          note={enabled ? (usesJev ? t("settings.workspace.autoWorkingDirectoryViaJev") : t("settings.workspace.autoWorkingDirectoryViaMiniModel")) : undefined}
          checked={enabled}
          onCheckedChange={checked => { void handleEnabledChange(checked) }}
          inCard
        />
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
      {enabled && workingDirectory && !hasFolderLine(text) && (
        <p className="mt-1 text-label-sm text-tertiary">{t("settings.workspace.autoWorkingDirectoryEmptyList")}</p>
      )}
      {issues.length > 0 && (
        <ul role="status" className="mt-1 space-y-0.5 text-label-sm text-destructive">
          {issues.map(issue => <li key={`${issue.line}-${issue.kind}`}>{issueText(issue)}</li>)}
        </ul>
      )}
    </SettingsSection>
  )
}

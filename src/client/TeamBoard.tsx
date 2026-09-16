/**
 * The Agent Teams board — ALWAYS VISIBLE under the page header whenever the
 * tree's root leads a team, plus the task editor dialog. Every control is a
 * host primitive (Menu / Modal / Input / Button / Pill / Tag / StateDot); the
 * page ships no native form control of its own.
 *
 * Layout: the strip is full width because the native sidebar is narrow — a
 * member row of Pills (also the owner filter), then task rows (subject +
 * owner + status Tag + ONE overflow Menu). Editing opens a Modal with real
 * Inputs — that is where the "too narrow to use" complaint is answered.
 *
 * Mutations are CAS: each action sends the task's CURRENT revision; a
 * conflict surfaces as a note and re-syncs through the parent's poller.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Button, IconChecklistOutline14, IconCheckOutline14, IconChevronUpOutline14, IconEditOutline16,
  IconEllipsisOutline16, IconPlusOutline16, IconRefreshOutline14, IconTrashOutline16,
  IconUserOutline16, Input, Menu, Modal, Pill, StateDot, Tag,
  type MenuEntry, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { api } from './api.ts'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/** The status Tag tone of one task. */
function taskTone(task: SidebarTeamTaskView): TagTone {
  if (task.status === 'completed') return 'success'
  if (!task.ready) return 'warning'
  return task.status === 'in_progress' ? 'info' : 'neutral'
}

/** One mutation outcome (the host route's own union). */
type MutationResult = { ok: true } | { ok: false; error: { code: string; message: string } }

/** The task being created or edited (undefined = dialog closed). */
interface TaskDraft {
  /** The task under edit; undefined = a new task. */
  task: SidebarTeamTaskView | undefined
  subject: string
  description: string
  owner: string
}

export interface TeamBoardProps {
  rootId: string
  members: readonly SidebarTeamMemberView[]
  tasks: readonly SidebarTeamTaskView[]
  /** Re-pull `teams.view` now (after every mutation / conflict). */
  onChanged(): void
  /** The strip's own collapse state (the reader's choice, remembered while mounted). */
  collapsed: boolean
  onToggleCollapsed(): void
}

export function TeamBoard(props: TeamBoardProps): ReactNode {
  const { rootId, members, tasks, onChanged, collapsed, onToggleCollapsed } = props
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<TaskDraft | undefined>(undefined)
  const [menuTaskId, setMenuTaskId] = useState<string | undefined>(undefined)
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined)
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined)

  const teammates = useMemo(() => members.filter(member => member.role === 'teammate'), [members])
  const live = useMemo(() => tasks.filter(task => task.status !== 'deleted'), [tasks])
  const shown = useMemo(
    () => live.filter(task => ownerFilter === undefined || task.ownerName === ownerFilter),
    [live, ownerFilter],
  )

  /** Run one mutation with the shared busy/conflict handling. */
  const mutate = async (action: () => Promise<MutationResult>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        setNote(result.error.code === 'team-task-conflict'
          ? t('teamTaskConflict')
          : t('teamTaskError', { message: result.error.message }))
      }
      onChanged()
    } catch (error) {
      setNote(t('teamTaskError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** The overflow menu of one task (actions per status). */
  const menuItems = (task: SidebarTeamTaskView): MenuEntry[] => {
    const entries: MenuEntry[] = []
    if (task.status === 'completed') {
      entries.push({ id: 'reopen', label: t('teamTaskReopen'), icon: <IconRefreshOutline14 size={14} /> })
    } else {
      entries.push({ id: 'complete', label: t('teamTaskComplete'), icon: <IconCheckOutline14 size={14} /> })
    }
    entries.push({ id: 'edit', label: t('teamTaskEdit'), icon: <IconEditOutline16 size={14} /> })
    if (teammates.length > 0) {
      entries.push({
        id: 'reassign',
        label: t('teamTaskOwner'),
        icon: <IconUserOutline16 size={14} />,
        submenu: [
          { id: 'reassign:', label: t('teamTaskUnowned') },
          ...teammates.map(member => ({
            id: `reassign:${member.name}`,
            label: member.name,
            ...(task.ownerName === member.name ? { disabled: true } : {}),
          })),
        ],
      })
    }
    entries.push({ type: 'separator', id: 'team-task-sep' })
    entries.push({
      id: 'delete',
      label: armedDeleteId === task.id ? t('teamTaskDeleteConfirm') : t('teamTaskDelete'),
      icon: <IconTrashOutline16 size={14} />,
      danger: true,
    })
    return entries
  }

  /** Dispatch one overflow-menu pick. */
  const onMenuSelect = (task: SidebarTeamTaskView, id: string): void => {
    if (id === 'complete') {
      setMenuTaskId(undefined)
      void mutate(() => api.teamsTaskUpdate(rootId, {
        taskId: task.id, expectedRevision: task.revision, action: 'complete',
      }))
      return
    }
    if (id === 'reopen') {
      setMenuTaskId(undefined)
      void mutate(() => api.teamsTaskUpdate(rootId, {
        taskId: task.id, expectedRevision: task.revision, action: 'reopen',
      }))
      return
    }
    if (id === 'edit') {
      setMenuTaskId(undefined)
      setDraft({ task, subject: task.subject, description: task.description, owner: task.ownerName ?? '' })
      return
    }
    if (id === 'delete') {
      // Two-step: the first pick arms the label, the second deletes.
      if (armedDeleteId !== task.id) {
        setArmedDeleteId(task.id)
        return
      }
      setArmedDeleteId(undefined)
      setMenuTaskId(undefined)
      void mutate(() => api.teamsTaskUpdate(rootId, {
        taskId: task.id, expectedRevision: task.revision, action: 'delete',
      }))
      return
    }
    if (id.startsWith('reassign:')) {
      const owner = id.slice('reassign:'.length)
      setMenuTaskId(undefined)
      setArmedDeleteId(undefined)
      void mutate(() => api.teamsTaskUpdate(rootId, {
        taskId: task.id,
        expectedRevision: task.revision,
        action: 'reassign',
        ...(owner === '' ? {} : { owner }),
      }))
    }
  }

  /** Commit the create/edit dialog (subject/description, then the owner). */
  const saveDraft = async (): Promise<void> => {
    const current = draft
    if (current === undefined) return
    const subject = current.subject.trim()
    if (subject === '') return
    await mutate(async () => {
      const result = current.task === undefined
        ? await api.teamsTaskCreate(rootId, { subject, description: current.description.trim() })
        : await api.teamsTaskUpdate(rootId, {
          taskId: current.task.id,
          expectedRevision: current.task.revision,
          action: 'edit',
          subject,
          description: current.description.trim(),
        })
      if (!result.ok) return result
      if (current.task !== undefined && current.owner !== (current.task.ownerName ?? '')) {
        const moved = await api.teamsTaskUpdate(rootId, {
          taskId: current.task.id,
          expectedRevision: result.value.revision,
          action: 'reassign',
          ...(current.owner === '' ? {} : { owner: current.owner }),
        })
        if (!moved.ok) return moved
      }
      setDraft(undefined)
      return result
    })
  }

  return (
    <section className={css.teamBoard} aria-label={t('teamBoard')}>
      <button
        type="button"
        className={css.teamBoardBar}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        <span className={css.teamBoardIcon} aria-hidden="true"><IconChecklistOutline14 size={11} /></span>
        <span>{t('teamBoard')}</span>
        <span className={css.teamBoardCount}>
          {t('teamChip', { members: members.length, tasks: live.length })}
        </span>
        <span
          className={css.teamBoardChev}
          style={{ display: 'inline-flex', transform: collapsed ? undefined : 'rotate(180deg)' }}
          aria-hidden="true"
        >
          <IconChevronUpOutline14 size={12} />
        </span>
      </button>
      {!collapsed && (
        <>
          <div className={css.teamMembers}>
            <Pill
              active={ownerFilter === undefined}
              className={css.teamMemberPill}
              onClick={() => { setOwnerFilter(undefined) }}
            >
              {t('teamFilterAll')}
            </Pill>
            {members.map(member => (
              <Pill
                key={member.id}
                active={ownerFilter === member.name}
                className={css.teamMemberPill}
                title={`${member.name} · ${member.role}`}
                onClick={() => {
                  setOwnerFilter(current => (current === member.name ? undefined : member.name))
                }}
              >
                <StateDot
                  size={6}
                  state={member.status === 'running' || member.status === 'provisioning'
                    ? 'ongoing'
                    : member.status === 'failed' ? 'error' : 'idle'}
                />
                <span className={css.teamMemberName}>{member.name}</span>
              </Pill>
            ))}
          </div>
          <div className={css.teamTasks}>
            {shown.length === 0 && <div className={css.teamEmpty}>{t('teamTasksEmpty')}</div>}
            {shown.map(task => (
              <div key={task.id} className={css.teamTask}>
                <StateDot
                  size={6}
                  state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
                />
                <span
                  className={css.teamTaskSubject}
                  title={`${task.subject}${task.description === '' ? '' : `\n${task.description}`}`}
                >
                  {task.subject}
                </span>
                {task.ownerName !== undefined && (
                  <span className={css.teamTaskOwner}>{task.ownerName}</span>
                )}
                <Tag tone={taskTone(task)}>
                  {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
                </Tag>
                <Menu
                  open={menuTaskId === task.id}
                  onClose={() => {
                    setMenuTaskId(undefined)
                    setArmedDeleteId(undefined)
                  }}
                  items={menuItems(task)}
                  onSelect={(id) => { onMenuSelect(task, id) }}
                  align="end"
                  portal
                  compact
                  anchor={(
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconEllipsisOutline16 size={13} />}
                      aria-label={`${t('teamTaskActions')} ${task.subject}`}
                      title={t('teamTaskActions')}
                      onClick={() => {
                        setArmedDeleteId(undefined)
                        setMenuTaskId(current => (current === task.id ? undefined : task.id))
                      }}
                    />
                  )}
                />
              </div>
            ))}
          </div>
          {note !== undefined && <div className={css.teamNote}>{note}</div>}
          <div className={css.teamActions}>
            <Button
              variant="outline"
              size="sm"
              icon={<IconPlusOutline16 size={13} />}
              disabled={busy}
              onClick={() => { setDraft({ task: undefined, subject: '', description: '', owner: '' }) }}
            >
              {t('teamTaskCreate')}
            </Button>
          </div>
        </>
      )}
      <Modal
        open={draft !== undefined}
        onClose={() => { setDraft(undefined) }}
        title={draft?.task === undefined ? t('teamTaskCreate') : t('teamTaskEdit')}
        closeLabel={t('teamTaskCancel')}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setDraft(undefined) }}>
              {t('teamTaskCancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || (draft?.subject.trim() ?? '') === ''}
              onClick={() => { void saveDraft() }}
            >
              {draft?.task === undefined ? t('teamTaskCreate') : t('teamTaskSave')}
            </Button>
          </>
        )}
      >
        <div className={css.taskForm}>
          <label className={css.taskField}>
            <span className={css.taskLabel}>{t('teamTaskSubject')}</span>
            <Input
              value={draft?.subject ?? ''}
              placeholder={t('teamTaskSubjectPlaceholder')}
              aria-label={t('teamTaskSubject')}
              onChange={(event) => {
                const value = event.target.value
                setDraft(current => (current === undefined ? current : { ...current, subject: value }))
              }}
            />
          </label>
          <label className={css.taskField}>
            <span className={css.taskLabel}>{t('teamTaskDescription')}</span>
            <Input
              value={draft?.description ?? ''}
              placeholder={t('teamTaskDescriptionPlaceholder')}
              aria-label={t('teamTaskDescription')}
              onChange={(event) => {
                const value = event.target.value
                setDraft(current => (current === undefined ? current : { ...current, description: value }))
              }}
            />
          </label>
          <div className={css.taskField}>
            <span className={css.taskLabel}>{t('teamTaskOwner')}</span>
            <div className={css.taskOwnerRow}>
              <Pill
                active={(draft?.owner ?? '') === ''}
                onClick={() => {
                  setDraft(current => (current === undefined ? current : { ...current, owner: '' }))
                }}
              >
                {t('teamTaskUnowned')}
              </Pill>
              {teammates.map(member => (
                <Pill
                  key={member.id}
                  active={draft?.owner === member.name}
                  onClick={() => {
                    setDraft(current => (current === undefined ? current : { ...current, owner: member.name }))
                  }}
                >
                  {member.name}
                </Pill>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </section>
  )
}

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
  Button, IconChecklistOutline14, IconChevronUpOutline14, IconPlusOutline16, Pill, StateDot, Tag,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
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

export interface TeamBoardProps {
  rootId: string
  members: readonly SidebarTeamMemberView[]
  tasks: readonly SidebarTeamTaskView[]
  /** Open the shared task window (undefined = create) anchored at the click. */
  onOpenTask(task: SidebarTeamTaskView | undefined, anchor: HTMLElement): void
  /** The strip's own collapse state (the reader's choice, remembered while mounted). */
  collapsed: boolean
  onToggleCollapsed(): void
}

export function TeamBoard(props: TeamBoardProps): ReactNode {
  const { members, tasks, onOpenTask, collapsed, onToggleCollapsed } = props
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>(undefined)

  const live = useMemo(() => tasks.filter(task => task.status !== 'deleted'), [tasks])
  const shown = useMemo(
    () => live.filter(task => ownerFilter === undefined || task.ownerName === ownerFilter),
    [live, ownerFilter],
  )

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
              <Button
                key={task.id}
                variant="ghost"
                size="sm"
                className={css.teamTask}
                aria-label={`${t('teamTaskDetail')} ${task.subject}`}
                title={t('teamTaskDetail')}
                onClick={(event) => { onOpenTask(task, event.currentTarget) }}
              >
                <StateDot
                  size={6}
                  state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
                />
                <span className={css.teamTaskSubject}>{task.subject}</span>
                {task.ownerName !== undefined && (
                  <span className={css.teamTaskOwner}>{task.ownerName}</span>
                )}
                <Tag tone={taskTone(task)}>
                  {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
                </Tag>
              </Button>
            ))}
          </div>
          <div className={css.teamActions}>
            <Button
              variant="outline"
              size="sm"
              icon={<IconPlusOutline16 size={13} />}
              onClick={(event) => { onOpenTask(undefined, event.currentTarget) }}
            >
              {t('teamTaskCreate')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

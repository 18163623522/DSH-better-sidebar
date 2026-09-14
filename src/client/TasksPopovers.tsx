/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): agent node details with a transcript jump, the
 * workflow run detail with clickable member rows, and the Agent Teams task
 * board (roster + basic CAS operations: complete / reopen / delete /
 * reassign / create / edit). Every mutation passes the task's CURRENT
 * revision; a conflict shows the note and re-syncs via the parent poller.
 */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SidebarSubagentAddress,
  SidebarTeamMemberView,
  SidebarTeamTaskView,
} from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import { agentSecondary, flatten, nodeDotState } from './tasks-shared.tsx'
import { api } from './api.ts'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** The display-state label key. */
function stateKey(state: TasksAgentNode['state']): CopyKey {
  switch (state) {
    case 'running': return 'tasksStateRunning'
    case 'idle': return 'tasksStateIdle'
    case 'done': return 'tasksStateDone'
    case 'error': return 'tasksStateError'
  }
}

/** One key/value row of a popover. */
function PopRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.popRow}>
      <span className={css.popKey}>{props.label}</span>
      <span className={css.popValue}>{props.children}</span>
    </div>
  )
}

/** The agent node detail popover. */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  onJump(node: TasksAgentNode): void
}): ReactNode {
  const { node, onJump } = props
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  const liveTool = node.live?.tool !== undefined
    ? `${node.live.tool.name}${node.live.tool.args === '' ? '' : ` ${node.live.tool.args}`}`
    : undefined
  return (
    <div className={css.popCard}>
      <span className={css.popTitle} title={node.label}>{node.label}</span>
      <PopRow label={t('tasksNodeState')}>
        <StateDot state={nodeDotState(node.state)} size={8} /> {t(stateKey(node.state))}
      </PopRow>
      {node.mode !== undefined && (
        <PopRow label={t('tasksNodeMode')}>
          {node.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable')}
        </PopRow>
      )}
      {node.team !== undefined && (
        <>
          <PopRow label={t('tasksNodeTeamRole')}>
            {node.team.role === 'lead' ? 'lead' : node.team.name}
          </PopRow>
          {node.team.model !== undefined && (
            <PopRow label={t('tasksNodeModel')}>{node.team.model}</PopRow>
          )}
        </>
      )}
      {(liveTool !== undefined || liveText !== undefined) && (
        <PopRow label={t('tasksNodeActivity')}>{liveTool ?? liveText}</PopRow>
      )}
      {node.childAddress !== undefined || node.parentId === undefined ? (
        <button
          type="button"
          className={css.popPrimary}
          onClick={() => { onJump(node) }}
        >
          {t('tasksNodeJump')}
        </button>
      ) : null}
    </div>
  )
}

/** The workflow run detail popover (phases with clickable member rows). */
export function WorkflowNodePopover(props: {
  node: TasksWorkflowNode
  onJumpMember(address: SidebarSubagentAddress): void
}): ReactNode {
  const { node, onJumpMember } = props
  const { run } = node
  return (
    <div className={css.popCard}>
      <span className={css.popTitle} title={run.name}>▶ {run.name}</span>
      <PopRow label={t('tasksNodeState')}>
        {t(run.status === 'running'
          ? 'workflowRunning'
          : run.status === 'completed'
            ? 'workflowCompleted'
            : run.status === 'cancelled' ? 'workflowCancelled' : 'workflowFailed')}
      </PopRow>
      <div className={css.popSection}>
        <div className={css.popList}>
          {run.phases.map((phase, phaseIndex) => (
            <div key={`${phase.title ?? 'phase'}-${phaseIndex}`}>
              <div className={clsx(css.popKey, css.popRow)}>
                {phase.title ?? t('workflowPhaseUnnamed')}
              </div>
              {phase.members.map(member => (
                <div
                  key={member.seq}
                  role={member.childId === '' ? undefined : 'button'}
                  className={css.popListRow}
                  onClick={() => {
                    if (member.childId === '') return
                    onJumpMember({
                      parentSessionId: run.originSessionId,
                      childSessionId: member.childId,
                      mode: 'one-shot',
                    })
                  }}
                >
                  <StateDot
                    size={8}
                    state={member.outcome === undefined
                      ? 'ongoing'
                      : member.outcome === 'completed' ? 'done'
                      : member.outcome === 'failed' ? 'error' : 'idle'}
                  />
                  <span className={css.popValue} title={member.label}>{member.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/**
 * The Agent Teams board popover: roster + shared task list with the basic
 * operations. Poll-driven refresh: a successful mutation (or a conflict)
 * asks the parent to re-pull `teams.view` immediately.
 */
export function TeamBoardPopover(props: {
  rootId: string
  members: readonly SidebarTeamMemberView[]
  tasks: readonly SidebarTeamTaskView[]
  onChanged(): void
}): ReactNode {
  const { rootId, members, tasks, onChanged } = props
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined)

  /** Run one mutation with the shared busy/conflict handling. */
  const mutate = async (
    action: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>,
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        setNote(result.error.code === 'team-task-conflict' ? t('teamTaskConflict') : t('teamTaskError', { message: result.error.message }))
      }
      onChanged()
    } catch (error) {
      setNote(t('teamTaskError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={css.popCard} style={{ width: 300 }}>
      <span className={css.popTitle}>{t('teamBoard')}</span>
      <PopRow label={t('teamMembers')}>
        {members.map(member => member.name).join(' · ')}
      </PopRow>
      <div className={css.popSection}>
        <div className={css.popList}>
          {tasks.length === 0 && <div className={css.popHint}>{t('teamTasksEmpty')}</div>}
          {tasks.filter(task => task.status !== 'deleted').map(task => (
            <TeamTaskRow
              key={task.id}
              rootId={rootId}
              task={task}
              members={members}
              busy={busy}
              editing={editingId === task.id}
              armedDelete={armedDeleteId === task.id}
              onEdit={(open) => { setEditingId(open ? task.id : undefined) }}
              onArmDelete={(armed) => { setArmedDeleteId(armed ? task.id : undefined) }}
              mutate={mutate}
            />
          ))}
        </div>
        {note !== undefined && <div className={css.popNote}>{note}</div>}
        {creating
          ? (
            <TeamTaskForm
              busy={busy}
              submitLabel={t('teamTaskCreate')}
              onCancel={() => { setCreating(false) }}
              onSubmit={(subject, description) => void mutate(async () => {
                const result = await api.teamsTaskCreate(rootId, { subject, description })
                if (result.ok) setCreating(false)
                return result
              })}
            />
          )
          : (
            <button
              type="button"
              className={css.popGhost}
              disabled={busy}
              onClick={() => { setCreating(true) }}
            >
              ＋ {t('teamTaskCreate')}
            </button>
          )}
      </div>
    </div>
  )
}

/** One task row of the board (status action + owner select + edit/delete). */
function TeamTaskRow(props: {
  rootId: string
  task: SidebarTeamTaskView
  members: readonly SidebarTeamMemberView[]
  busy: boolean
  editing: boolean
  armedDelete: boolean
  onEdit(open: boolean): void
  onArmDelete(armed: boolean): void
  mutate(action: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>): Promise<void>
}): ReactNode {
  const { rootId, task, members, busy, editing, armedDelete, onEdit, onArmDelete, mutate } = props
  if (editing) {
    return (
      <TeamTaskForm
        busy={busy}
        initialSubject={task.subject}
        initialDescription={task.description}
        submitLabel={t('teamTaskSave')}
        onCancel={() => { onEdit(false) }}
        onSubmit={(subject, description) => void mutate(async () => {
          const result = await api.teamsTaskUpdate(rootId, {
            taskId: task.id,
            expectedRevision: task.revision,
            action: 'edit',
            subject,
            description,
          })
          if (result.ok) onEdit(false)
          return result
        })}
      />
    )
  }
  return (
    <div className={css.popListRow} style={{ cursor: 'default' }}>
      <StateDot
        size={8}
        state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
      />
      <span className={css.popValue} title={task.subject}>
        {task.subject}
        {!task.ready && ` · ${t('teamTaskBlocked')}`}
      </span>
      <select
        className={css.popSelect}
        style={{ width: 'auto', flexShrink: 0 }}
        aria-label={t('teamTaskOwner')}
        title={t('teamTaskOwner')}
        disabled={busy || task.status === 'completed'}
        value={task.ownerName ?? ''}
        onChange={(event) => {
          const owner = event.target.value
          void mutate(() => api.teamsTaskUpdate(rootId, {
            taskId: task.id,
            expectedRevision: task.revision,
            action: 'reassign',
            ...(owner === '' ? {} : { owner }),
          }))
        }}
      >
        <option value="">{t('teamTaskUnowned')}</option>
        {members.filter(member => member.role === 'teammate').map(member => (
          <option key={member.id} value={member.name}>{member.name}</option>
        ))}
      </select>
      <span className={css.popActions}>
        {task.status !== 'completed' && (
          <button
            type="button"
            className={css.popGhost}
            disabled={busy}
            title={t('teamTaskComplete')}
            aria-label={`${t('teamTaskComplete')} ${task.subject}`}
            onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
              taskId: task.id, expectedRevision: task.revision, action: 'complete',
            }))}
          >
            ✓
          </button>
        )}
        {task.status === 'completed' && (
          <button
            type="button"
            className={css.popGhost}
            disabled={busy}
            title={t('teamTaskReopen')}
            aria-label={`${t('teamTaskReopen')} ${task.subject}`}
            onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
              taskId: task.id, expectedRevision: task.revision, action: 'reopen',
            }))}
          >
            ↺
          </button>
        )}
        <button
          type="button"
          className={css.popGhost}
          disabled={busy}
          title={t('teamTaskEdit')}
          aria-label={`${t('teamTaskEdit')} ${task.subject}`}
          onClick={() => { onEdit(true) }}
        >
          ✎
        </button>
        <button
          type="button"
          className={clsx(css.popGhost, armedDelete && css.popGhostDanger)}
          disabled={busy}
          title={armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')}
          aria-label={`${armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')} ${task.subject}`}
          onClick={() => {
            if (!armedDelete) { onArmDelete(true); return }
            onArmDelete(false)
            void mutate(() => api.teamsTaskUpdate(rootId, {
              taskId: task.id, expectedRevision: task.revision, action: 'delete',
            }))
          }}
        >
          {armedDelete ? t('teamTaskDeleteConfirm') : '🗑'}
        </button>
      </span>
      <span className={css.popHint}>{t(taskStatusKey(task.status))}</span>
    </div>
  )
}

/** The create/edit task form (subject + description). */
function TeamTaskForm(props: {
  busy: boolean
  initialSubject?: string
  initialDescription?: string
  submitLabel: string
  onCancel(): void
  onSubmit(subject: string, description: string): void
}): ReactNode {
  const [subject, setSubject] = useState(props.initialSubject ?? '')
  const [description, setDescription] = useState(props.initialDescription ?? '')
  return (
    <div className={css.popSection}>
      <input
        className={css.popInput}
        placeholder={t('teamTaskSubject')}
        aria-label={t('teamTaskSubject')}
        value={subject}
        onChange={(event) => { setSubject(event.target.value) }}
      />
      <input
        className={css.popInput}
        placeholder={t('teamTaskDescription')}
        aria-label={t('teamTaskDescription')}
        value={description}
        onChange={(event) => { setDescription(event.target.value) }}
      />
      <div className={css.popActions}>
        <button
          type="button"
          className={css.popPrimary}
          disabled={props.busy || subject.trim() === ''}
          onClick={() => { props.onSubmit(subject.trim(), description.trim()) }}
        >
          {props.submitLabel}
        </button>
        <button type="button" className={css.popGhost} disabled={props.busy} onClick={props.onCancel}>
          {t('teamTaskCancel')}
        </button>
      </div>
    </div>
  )
}

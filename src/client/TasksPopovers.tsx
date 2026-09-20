/**
 * The anchored-popover CONTENTS of the Tasks page (geometry and dismissal
 * live in AnchoredPopover): the agent node detail with a transcript jump and
 * the workflow run detail with clickable member rows.
 *
 * Visual base: the vendored shadcn/ui set composed the registry's way — the
 * full `Card` (header + title + description + action slot + content + footer),
 * the node / run and every list row as an `Item` (`ItemMedia` + `ItemTitle` +
 * `ItemActions`) inside an `ItemGroup`, status as a stock `Badge` variant
 * (running = `default`, settled = `secondary`, failed = `destructive`) and the
 * jump as a stock `Button` — so colours and type come from those components
 * and the semantic tokens. The surface is flat and owned by the shell: like
 * the task window, the card paints no surface of its own (`border-0
 * bg-transparent shadow-none`) because AnchoredPopover already draws the
 * floating border/radius/shadow — nesting a second bordered card inside it
 * would double the hairline. The only shadow is the shell's; ink stays on
 * three levels (foreground / muted-foreground / foreground-3) and mono meta is
 * `font-mono tabular-nums`; hue is semantic only — success = settled, warning =
 * blocked, destructive = failed, primary = the one main action per popover.
 *
 * The team board is NOT here: it is always visible as a strip above the
 * canvas (TeamBoard.tsx).
 */
import type { ReactNode } from 'react'
import {
  IconBranchOutline16, IconRightUpOutline14, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarSubagentAddress } from '../context-types.ts'
import type { TasksAgentNode, TasksWorkflowNode } from './tasks-model.ts'
import {
  flatten, taskDotState, taskStatusKey, workflowStatusKey,
} from './tasks-shared.tsx'
import { t, type CopyKey } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card.tsx'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from './ui/item.tsx'
import { Separator } from './ui/separator.tsx'

/** The workflow run status (the badge's semantic ink selector). */
type WorkflowStatus = TasksWorkflowNode['run']['status']

/** The display-state label key. */
function stateKey(state: TasksAgentNode['state']): CopyKey {
  switch (state) {
    case 'running': return 'tasksStateRunning'
    case 'idle': return 'tasksStateIdle'
    case 'done': return 'tasksStateDone'
    case 'error': return 'tasksStateError'
  }
}

/**
 * The stock Badge variant of one status word: running / in progress =
 * `default` (the accent), failed / cancelled = `destructive`, everything
 * settled = `secondary` (pending included — a to-do list is not an alert).
 */
function statusVariant(status: WorkflowStatus | 'pending' | 'in_progress' | 'completed'): 'default' | 'secondary' | 'destructive' {
  if (status === 'running' || status === 'in_progress') return 'default'
  if (status === 'failed' || status === 'cancelled') return 'destructive'
  return 'secondary'
}

/** The node display state on the same stock variant set. */
function stateVariant(state: TasksAgentNode['state']): 'default' | 'secondary' | 'destructive' {
  if (state === 'running') return 'default'
  if (state === 'error') return 'destructive'
  return 'secondary'
}

/**
 * The popover's key/value grid (label left, value right, mono on request).
 * The read-only meta stays a definition list rather than a `FieldGroup`: the
 * three ink levels ARE the design language here, and a `FieldLabel` would have
 * to be repainted (or would shout) to say the same thing. The label column is
 * a fixed 64px so every row's value starts on one axis — an `auto` column
 * makes the labels ragged across rows.
 */
function PopRows(props: { children: ReactNode }): ReactNode {
  return <dl className="grid grid-cols-[64px_1fr] items-baseline gap-x-3 gap-y-1">{props.children}</dl>
}

/** One key/value row of a popover. */
function PopRow(props: { label: string; mono?: boolean; children: ReactNode }): ReactNode {
  return (
    <>
      <dt className="truncate text-xs text-foreground-3" title={props.label}>{props.label}</dt>
      <dd
        className={
          props.mono === true
            ? 'truncate text-right font-mono text-xs tabular-nums text-muted-foreground'
            : 'flex min-w-0 items-center justify-end gap-1.5 text-right text-xs'
        }
      >
        {props.children}
      </dd>
    </>
  )
}

/** The mono kicker above a popover list ("共享任务" / a phase title). */
function GroupLabel(props: { children: ReactNode }): ReactNode {
  return (
    <div className="px-1 pt-0.5 font-mono text-xs tracking-wide text-foreground-3 uppercase">
      {props.children}
    </div>
  )
}

/** One status badge on its stock variant (neutral chrome). */
function StatusBadge(props: { variant: 'default' | 'secondary' | 'destructive'; children: ReactNode }): ReactNode {
  return <Badge variant={props.variant}>{props.children}</Badge>
}

/** The agent node detail popover. */
export function AgentNodePopover(props: {
  node: TasksAgentNode
  onJump(node: TasksAgentNode): void
  /** Open the shared task window for one of the node's tasks. */
  onOpenTask(taskId: string, anchor: HTMLElement): void
}): ReactNode {
  const { node, onJump, onOpenTask } = props
  const liveText = node.live?.text !== undefined ? flatten(node.live.text) : undefined
  const liveTool = node.live?.tool !== undefined
    ? `${node.live.tool.name}${node.live.tool.args === '' ? '' : ` ${node.live.tool.args}`}`
    : undefined
  const tasks = node.tasks ?? []
  return (
    // `dsw-tasks`: this card renders inside AnchoredPopover's portal at
    // document.body — OUTSIDE the page root — so it must re-declare the page
    // root class to pick up the scoped base reset the plugin ships instead of
    // preflight (see TaskWindow.tsx for the same pattern).
    <Card className="dsw-tasks box-border gap-0 rounded-lg border-0 bg-transparent py-0 shadow-none">
      {/* The node leads (title) over the card's kind (description), and its
          display state rides the header's action slot as a stock badge. */}
      <CardHeader className="items-center px-3 py-2">
        <CardTitle className="min-w-0">
          <span className="min-w-0 truncate" title={node.label}>{node.label}</span>
        </CardTitle>
        <CardDescription>{t('tasksNodeDetail')}</CardDescription>
        <CardAction>
          <StatusBadge variant={stateVariant(node.state)}>{t(stateKey(node.state))}</StatusBadge>
        </CardAction>
      </CardHeader>
      <Separator />
      <CardContent className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
        <PopRows>
          {node.mode !== undefined && (
            <PopRow label={t('tasksNodeMode')}>
              {node.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable')}
            </PopRow>
          )}
          {node.team !== undefined && (
            <PopRow label={t('tasksNodeTeamRole')}>
              {node.team.role === 'lead' ? 'lead' : node.team.name}
            </PopRow>
          )}
          {node.team?.model !== undefined && (
            <PopRow label={t('tasksNodeModel')} mono>{node.team.model}</PopRow>
          )}
          {(liveTool !== undefined || liveText !== undefined) && (
            <PopRow label={t('tasksNodeActivity')} mono>{liveTool ?? liveText}</PopRow>
          )}
        </PopRows>
        {liveText !== undefined && liveTool !== undefined && (
          <div className="line-clamp-2 text-xs text-muted-foreground" title={liveText}>{liveText}</div>
        )}
      </CardContent>
      {tasks.length > 0 && (
        <>
          <Separator />
          <CardContent className="flex flex-col gap-1 px-3 py-2.5">
            <GroupLabel>{t('tasksNodeTasks')}</GroupLabel>
            {/* Each row opens the shared task window, so the whole row is the
                button (`Item asChild` puts the stock row geometry on it, and
                the trailing status badge on the actions slot). */}
            <ItemGroup className="max-h-[190px] overflow-y-auto">
              {tasks.map(task => (
                <Item
                  key={task.id}
                  asChild
                  variant="outline"
                  size="sm"
                  className="min-w-0 flex-nowrap gap-2 px-2 py-1.5 hover:bg-muted"
                >
                  <button
                    type="button"
                    className="text-left"
                    title={task.subject}
                    onClick={(event) => { onOpenTask(task.id, event.currentTarget) }}
                  >
                    <ItemMedia>
                      <StateDot state={taskDotState(task)} size={6} />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="w-full min-w-0">
                        <span className="min-w-0 flex-1 truncate">{task.subject}</span>
                      </ItemTitle>
                    </ItemContent>
                    <ItemActions>
                      <StatusBadge variant={statusVariant(task.status)}>
                        {t(taskStatusKey(task.status))}
                      </StatusBadge>
                    </ItemActions>
                  </button>
                </Item>
              ))}
            </ItemGroup>
          </CardContent>
        </>
      )}
      {(node.childAddress !== undefined || node.parentId === undefined) && (
        <>
          <Separator />
          <CardFooter className="justify-end px-3 py-2">
            <Button size="sm" onClick={() => { onJump(node) }}>
              <IconRightUpOutline14 />
              {t('tasksNodeJump')}
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  )
}

/** The workflow run detail popover (phases with clickable member rows). */
export function WorkflowNodePopover(props: {
  node: TasksWorkflowNode
  onJumpMember(address: SidebarSubagentAddress): void
}): ReactNode {
  const { node, onJumpMember } = props
  const { run } = node
  /** A member with no outcome yet still runs; only completed/failed settle. */
  const memberDot = (outcome: string | undefined): 'ongoing' | 'done' | 'error' | 'idle' => {
    if (outcome === undefined) return 'ongoing'
    if (outcome === 'completed') return 'done'
    if (outcome === 'failed') return 'error'
    return 'idle'
  }
  return (
    // `dsw-tasks`: same portal-scope reset as AgentNodePopover above.
    <Card className="dsw-tasks box-border gap-0 rounded-lg border-0 bg-transparent py-0 shadow-none">
      {/* The run's identity leads and keeps its branch glyph; the run status
          rides the header's action slot as a stock badge. */}
      <CardHeader className="items-center px-3 py-2">
        <CardTitle className="flex min-w-0 items-center gap-1.5">
          {/* The visible line carries the copy; the glyph is decoration. */}
          <span className="flex flex-none items-center" aria-hidden="true">
            <IconBranchOutline16 />
          </span>
          <span className="min-w-0 truncate" title={run.name}>{run.name}</span>
        </CardTitle>
        <CardDescription>{t('workflowRun')}</CardDescription>
        <CardAction>
          <StatusBadge variant={statusVariant(run.status)}>{t(workflowStatusKey(run.status))}</StatusBadge>
        </CardAction>
      </CardHeader>
      {run.phases.length > 0 && (
        <>
          <Separator />
          <CardContent className="flex max-h-[220px] flex-col gap-2 overflow-y-auto px-3 py-2.5">
            {run.phases.map((phase, phaseIndex) => (
              <div key={`${phase.title ?? 'phase'}-${phaseIndex}`} className="flex flex-col gap-0.5">
                <GroupLabel>{phase.title ?? t('workflowPhaseUnnamed')}</GroupLabel>
                {phase.members.length === 0 && (
                  <div className="px-1 py-1 text-xs text-foreground-3">{t('subagentEmpty')}</div>
                )}
                <ItemGroup>
                  {phase.members.map(member => {
                    const body = (
                      <>
                        <ItemMedia>
                          <StateDot size={6} state={memberDot(member.outcome)} />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="w-full min-w-0">
                            <span className="min-w-0 flex-1 truncate" title={member.label}>{member.label}</span>
                          </ItemTitle>
                        </ItemContent>
                      </>
                    )
                    // A member row IS a jump affordance when it has a child
                    // session; without one it stays a plain tally line.
                    return member.childId === ''
                      ? (
                        <Item key={member.seq} size="sm" className="min-w-0 flex-nowrap gap-2 px-1.5 py-1">
                          {body}
                        </Item>
                      )
                      : (
                        <Item
                          key={member.seq}
                          asChild
                          size="sm"
                          className="min-w-0 flex-nowrap gap-2 px-1.5 py-1 hover:bg-muted"
                        >
                          <button
                            type="button"
                            className="text-left"
                            title={member.label}
                            onClick={() => {
                              onJumpMember({
                                parentSessionId: run.originSessionId,
                                childSessionId: member.childId,
                                mode: 'one-shot',
                              })
                            }}
                          >
                            {body}
                          </button>
                        </Item>
                      )
                  })}
                </ItemGroup>
              </div>
            ))}
          </CardContent>
        </>
      )}
    </Card>
  )
}

/**
 * The Agent Teams board — ALWAYS VISIBLE under the page header whenever the
 * tree's root leads a team. It is a full-width strip, not a side rail, because
 * the native sidebar is narrow: members wrap as a segmented filter and the
 * task list scrolls inside a bounded height, so the canvas keeps its room.
 *
 * Visual language: shadcn/ui over the task page's Tailwind tokens
 * (src/client/ui/theme.css) — the strip is a stock Card (`rounded-xl border
 * bg-card shadow-sm`), members are a ToggleGroup whose selected chip carries
 * the accent, and every task row ends in one DropdownMenu. Ink stays on the
 * three token levels (text-sm body / text-xs mono meta, `font-mono
 * tabular-nums`), and status color is the stock Badge variant set only.
 *
 * Behaviour is unchanged, and deliberately so: the row and EVERY menu entry
 * open the shared task window, which is the ONE surface owning view / edit /
 * create and every CAS mutation. The menu is that window's affordance list
 * hoisted onto the row, not a second mutation path — so a conflict still
 * surfaces in the window and re-syncs through the parent's poller, exactly as
 * before.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button, IconChecklistOutline14, IconChevronUpOutline14, IconPlusOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { t, type CopyKey } from './locales.ts'
import { cn } from './ui/utils.ts'
import { Badge } from './ui/badge.tsx'
import { Card } from './ui/card.tsx'
import { Empty } from './ui/empty.tsx'
import { Separator } from './ui/separator.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/** The status word as shown: an unready task reads "blocked" whatever it is. */
function taskStatusLabel(task: SidebarTeamTaskView): string {
  return t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')
}

/**
 * The status Badge: stock shadcn variants only — in progress takes `default`
 * (the accent), a blocked task wears `outline` with warning ink, everything
 * else settles on `secondary` (a to-do list is not an alert).
 */
function taskBadge(task: SidebarTeamTaskView): { variant: 'default' | 'secondary' | 'outline'; className?: string } {
  if (task.status === 'in_progress' && task.ready) return { variant: 'default' }
  if (!task.ready) return { variant: 'outline', className: 'text-warning' }
  return { variant: 'secondary' }
}

/** The StateDot semantic of one task row. */
function taskDotState(task: SidebarTeamTaskView): 'done' | 'warning' | 'ongoing' {
  if (task.status === 'completed') return 'done'
  return task.ready ? 'ongoing' : 'warning'
}

/** The StateDot semantic of one member chip. */
function memberDotState(member: SidebarTeamMemberView): 'ongoing' | 'error' | 'idle' {
  return member.status === 'running' || member.status === 'provisioning'
    ? 'ongoing'
    : member.status === 'failed' ? 'error' : 'idle'
}

/**
 * The "every member" sentinel of the owner filter. It must be a NON-empty
 * string: Radix treats a falsy toggle value as "nothing selected", so an empty
 * sentinel would leave the whole segmented control reading as unselected.
 */
const FILTER_ALL = '__all__'

/** The shared slab: a filled rounded row whose only hover change is its background. */
const ROW_CLASS =
  'flex min-w-0 cursor-pointer items-center gap-2 rounded-md bg-transparent px-2 py-2 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'
/** The shared filter chip: sm toggle geometry, accent when picked (stock). */
const CHIP_CLASS =
  'h-6 w-auto min-w-0 gap-1 px-2 text-xs font-normal text-muted-foreground data-[state=on]:text-foreground'
/** The row menu's rows: body size, no icon column (the label is the affordance). */
const ITEM_CLASS = 'text-sm'

/**
 * One board row: state dot, subject, owner, status Badge, and the row menu.
 *
 * The clickable surface is a real `<button>` (the whole row except the menu),
 * and the menu is its SIBLING inside a grid row — a control may not nest
 * inside another, and the row's own press target must stay one element. The
 * node is held in a ref so the menu can hand a MOUNTED anchor to the task
 * window: the menu content is portaled and unmounts the moment an entry is
 * picked, while the window measures its anchor on mount.
 */
function TeamTaskRow(props: {
  task: SidebarTeamTaskView
  teammates: readonly SidebarTeamMemberView[]
  onOpenTask(task: SidebarTeamTaskView, anchor: HTMLElement): void
}): ReactNode {
  const { task, teammates, onOpenTask } = props
  const rowRef = useRef<HTMLDivElement>(null)
  /** Every menu entry lands on the same surface (the window owns the actions). */
  const openWindow = (): void => {
    const row = rowRef.current
    if (row !== null) onOpenTask(task, row)
  }

  return (
    <div ref={rowRef} className="group grid grid-cols-[1fr_auto] items-center gap-1">
      <button
        type="button"
        className={ROW_CLASS}
        aria-label={`${t('teamTaskDetail')} ${task.subject}`}
        title={t('teamTaskDetail')}
        onClick={(event) => { onOpenTask(task, event.currentTarget) }}
      >
        <StateDot size={6} state={taskDotState(task)} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task.subject}</span>
        {task.ownerName !== undefined && (
          <span className="max-w-[72px] flex-none truncate font-mono text-xs tabular-nums text-foreground-3">
            {task.ownerName}
          </span>
        )}
        {(() => {
          const badge = taskBadge(task)
          return (
            <Badge variant={badge.variant} className={cn('flex-none', badge.className)}>
              {taskStatusLabel(task)}
            </Badge>
          )
        })()}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t('teamTaskActions')}
          title={t('teamTaskActions')}
          className="flex size-6 flex-none cursor-pointer items-center justify-center rounded-md bg-transparent text-muted-foreground opacity-0 outline-none transition-colors group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <IconChevronUpOutline14 size={12} className="rotate-90" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem className={ITEM_CLASS} onClick={openWindow}>
            {task.status === 'completed' ? t('teamTaskReopen') : t('teamTaskComplete')}
          </DropdownMenuItem>
          <DropdownMenuItem className={ITEM_CLASS} onClick={openWindow}>
            {t('teamTaskEdit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={ITEM_CLASS}>{t('teamTaskOwner')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuItem className={ITEM_CLASS} onClick={openWindow}>
                {t('teamTaskUnowned')}
              </DropdownMenuItem>
              {teammates.map(member => (
                <DropdownMenuItem key={member.id} className={ITEM_CLASS} onClick={openWindow}>
                  {member.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          {/* Neutral on purpose: this entry only OPENS the shared task window
              (the danger lives in the window's two-click delete confirm), so a
              permanently red menu item would over-signal — see TaskWindow. */}
          <DropdownMenuItem className={ITEM_CLASS} onClick={openWindow}>
            {t('teamTaskDelete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
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
  const teammates = useMemo(() => members.filter(member => member.role === 'teammate'), [members])

  return (
    <Card
      // `gap-0` because the bands are separated by hairlines, not by the stock
      // card rhythm; `py-0` because each band owns its own padding. The rest is
      // the stock card surface (`rounded-xl border bg-card shadow-sm`); the
      // landmark role keeps the labelled region the old `<section>` provided.
      className="mb-2 shrink-0 gap-0 overflow-hidden rounded-xl py-0 shadow-sm"
      role="region"
      aria-label={t('teamBoard')}
    >
      {/* Header: the disclosure, and the only control that collapses the board. */}
      <div className="flex items-center py-0.5 pr-2 pl-3">
        <button
          type="button"
          className={cn(ROW_CLASS, 'flex-1 py-1.5')}
          aria-expanded={!collapsed}
          aria-label={t('teamBoard')}
          onClick={onToggleCollapsed}
        >
          <span className="flex-none text-muted-foreground" aria-hidden="true">
            <IconChecklistOutline14 size={12} />
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{t('teamBoard')}</span>
          <span className="min-w-0 truncate font-mono text-xs tabular-nums text-foreground-3">
            {t('teamChip', { members: members.length, tasks: live.length })}
          </span>
          <span
            className={cn('ml-auto flex-none text-muted-foreground', collapsed ? '' : 'rotate-180')}
            aria-hidden="true"
          >
            <IconChevronUpOutline14 size={12} />
          </span>
        </button>
      </div>
      {!collapsed && (
        <>
          <Separator />
          {/* The owner filter: one chip per member, plus "all". */}
          <ToggleGroup
            type="single"
            variant="default"
            size="sm"
            value={ownerFilter ?? FILTER_ALL}
            aria-label={t('teamMembers')}
            className="flex-wrap justify-start gap-1 px-2 py-1"
            onValueChange={(next) => {
              // "all" is a sentinel, never a real member name — and re-clicking
              // the active member clears the filter (the toggle's own off state,
              // which Radix reports as an empty value).
              setOwnerFilter(next === '' ? undefined : next)
            }}
          >
            <ToggleGroupItem value={FILTER_ALL} className={CHIP_CLASS}>{t('teamFilterAll')}</ToggleGroupItem>
            {members.map(member => (
              <ToggleGroupItem
                key={member.id}
                value={member.name}
                title={`${member.name} · ${member.role}`}
                className={CHIP_CLASS}
              >
                <StateDot size={6} state={memberDotState(member)} />
                <span className="min-w-0 truncate">{member.name}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Separator />
          <div className="max-h-40 overflow-y-auto p-1">
            {shown.length === 0
              // `Empty` is the design language's empty state; the stock card
              // rhythm is overridden so an empty board stays a thin band.
              ? <Empty className="gap-0 rounded-md p-2 text-xs">{t('teamTasksEmpty')}</Empty>
              : shown.map(task => (
                <TeamTaskRow key={task.id} task={task} teammates={teammates} onOpenTask={onOpenTask} />
              ))}
          </div>
          <Separator />
          <div className="px-2 py-1.5">
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
    </Card>
  )
}

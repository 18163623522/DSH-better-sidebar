/**
 * The Agent Teams board — ALWAYS VISIBLE under the page header whenever the
 * tree's root leads a team. It is a full-width strip, not a side rail, because
 * the native sidebar is narrow: members wrap as a segmented filter and the
 * task list scrolls inside a bounded height, so the canvas keeps its room.
 *
 * Visual language: the vendored shadcn/ui set over the task page's Tailwind
 * tokens (src/client/ui/theme.css) — one full `Card` whose bands (header,
 * filter, `CardContent` list, `CardFooter`) are separated by hairlines, task
 * rows are `Item`s, members are a `ToggleGroup` whose picked chip carries the
 * component's own accent, and every task row ends in one `DropdownMenu`.
 * Type and color come from the components' variants and the semantic tokens
 * (the count keeps the page's mono-meta convention); status color is the stock
 * `Badge` variant set only. The strip's compact band padding is its one
 * deliberate departure — it is a permanently visible strip, so it stays thin
 * and lets the canvas below it keep its height.
 *
 * Behaviour is unchanged, and deliberately so: the row and EVERY menu entry
 * open the shared task window, which is the ONE surface owning view / edit /
 * create and every CAS mutation. The menu is that window's affordance list
 * hoisted onto the row, not a second mutation path — so a conflict still
 * surfaces in the window and re-syncs through the parent's poller, exactly as
 * before.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { IconChecklistOutline14, IconChevronUpOutline14, IconPlusOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { t, type CopyKey } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card.tsx'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx'
import { Empty, EmptyDescription } from './ui/empty.tsx'
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from './ui/item.tsx'
import { Separator } from './ui/separator.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import { cn } from './ui/utils.ts'

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

/**
 * The row menu's trigger: revealed on hover / focus (the board stays quiet
 * until the reader reaches for it) but never removed from the tab order.
 */
const TRIGGER_CLASS = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100'

/**
 * One board row: state dot, subject, owner, status Badge, and the row menu.
 *
 * The clickable surface is a real `<button>` (the whole row except the menu),
 * and the menu is its SIBLING — a control may not nest inside another, and the
 * row's own press target must stay one element. `Item asChild` puts the stock
 * row geometry on that button itself instead of wrapping it in a second box.
 * The node is held in a ref so the menu can hand a MOUNTED anchor to the task
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
  const badge = taskBadge(task)

  return (
    <div ref={rowRef} className="group flex min-w-0 items-center gap-1">
      <Item asChild size="sm" className="min-w-0 flex-1 flex-nowrap gap-2 px-2 py-1.5 hover:bg-muted">
        <button
          type="button"
          aria-label={`${t('teamTaskDetail')} ${task.subject}`}
          title={t('teamTaskDetail')}
          onClick={(event) => { onOpenTask(task, event.currentTarget) }}
        >
          <ItemMedia><StateDot size={6} state={taskDotState(task)} /></ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full min-w-0">
              <span className="min-w-0 truncate">{task.subject}</span>
            </ItemTitle>
          </ItemContent>
          {task.ownerName !== undefined && (
            <span className="max-w-18 flex-none truncate font-mono text-xs tabular-nums text-foreground-3">
              {task.ownerName}
            </span>
          )}
          <Badge variant={badge.variant} className={cn('flex-none', badge.className)}>
            {taskStatusLabel(task)}
          </Badge>
        </button>
      </Item>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={TRIGGER_CLASS}
            aria-label={t('teamTaskActions')}
            title={t('teamTaskActions')}
          >
            <IconChevronUpOutline14 className="rotate-90" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={openWindow}>
              {task.status === 'completed' ? t('teamTaskReopen') : t('teamTaskComplete')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openWindow}>
              {t('teamTaskEdit')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('teamTaskOwner')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={openWindow}>
                  {t('teamTaskUnowned')}
                </DropdownMenuItem>
                {teammates.map(member => (
                  <DropdownMenuItem key={member.id} onClick={openWindow}>
                    {member.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            {/* Neutral on purpose: this entry only OPENS the shared task window
                (the danger lives in the window's two-click delete confirm), so a
                permanently red menu item would over-signal — see TaskWindow. */}
            <DropdownMenuItem onClick={openWindow}>
              {t('teamTaskDelete')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
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
      className="mb-2 shrink-0 gap-0 overflow-hidden py-0"
      role="region"
      aria-label={t('teamBoard')}
    >
      {/* Header: the disclosure, and the only control that collapses the board.
          It owns the WHOLE band (one press target, as before) and carries the
          board's accessible name and expanded state. */}
      <CardHeader className="flex flex-row items-center gap-1 p-1">
        <CardTitle className="min-w-0 flex-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            aria-expanded={!collapsed}
            aria-label={t('teamBoard')}
            onClick={onToggleCollapsed}
          >
            <IconChecklistOutline14 />
            <span className="min-w-0 truncate">{t('teamBoard')}</span>
            <span className="ml-auto min-w-0 truncate font-mono text-xs tabular-nums text-foreground-3">
              {t('teamChip', { members: members.length, tasks: live.length })}
            </span>
            <span className={cn('flex-none', collapsed ? '' : 'rotate-180')} aria-hidden="true">
              <IconChevronUpOutline14 />
            </span>
          </Button>
        </CardTitle>
      </CardHeader>
      {!collapsed && (
        <>
          <Separator />
          {/* The owner filter: one chip per member, plus "all". */}
          <div className="px-2 py-1.5">
            <ToggleGroup
              type="single"
              variant="default"
              size="sm"
              spacing={1}
              value={ownerFilter ?? FILTER_ALL}
              aria-label={t('teamMembers')}
              className="flex-wrap justify-start"
              onValueChange={(next) => {
                // "all" is a sentinel, never a real member name — and re-clicking
                // the active member clears the filter (the toggle's own off state,
                // which Radix reports as an empty value).
                setOwnerFilter(next === '' ? undefined : next)
              }}
            >
              <ToggleGroupItem value={FILTER_ALL}>{t('teamFilterAll')}</ToggleGroupItem>
              {members.map(member => (
                <ToggleGroupItem
                  key={member.id}
                  value={member.name}
                  title={`${member.name} · ${member.role}`}
                >
                  <StateDot size={6} state={memberDotState(member)} />
                  <span className="min-w-0 truncate">{member.name}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Separator />
          <CardContent className="p-1">
            {shown.length === 0
              // `Empty` is the design language's empty state; its stock card
              // rhythm is overridden — including the `md:` step, which would
              // otherwise re-inflate the band to 48px of padding above 768px —
              // so an empty board stays a thin band.
              ? (
                <Empty className="gap-0 p-3 md:p-3">
                  <EmptyDescription>{t('teamTasksEmpty')}</EmptyDescription>
                </Empty>
              )
              : (
                <ItemGroup className="max-h-40 overflow-y-auto">
                  {shown.map(task => (
                    <TeamTaskRow key={task.id} task={task} teammates={teammates} onOpenTask={onOpenTask} />
                  ))}
                </ItemGroup>
              )}
          </CardContent>
          <Separator />
          <CardFooter className="px-2 py-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => { onOpenTask(undefined, event.currentTarget) }}
            >
              <IconPlusOutline16 />
              {t('teamTaskCreate')}
            </Button>
          </CardFooter>
        </>
      )}
    </Card>
  )
}

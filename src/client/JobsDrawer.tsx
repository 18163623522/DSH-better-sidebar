/**
 * The background-jobs bottom drawer of the Tasks page and its output popover.
 *
 * Drawer: the tree's jobs (owner-labeled, fed by the `session/jobs` push
 * mirror) collapse into a bottom bar that AUTO-COLLAPSES once the tree has
 * many agents — the manual toggle always wins afterwards.
 *
 * Popover: clicking a row opens a DRAGGABLE, portalled output card (see
 * AnchoredPopover) instead of docking a pane inside the page. It shows the
 * output the MODEL has read (event replay — never the model's job_output
 * cursor), with a copy action, a follow-latest switch, the two-click kill,
 * and a terminal-style tail while the job runs.
 *
 * Composition: the vendored shadcn set carries every surface. The drawer is a
 * `Collapsible` whose rows are `Item`s (`ItemGroup` → `Item` + `ItemActions`,
 * the row whose output is open taking the `muted` variant); the popover's
 * identity block is an `Item` (media / content / actions) and its footer an
 * `Item` holding the host `Switch` and the kill `Button`; hairlines are
 * `Separator`s, status ink rides the stock `Badge` variants, and the loading
 * line is the vendored `Spinner`. Hierarchy comes from the 1px `border-border`
 * hairline plus the surface ladder (`bg-background` → `bg-muted` on hover) —
 * the static drawer carries no shadow; the only float is the popover card,
 * whose surface/shadow belong to AnchoredPopover. Body copy is text-sm, meta
 * text-xs, identifiers/durations `font-mono tabular-nums`.
 *
 * `className` is used for layout only (the components own their color and
 * type), every icon is a host `IconXxx` glyph, and every other control is a
 * host primitive (`Switch` / `StateDot`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronUpOutline14, IconCopyOutline16, IconStopFill16, StateDot, Switch,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarJobView } from '../context-types.ts'
import {
  formatJobDuration,
  isJobLive,
  jobDotState,
  jobStatusLabel,
  type TreeJob,
} from './subagent-jobs.ts'
import { api, type JobOutputResult } from './api.ts'
import { t } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible.tsx'
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from './ui/item.tsx'
import { ScrollArea } from './ui/scroll-area.tsx'
import { Separator } from './ui/separator.tsx'
import { Spinner } from './ui/spinner.tsx'
import { cn } from './ui/utils.ts'

/** Refresh cadence of an open job-output popover while its job runs. */
const JOB_POLL_MS = 2000
/** How long the kill button stays armed before it needs re-confirming. */
const JOB_KILL_ARM_MS = 3000
/** The agent count at which the drawer starts collapsed. */
export const JOBS_DRAWER_COLLAPSE_AT = 8

/**
 * The status badge's stock shadcn variant: running = `default` (the accent),
 * failed = `destructive`, settled/ending = `secondary`.
 */
function statusVariant(job: SidebarJobView): 'default' | 'secondary' | 'destructive' {
  if (job.status === 'running') return 'default'
  if (job.status === 'failed') return 'destructive'
  return 'secondary'
}

/** The meta chip of one job kind: the stock `outline` variant, mono figures. */
function KindBadge(props: { kind: string }): ReactNode {
  return (
    <Badge variant="outline" className="flex-none font-mono font-normal text-muted-foreground">
      {props.kind}
    </Badge>
  )
}

export interface JobsDrawerProps {
  rows: readonly TreeJob[]
  /** Agent count of the tree (root included) — the auto-collapse signal. */
  agentCount: number
  /** Open the output popover of one row (anchor = the row's main button). */
  onOpenOutput(row: TreeJob, anchor: HTMLElement): void
  /** The job whose output popover is currently open (row highlight). */
  openJobId?: string
}

export function JobsDrawer(props: JobsDrawerProps): ReactNode {
  const { rows, agentCount, onOpenOutput, openJobId } = props
  const autoOpen = agentCount < JOBS_DRAWER_COLLAPSE_AT
  /** Manual override; undefined = follow the auto rule. */
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(undefined)
  const open = manualOpen ?? autoOpen
  const [armedId, setArmedId] = useState<string | undefined>(undefined)
  const [killingId, setKillingId] = useState<string | undefined>(undefined)
  const [killErrorId, setKillErrorId] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  const liveCount = useMemo(
    () => rows.reduce((count, row) => count + (isJobLive(row.job) ? 1 : 0), 0),
    [rows],
  )
  const multiOwner = useMemo(
    () => new Set(rows.map(row => row.ownerSessionId)).size > 1,
    [rows],
  )

  // The kill button stays armed only briefly; a stray click must never kill.
  useEffect(() => {
    if (armedId === undefined) return
    const timer = window.setTimeout(() => { setArmedId(undefined) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armedId])

  useEffect(() => {
    if (liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [liveCount])

  const kill = useCallback(async (row: TreeJob): Promise<void> => {
    setKillingId(row.job.id)
    setKillErrorId(undefined)
    try {
      await api.jobKill({ sessionId: row.ownerSessionId }, row.job.id)
    } catch {
      setKillErrorId(row.job.id)
    } finally {
      setKillingId(undefined)
      setArmedId(undefined)
    }
  }, [])

  if (rows.length === 0) return null

  const countLabel = liveCount > 0
    ? t('jobsCountRunning', { count: rows.length, running: liveCount })
    : t('jobsCount', { count: rows.length })

  return (
    <Collapsible
      open={open}
      onOpenChange={(next: boolean) => { setManualOpen(next) }}
      role="region"
      aria-label={t('jobs')}
      className="z-[5] flex-none bg-background"
    >
      {/* The drawer's top edge: the stock hairline (the bar itself carries the
          surface, the rows own their own rhythm). */}
      <Separator />
      {/* The bar keeps the drawer's whole toggle affordance (title, running
          tally, count line) and Radix owns aria-expanded / aria-controls. */}
      <CollapsibleTrigger
        className="flex w-full cursor-pointer items-center gap-2 rounded-none border-0 bg-transparent px-3 py-[7px] text-left font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase transition-colors outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span>{t('jobs')}</span>
        <span className="text-sm font-semibold text-primary tabular-nums">
          {liveCount > 0 ? liveCount : rows.length}
        </span>
        <span className="tracking-[0.02em] text-foreground-3 normal-case">{countLabel}</span>
        <span
          className={cn(
            'ml-auto inline-flex text-foreground-3 transition-transform duration-150',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        >
          <IconChevronUpOutline14 size={12} />
        </span>
      </CollapsibleTrigger>
      {!autoOpen && (
        <div className="px-3 pb-2 font-mono text-xs text-foreground-3">{t('jobsAutoCollapsed')}</div>
      )}
      <CollapsibleContent>
        <Separator />
        {/* Bounded log surface: one `Item` row per job, separated by the
            rows' own 4px rhythm rather than per-row borders. The height is
            definite (not `max-h`) because ScrollArea's viewport is `size-full`:
            a bare max-height leaves the viewport content-sized, so the rows
            would spill out of the drawer instead of scrolling. */}
        <ScrollArea className="h-[156px] w-full min-w-0">
          <ItemGroup className="min-w-0 gap-0.5 px-2 pt-1 pb-2">
            {rows.map((row) => {
              const { job } = row
              const live = isJobLive(job)
              const armed = armedId === job.id
              const killing = killingId === job.id
              const killFailed = killErrorId === job.id
              const elapsed = live
                ? now - job.startedAt
                : (job.finishedAt ?? job.startedAt) - job.startedAt
              const duration = formatJobDuration(elapsed, t)
              // The owner/detail tail; the duration is its own tabular-nums
              // cell, while the accessible name keeps the exact
              // `owner · detail · duration` string it always had.
              const context = [
                ...(multiOwner ? [row.ownerTitle] : []),
                ...(job.detail !== undefined && job.detail !== '' ? [job.detail] : []),
              ].join(' · ')
              const secondary = [context, duration].filter(Boolean).join(' · ')
              return (
                <Item
                  key={job.id}
                  size="sm"
                  // The row whose output is open wears the muted surface (the
                  // stock Item variant) instead of a one-off background class.
                  variant={openJobId === job.id ? 'muted' : 'default'}
                  data-settled={live ? 'false' : 'true'}
                  data-open={openJobId === job.id ? 'true' : 'false'}
                  className={cn(
                    'min-w-0 flex-nowrap gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted',
                    // A settled job recedes by ink (the label line drops to the
                    // secondary level), not by opacity.
                    !live && 'text-muted-foreground',
                  )}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-0 text-left"
                    aria-label={`${job.label} ${jobStatusLabel(job.status, t)} ${secondary}`}
                    title={t('jobViewOutput')}
                    onClick={(event) => { onOpenOutput(row, event.currentTarget) }}
                  >
                    {/* `size-1.5` opts the dot out of the Button's
                        `[&_svg:not([class*='size-'])]:size-4` rule (the
                        running state draws an svg, the others a span), so the
                        indicator keeps its 6px. */}
                    <StateDot state={jobDotState(job.status)} size={6} className="size-1.5" />
                    <KindBadge kind={job.kind} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono text-sm',
                        live ? 'text-foreground' : 'text-muted-foreground',
                      )}
                      title={job.label}
                    >
                      {job.label}
                    </span>
                    <Badge variant={statusVariant(job)} className="flex-none">
                      {jobStatusLabel(job.status, t)}
                    </Badge>
                    {context !== '' && (
                      <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
                        {context}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      {duration}
                    </span>
                  </Button>
                  {job.status === 'running' && (
                    <ItemActions className="gap-1">
                      <Button
                        // The armed confirm is the stock `destructive` variant;
                        // unarmed stays a quiet outline chip.
                        variant={armed ? 'destructive' : 'outline'}
                        size="xs"
                        // Inline row action: quiet until the row is hovered, but
                        // keyboard focus brings it back (focus-visible below).
                        className="opacity-0 transition-opacity group-hover/item:opacity-100 focus-visible:opacity-100"
                        data-armed={armed ? 'true' : 'false'}
                        aria-label={armed ? t('jobKillConfirm') : t('jobKill')}
                        title={armed ? t('jobKillConfirm') : t('jobKill')}
                        disabled={killing}
                        onClick={() => {
                          if (armed) void kill(row)
                          else setArmedId(job.id)
                        }}
                      >
                        <IconStopFill16 />
                        {armed ? t('jobKillConfirm') : undefined}
                      </Button>
                    </ItemActions>
                  )}
                  {killFailed && (
                    <span className="shrink-0 font-mono text-xs text-destructive">{t('jobKillError')}</span>
                  )}
                </Item>
              )
            })}
          </ItemGroup>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The output popover content of one job: the text the MODEL has read so far
 * (replayed from the owner session's event log), refreshed every
 * {@link JOB_POLL_MS} while the job runs and the page is visible. The reader
 * can copy the output and turn the terminal-style tail off; the kill action
 * keeps its two-click confirm.
 *
 * The card fills the AnchoredPopover surface (rounded-lg + border + shadow
 * live there, since that host owns the float) and only places its content
 * inside it: header, the `Item` identity block, the terminal tail, and the
 * `Item` action footer. `data-popover-handle` / `data-popover-no-drag` keep
 * the drag contract unchanged — the body drags, the controls do not.
 */
export function JobOutputPopoverContent(props: {
  ownerSessionId: string
  job: SidebarJobView
  active: boolean
}): ReactNode {
  const { ownerSessionId, job, active } = props
  const [state, setState] = useState<'loading' | JobOutputResult | 'error'>('loading')
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)
  const [killing, setKilling] = useState(false)
  const [killFailed, setKillFailed] = useState(false)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const preRef = useRef<HTMLPreElement>(null)
  const live = isJobLive(job)

  const load = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const result = await api.jobOutput({ sessionId: ownerSessionId }, job.id, controller.signal)
      setState(result)
    } catch {
      // A newer pull aborted this one, or the wire failed: keep the last
      // known output; only a popover that never loaded anything shows an error.
      setState(current => (current === 'loading' ? 'error' : current))
    }
  }, [ownerSessionId, job.id])

  useEffect(() => {
    void load()
    if (!active || !live) return
    const timer = window.setInterval(() => { void load() }, JOB_POLL_MS)
    return () => { window.clearInterval(timer) }
    // isJobLive reads only job.status; the job object churns on every catalog
    // refresh and must not restart the poll interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, active, job.status])

  useEffect(() => () => { controllerRef.current?.abort() }, [])

  // The armed kill disarms itself, like the drawer's button.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => { setArmed(false) }, JOB_KILL_ARM_MS)
    return () => { window.clearTimeout(timer) }
  }, [armed])

  // Terminal-tail behavior: each refresh pins the view to the newest output
  // while the reader keeps the follow switch on.
  useEffect(() => {
    if (!live || !follow || typeof state !== 'object' || state.text.length === 0) return
    const pre = preRef.current
    if (pre !== null) pre.scrollTop = pre.scrollHeight
    // Same as the poll effect: only the status transition matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, job.status, follow])

  const text = typeof state === 'object' ? state.text : ''

  /** Two-click kill from the popover (then re-read so the row settles). */
  const kill = async (): Promise<void> => {
    setKilling(true)
    setKillFailed(false)
    try {
      await api.jobKill({ sessionId: ownerSessionId }, job.id)
      setArmed(false)
      await load()
    } catch {
      setKillFailed(true)
    } finally {
      setKilling(false)
    }
  }

  return (
    // `dsw-tasks`: this card renders inside AnchoredPopover's portal at
    // document.body — OUTSIDE the page root — so it re-declares the page root
    // class for the scoped base reset (see TaskWindow.tsx).
    <div className="dsw-tasks box-border flex flex-col gap-2 p-2.5 text-sm text-popover-foreground" data-popover-handle>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs tracking-[0.14em] text-foreground-3 uppercase">{t('jobs')}</span>
        <span className="inline-flex items-center" data-popover-no-drag>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={copied ? t('jobCopied') : t('jobCopyOutput')}
            title={copied ? t('jobCopied') : t('jobCopyOutput')}
            disabled={text === ''}
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true)
                window.setTimeout(() => { setCopied(false) }, 1500)
              })
            }}
          >
            <IconCopyOutline16 />
          </Button>
        </span>
      </div>
      {/* The job's identity: the stock `Item` composition (media / content /
          actions) rather than a hand-rolled row. */}
      <Item size="sm" variant="muted" className="min-w-0 flex-nowrap gap-2 rounded-md px-2 py-1.5">
        <ItemMedia>
          <StateDot state={jobDotState(job.status)} size={8} />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full min-w-0">
            <span className="min-w-0 flex-1 truncate" title={job.label}>{job.label}</span>
          </ItemTitle>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <KindBadge kind={job.kind} />
            {job.detail !== undefined && job.detail !== '' && (
              <span className="min-w-0 truncate">{job.detail}</span>
            )}
            <span className="flex-none text-foreground-3">{t('jobDragHint')}</span>
          </span>
        </ItemContent>
        <ItemActions>
          <Badge variant={statusVariant(job)}>{jobStatusLabel(job.status, t)}</Badge>
        </ItemActions>
      </Item>
      {state === 'loading' && (
        <div className="flex items-center gap-1.5 text-xs text-foreground-3">
          {/* The visible line carries the copy; the glyph is decoration. */}
          <span className="flex flex-none items-center" aria-hidden="true">
            <Spinner className="size-3" />
          </span>
          {t('loading')}
        </div>
      )}
      {state === 'error' && <div className="text-xs text-destructive">{t('jobOutputError')}</div>}
      {typeof state === 'object' && (
        <>
          {state.text.length > 0
            ? (
              <pre
                ref={preRef}
                className="max-h-[168px] overflow-auto rounded-md border border-border bg-background p-2 font-mono text-xs leading-[1.55] break-words whitespace-pre-wrap text-muted-foreground"
                data-popover-no-drag
              >
                {state.text}
              </pre>
            )
            : state.read
              ? <div className="text-xs text-foreground-3">{t('jobNoOutput')}</div>
              : <div className="text-xs text-foreground-3">{t('jobNotReadYet')}</div>}
          {state.truncated && <div className="text-xs text-foreground-3">{t('jobOutputTruncated')}</div>}
        </>
      )}
      <Separator />
      {/* The action footer: the follow-latest switch and the kill confirm. */}
      <Item
        size="sm"
        className="min-w-0 flex-nowrap justify-between gap-2 rounded-md px-0 py-0"
        data-popover-no-drag
      >
        <Switch
          checked={follow}
          onChange={setFollow}
          label={t('jobFollowTail')}
          disabled={!live}
        />
        {live && (
          <Button
            variant={armed ? 'destructive' : 'outline'}
            size="sm"
            disabled={killing}
            onClick={() => {
              if (armed) void kill()
              else setArmed(true)
            }}
          >
            <IconStopFill16 />
            {armed ? t('jobKillConfirm') : t('jobKill')}
          </Button>
        )}
      </Item>
      {killFailed && <div className="text-xs text-destructive">{t('jobKillError')}</div>}
    </div>
  )
}

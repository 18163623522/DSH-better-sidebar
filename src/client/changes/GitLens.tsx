/**
 * The Git lens of the changes tab: repository truth — the changed files
 * (unstaged / staged), stage/unstage, commit with a message box, branch and
 * checkout switching, and a VSCode-like history with decorations, author and
 * relative time. Clicking a changed file or a history row previews it in the
 * tab's shared bottom pane (see {@link DiffPane}); rows carry right-click
 * context menus with advanced operations (open in editor, discard, revert,
 * cherry-pick, copy paths/hashes).
 *
 * The git status itself is NOT fetched here: it comes from the plugin's one
 * shared store (`ui/git-status.ts`), which the file tree also subscribes to,
 * so both surfaces color/lists the same answer from a single poller. This
 * component owns the checkout-derived surfaces a status call cannot answer
 * (worktree inventory, branch choices, history) and every mutation.
 *
 * Two error channels, one each: the commit bar owns its single status line
 * (commit / stage / discard / revert failures), and the lens owns the top
 * banner (refresh, branch switch, history paging). Branch and history
 * failures used to land under the commit box, which read as "your commit
 * failed" for an action the user never ran.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Button, IconCodeOutlineRegular, IconCopyOutlineRegular, IconPlusOutlineRegular,
  IconTrashOutlineRegular, Input, Menu, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { GitLogEntry, GitStatusEntry, GitStatusResult, GitWorktree, SessionScope } from '../api.ts'
import { api } from '../api.ts'
import { usePolling } from '../use-polling.ts'
import { baseName, isWithinWorkspace, relativeTo } from '../paths.ts'
import { resolveSidebarPath } from '../paths.ts'
import { relativeTime, t } from '../locales.ts'
import type { SidebarDiffRef, SidebarStore } from '../state.ts'
import {
  ConfirmDialog, IconButton, Notice, SectionHeader, StatusBadge, invalidateGitStatus, statusOfXY,
  useGitStatus, type GitFileStatus, type GitTone, type StatusTone,
} from '../ui/index.ts'
import css from './changes.module.css'

/** Whether the entry carries STAGED (index) changes — the X letter is set. */
function isStagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.staged === true
}

/** Whether the entry carries UNSTAGED (worktree) changes — the Y letter is set
 *  (untracked `??` counts as unstaged: it is a worktree-only change). A file
 *  with both letters set ('MM') lands in BOTH sections. */
function isUnstagedEntry(entry: GitStatusEntry): boolean {
  return statusOfXY(entry.xy)?.unstaged === true
}

/** Whether the entry is untracked (`??`): git diff never includes it. */
function isUntracked(entry: GitStatusEntry): boolean {
  return entry.xy === '??'
}

/** The porcelain tone → the kit badge tone (a copy reads as a rename). */
const BADGE_TONE: Record<GitTone, StatusTone> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  untracked: 'untracked',
  renamed: 'renamed',
  copied: 'renamed',
  conflict: 'conflict',
}

/** Split a repo-relative path into the row's name (kept) and its directory
 *  (dimmed context). */
function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at === -1 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) }
}

/** The ref names of one log row's decorations (`HEAD -> main` → `main`), deduped. */
function refNames(refs: string): string[] {
  return [...new Set(
    refs
      .split(',')
      .map(ref => ref.trim())
      .filter(ref => ref !== '')
      .map(ref => (ref.includes(' -> ') ? ref.slice(ref.indexOf(' -> ') + 4) : ref))
      .map(ref => (ref.startsWith('tag: ') ? ref.slice(5) : ref)),
  )]
}

/** One thrown value as display text (every error line here normalizes through
 *  this so non-Error rejections never render as '[object Object]'). */
function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** The pending destructive action (discard / revert / cherry-pick), gated by a confirm dialog. */
interface ConfirmState {
  title: string
  description: string
  confirmLabel: string
  onConfirm: () => Promise<unknown>
}

/** History batch size: the log loads lazily in pages so a long history never
 *  floods the panel at once (the end of the log is reached by paging). */
const LOG_BATCH = 20

/** Cadence of the background worktree re-list: the shared status store already
 *  polls the selected checkout's status, so the inventory (a different call)
 *  only needs to notice a linked checkout the agent created mid-session —
 *  within ~30s, without a second git process per status tick. */
const WORKTREE_POLL_MS = 30_000

/** One changed file's row: badge letter + file name + dimmed directory +
 *  the trailing stage/unstage action. The ONE renderer both sections use. */
function ChangeRow(props: {
  entry: GitStatusEntry
  status: GitFileStatus | undefined
  staged: boolean
  busy: boolean
  selected: boolean
  onPreview(): void
  onContextMenu(event: MouseEvent): void
  onToggleStage(): void
}): ReactNode {
  const { entry, status, staged, busy, selected } = props
  const { name, dir } = splitPath(entry.path)
  const action = staged ? t('unstage') : t('stage')
  return (
    <div className={css.row} data-selected={selected ? 'true' : undefined}>
      <button
        type="button"
        className={css.rowMain}
        data-path={entry.path}
        title={entry.path}
        onClick={props.onPreview}
        onContextMenu={props.onContextMenu}
      >
        <StatusBadge tone={status === undefined ? 'neutral' : BADGE_TONE[status.tone]}>
          {status?.letter ?? '?'}
        </StatusBadge>
        <span className={css.rowName}>{name}</span>
        {dir !== '' && <span className={css.rowDir}>{dir}</span>}
      </button>
      <IconButton
        size="sm"
        disabled={busy}
        label={action}
        icon={staged ? <IconTrashOutlineRegular size={14} /> : <IconPlusOutlineRegular size={14} />}
        onClick={props.onToggleStage}
      />
    </div>
  )
}

export interface GitLensProps {
  scope: SessionScope
  /** The sidebar store: reads the `workspaceFence` pref (see the open guard below). */
  store: SidebarStore
  onOpenFile: (path: string) => void
  /** Preview one change in the shared bottom pane (worktree or commit ref). */
  onPreview: (ref: SidebarDiffRef) => void
  /** The ref currently previewed (row highlight); null when the pane is closed. */
  selectedRef: SidebarDiffRef | null
  /** Poll the inventory only while the tab is actually visible. */
  visible: boolean
  /** Bumped by the tab header's refresh action (0 = never asked). */
  refreshTick?: number
}

export function GitLens(props: GitLensProps) {
  const { scope, store, onOpenFile, onPreview, selectedRef, visible, refreshTick = 0 } = props

  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [repoRoot, setRepoRoot] = useState<string | undefined>()
  /** Every repository of the session workspace, kept once discovered: the
   *  status of a SELECTED child reports only itself, so the selector's option
   *  list cannot be re-derived from the current snapshot alone. */
  const [repoChoices, setRepoChoices] = useState<string[]>([])
  const [branchNames, setBranchNames] = useState<string[]>([])
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([])
  /** Whether the history was fully paged (a batch shorter than LOG_BATCH). */
  const [logEnded, setLogEnded] = useState(false)
  const [logLoadingMore, setLogLoadingMore] = useState(false)
  /** The history's own failure state: an empty list must not claim "no commits"
   *  when the log call failed. */
  const [logFailed, setLogFailed] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState(false)
  /** The commit bar's ONE status line (commit / stage / discard / revert). */
  const [actionError, setActionError] = useState<string | null>(null)
  /** The lens-level error banner (refresh / branch switch / history paging). */
  const [viewError, setViewError] = useState<string | null>(null)

  /** The open file-row context menu (cursor position for the portaled Menu). */
  const [fileMenu, setFileMenu] = useState<{ entry: GitStatusEntry; staged: boolean; x: number; y: number } | null>(null)
  /** The open history-row context menu. */
  const [historyMenu, setHistoryMenu] = useState<{ entry: GitLogEntry; x: number; y: number } | null>(null)
  /** The pending destructive action awaiting confirmation. */
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  /** The selected checkout, readable synchronously by the refresh chain
   *  without making every callback depend on the state it writes. */
  const chosenPathRef = useRef<string | undefined>(undefined)
  /** The automatic preference for a dirty linked checkout runs ONCE per
   *  scope: after it (or after any explicit user choice) a later re-list
   *  must never yank the view off the checkout the user is working in. */
  const autoSelectDone = useRef(false)
  /** The scope and repo the git calls target, readable at call time: a repo
   *  switch refreshes with the NEW root even before React re-renders. */
  const scopeRef = useRef<{ sessionId: string; cwd: string | undefined }>({ sessionId: scope.sessionId, cwd: scope.cwd })
  const repoRootRef = useRef<string | undefined>(undefined)
  /** Bumped whenever the scope resets: a late response of the previous scope
   *  can never publish rows into the new one. */
  const scopeGen = useRef(0)
  /** The refresh chain's queue: a request landing while one runs is replayed
   *  once after it settles — a manual refresh is never silently dropped. */
  const gate = useRef({ inFlight: false, queued: false, queuedSilent: true })

  useEffect(() => { scopeRef.current = { sessionId: scope.sessionId, cwd: scope.cwd } }, [scope.sessionId, scope.cwd])

  /** The session scope every git call of this lens targets right now. */
  const gitScopeNow = useCallback((): SessionScope => {
    const base = scopeRef.current
    return repoRootRef.current === undefined ? { ...base } : { ...base, repoRoot: repoRootRef.current }
  }, [])

  // The status store keys on the checkout being LISTED: a selected child
  // repository becomes the effective cwd, which is also what makes the status
  // and the inventory agree after a repo switch.
  // The status store keys on `worktree`; the PRIMARY checkout is exactly what
  // an unscoped status call resolves to, so passing its path would mint a
  // second key (and a second 2.5s `git status` poll) for the same answer the
  // file tree already subscribes to. Only a LINKED checkout narrows the key.
  const primaryWorktree = worktrees.find(entry => entry.current)?.path
  const statusWorktree = selectedWorktree !== undefined && selectedWorktree !== primaryWorktree
    ? selectedWorktree
    : undefined
  const status = useGitStatus(
    { sessionId: scope.sessionId, cwd: repoRoot ?? scope.cwd },
    { worktree: statusWorktree, visible },
  )
  const snapshot: GitStatusResult | null = status.snapshot
  useEffect(() => {
    const repositories = snapshot?.repositories
    if (repositories !== undefined && repositories.length > 1) setRepoChoices(repositories)
  }, [snapshot])

  /** Select one checkout (or none) and remember the choice synchronously. */
  const selectWorktree = (target: string | undefined): void => {
    chosenPathRef.current = target
    setSelectedWorktree(target)
  }

  /** Drop every checkout-derived surface before another one loads. */
  const clearDerived = (): void => {
    setBranchNames([])
    setLogEntries([])
    setLogEnded(false)
    setLogLoadingMore(false)
    setLogFailed(false)
    setActionError(null)
  }

  /** Load the branch choices and the first history page of one checkout. */
  const loadTarget = useCallback(async (target: string | undefined): Promise<void> => {
    const generation = scopeGen.current
    const gitScope = gitScopeNow()
    const [branchResult, logResult] = await Promise.all([
      api.gitBranch(gitScope, target).catch(() => ({ current: '', names: [] as string[] })),
      api.gitLog(gitScope, LOG_BATCH, 0, target).then(
        entries => ({ entries, failed: false }),
        () => ({ entries: [] as GitLogEntry[], failed: true }),
      ),
    ])
    if (generation !== scopeGen.current) return
    setBranchNames(branchResult.names)
    setLogEntries(logResult.entries)
    setLogEnded(logResult.entries.length < LOG_BATCH)
    setLogFailed(logResult.failed)
  }, [gitScopeNow])

  /** One listing pass: re-read the worktree inventory, apply the first-pass
   *  automatic selection, then load the chosen checkout's derived surfaces.
   *  The shared status store follows the same selection on its own. */
  const runOnce = useCallback(async (silent: boolean, signal?: AbortSignal): Promise<void> => {
    const generation = scopeGen.current
    let listed: GitWorktree[]
    try {
      listed = await api.gitWorktrees(gitScopeNow(), signal)
    } catch (reason) {
      if (signal?.aborted !== true && generation === scopeGen.current) setViewError(errorMessage(reason))
      return
    }
    if (signal?.aborted === true || generation !== scopeGen.current) return
    setWorktrees(listed)
    const current = listed.find(entry => entry.current)
    const stillListed = chosenPathRef.current !== undefined
      && listed.some(entry => entry.path === chosenPathRef.current)
    let target = stillListed ? chosenPathRef.current : current?.path
    if (!autoSelectDone.current) {
      // DSH and other coding agents commonly create ONE linked checkout while
      // the session remains rooted at the clean primary checkout. Select that
      // checkout automatically only when the choice is unambiguous — and only
      // on this first pass, never again.
      const dirtyLinked = listed.filter(entry => !entry.current && entry.changes > 0)
      if ((current?.changes ?? 0) === 0 && dirtyLinked.length === 1) {
        target = dirtyLinked[0]!.path
        autoSelectDone.current = true
      } else if (current !== undefined) {
        target = current.path
        autoSelectDone.current = true
      }
    }
    const targetChanged = target !== chosenPathRef.current
    if (targetChanged) {
      selectWorktree(target)
      clearDerived()
    }
    // A silent tick only keeps the inventory (and its change counts) fresh.
    if (silent && !targetChanged) return
    await loadTarget(target)
  }, [gitScopeNow, loadTarget])

  /** Run one refresh, replaying a request that arrives mid-flight exactly once. */
  const refresh = useCallback(async (silent = false, signal?: AbortSignal): Promise<void> => {
    const current = gate.current
    if (current.inFlight) {
      current.queued = true
      if (!silent) current.queuedSilent = false
      return
    }
    current.inFlight = true
    let nextSilent = silent
    try {
      for (;;) {
        current.queued = false
        current.queuedSilent = true
        if (signal?.aborted === true) break
        if (!nextSilent) setViewError(null)
        await runOnce(nextSilent, signal)
        if (!current.queued) break
        nextSilent = current.queuedSilent
      }
    } finally {
      current.inFlight = false
    }
  }, [runOnce])

  // Mount / scope change: reset every piece of per-scope state, then load.
  // A tab mounted while hidden loads nothing (its status store has no visible
  // consumer either); the rising-edge catch-up below loads it on screen.
  useEffect(() => {
    scopeGen.current += 1
    gate.current = { inFlight: false, queued: false, queuedSilent: true }
    autoSelectDone.current = false
    chosenPathRef.current = undefined
    repoRootRef.current = undefined
    setWorktrees([])
    setSelectedWorktree(undefined)
    setRepoRoot(undefined)
    setRepoChoices([])
    clearDerived()
    setViewError(null)
    if (visible) void refresh(false)
    // Granular scope fields: the refresh identity is stable, only a real
    // session/cwd change restarts the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.sessionId, scope.cwd])

  // Becoming visible (or visible again): catch the derived surfaces up. The
  // shared status re-fetches on the same edge (its store drops the snapshot
  // when the last consumer goes away), so both halves of the lens agree.
  const wasVisible = useRef(visible)
  useEffect(() => {
    const rising = visible && !wasVisible.current
    wasVisible.current = visible
    if (!rising) return
    void refresh(false)
    // Granular scope fields: only the visibility edge drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // The header's refresh action: re-read the inventory and derived surfaces,
  // and force the SHARED status of this session (the file tree's colors too).
  useEffect(() => {
    if (refreshTick === 0) return
    void refresh(false)
    invalidateGitStatus(scope.sessionId)
    // Only the tick drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick])

  /** The inventory poll: a linked checkout created mid-session shows up
   *  without a manual refresh (the status poll itself belongs to the store). */
  const pollInventory = useCallback((signal: AbortSignal): Promise<void> => refresh(true, signal), [refresh])
  usePolling(visible, pollInventory, { intervalMs: WORKTREE_POLL_MS, mode: 'self-scheduling' })

  /** Run one mutating git action: lock the bar, refresh the shared status and
   *  the derived surfaces on success, and report the failure in the commit
   *  bar's single status line (never as an unhandled rejection). */
  const runAction = async (
    action: () => Promise<unknown>,
    failure: (reason: unknown) => string = errorMessage,
    onSuccess?: () => void,
  ): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await action()
      onSuccess?.()
      invalidateGitStatus(scope.sessionId)
      await refresh(false)
    } catch (reason) {
      setActionError(failure(reason))
    } finally {
      setBusy(false)
    }
  }

  const stageError = (reason: unknown): string => t('changesStageFailed', { message: errorMessage(reason) })

  const stageEntry = (entry: GitStatusEntry, staged: boolean): void => {
    void runAction(
      () => (staged ? api.gitUnstage(gitScopeNow(), entry.path, selectedWorktree) : api.gitStage(gitScopeNow(), entry.path, selectedWorktree)),
      stageError,
    )
  }

  const stageAll = (staged: boolean): void => {
    void runAction(
      () => (staged ? api.gitUnstage(gitScopeNow(), undefined, selectedWorktree) : api.gitStage(gitScopeNow(), undefined, selectedWorktree)),
      stageError,
    )
  }

  const commit = (): void => {
    const message = commitMsg.trim()
    if (message === '' || busy) return
    void runAction(() => api.gitCommit(gitScopeNow(), message, selectedWorktree), errorMessage, () => { setCommitMsg('') })
  }

  /** Switching the selected checkout changes which rows are legitimate to act
   *  on: clear the derived surfaces before the asynchronous refresh resolves
   *  so a stale history row can never run over the new checkout's repository. */
  const chooseWorktree = (target: string): void => {
    if (target === chosenPathRef.current) return
    autoSelectDone.current = true
    selectWorktree(target)
    clearDerived()
    void refresh(false)
  }

  /** Switching the selected child repository: both the inventory and the
   *  status key follow the new root, and exactly ONE full refresh runs. The
   *  checkout choice resets to the new repository's current one — an explicit
   *  user choice never triggers the automatic linked-checkout preference. */
  const chooseRepo = (target: string): void => {
    if (target === repoRoot) return
    autoSelectDone.current = true
    chosenPathRef.current = undefined
    repoRootRef.current = target
    setSelectedWorktree(undefined)
    setRepoRoot(target)
    setWorktrees([])
    clearDerived()
    void refresh(false)
  }

  const checkout = async (branch: string): Promise<void> => {
    if (branch === (snapshot?.branch ?? '') || busy) return
    setBusy(true)
    setViewError(null)
    try {
      await api.gitCheckout(gitScopeNow(), branch, selectedWorktree)
      invalidateGitStatus(scope.sessionId)
      await refresh(false)
    } catch (reason) {
      setViewError(`${t('checkoutError')}: ${errorMessage(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  /** Run one destructive operation after the confirm dialog, then refresh. */
  const runConfirmed = (confirmState: ConfirmState): void => {
    setConfirm(confirmState)
  }

  const confirmPending = (): void => {
    const pending = confirm
    if (pending === null) return
    setConfirm(null)
    void runAction(pending.onConfirm)
  }

  /** Append the next history page (lazy: only when the user asks for more). */
  const loadMoreLog = async (): Promise<void> => {
    if (logLoadingMore || logEnded) return
    const generation = scopeGen.current
    const target = chosenPathRef.current
    setLogLoadingMore(true)
    setViewError(null)
    try {
      const next = await api.gitLog(gitScopeNow(), LOG_BATCH, logEntries.length, target)
      // A worktree switch clears the old history; never append a late page
      // from that checkout into the new one.
      if (generation !== scopeGen.current || target !== chosenPathRef.current) return
      setLogEntries(entries => [...entries, ...next])
      if (next.length < LOG_BATCH) setLogEnded(true)
    } catch (reason) {
      if (generation === scopeGen.current && target === chosenPathRef.current) {
        setViewError(`${t('historyLoadError')}: ${errorMessage(reason)}`)
      }
    } finally {
      if (generation === scopeGen.current && target === chosenPathRef.current) setLogLoadingMore(false)
    }
  }

  /** Copy `text` to the clipboard (best-effort; no visual feedback needed — the menu closes). */
  const copy = (text: string): void => {
    void writeClipboard(text)
  }

  const openFileMenu = (event: MouseEvent, entry: GitStatusEntry, staged: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    setFileMenu({ entry, staged, x: event.clientX, y: event.clientY })
  }

  const openHistoryMenu = (event: MouseEvent, entry: GitLogEntry): void => {
    event.preventDefault()
    event.stopPropagation()
    setHistoryMenu({ entry, x: event.clientX, y: event.clientY })
  }

  /** The preview ref for one changed file (one ref per path+side). */
  const worktreeRefOf = (entry: GitStatusEntry, staged: boolean): SidebarDiffRef => ({
    kind: 'worktree',
    path: entry.path,
    staged,
    untracked: isUntracked(entry),
    worktree: selectedWorktree,
    repoRoot,
  })

  /** The preview ref for one commit. */
  const commitRefOf = (entry: GitLogEntry): SidebarDiffRef => ({
    kind: 'commit',
    hash: entry.hash,
    hashFull: entry.hashFull,
    subject: entry.subject,
    worktree: selectedWorktree,
    repoRoot,
  })

  /** Whether a worktree row is the one currently previewed. */
  const isPreviewedWorktree = (entry: GitStatusEntry, staged: boolean): boolean => {
    if (selectedRef === null || selectedRef.kind !== 'worktree') return false
    return selectedRef.path === entry.path && selectedRef.staged === staged
      && (selectedRef.worktree ?? '') === (selectedWorktree ?? '')
  }

  const entries = snapshot?.entries ?? []
  const stagedEntries = entries.filter(isStagedEntry)
  const unstagedEntries = entries.filter(isUnstagedEntry)
  const isRepo = snapshot?.isRepo === true
  const branch = snapshot?.branch ?? ''
  const branchOptions = branch === '' ? branchNames : [branch, ...branchNames.filter(name => name !== branch)]
  const clean = isRepo && stagedEntries.length === 0 && unstagedEntries.length === 0

  /** One change row (the single renderer of both sections). */
  const renderEntry = (entry: GitStatusEntry, staged: boolean): ReactNode => (
    <ChangeRow
      key={`${staged ? 's' : 'u'}:${entry.path}`}
      entry={entry}
      status={statusOfXY(entry.xy)}
      staged={staged}
      busy={busy}
      selected={isPreviewedWorktree(entry, staged)}
      onPreview={() => { onPreview(worktreeRefOf(entry, staged)) }}
      onContextMenu={(event) => { openFileMenu(event, entry, staged) }}
      onToggleStage={() => { stageEntry(entry, staged) }}
    />
  )

  return (
    <div className={css.git}>
      {(repoChoices.length > 1 || worktrees.length > 1 || branch !== '') && (
        <div className={css.selectors}>
          {repoChoices.length > 1 && (
            <select
              className={css.select}
              value={repoRoot ?? ''}
              title={repoRoot}
              disabled={busy}
              onChange={(event) => { chooseRepo(event.target.value) }}
            >
              {repoChoices.map(root => <option key={root} value={root}>{baseName(root)}</option>)}
            </select>
          )}
          {worktrees.length > 1 && (
            <select
              className={css.select}
              value={selectedWorktree ?? ''}
              title={selectedWorktree}
              disabled={busy}
              onChange={(event) => { chooseWorktree(event.target.value) }}
            >
              {worktrees.map(entry => (
                <option key={entry.path} value={entry.path}>
                  {entry.branch} · {baseName(entry.path)} ({entry.changes})
                </option>
              ))}
            </select>
          )}
          {branch !== '' && (branchOptions.length > 1
            ? (
              <select
                className={css.select}
                value={branch}
                title={t('branch')}
                disabled={busy}
                onChange={(event) => { void checkout(event.target.value) }}
              >
                {branchOptions.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            )
            : <span className={css.branchLabel} title={`${t('branch')}: ${branch}`}>{branch}</span>)}
        </div>
      )}

      {viewError !== null && <Notice kind="error" role="alert">{viewError}</Notice>}

      {snapshot === null && status.loading && <Notice kind="loading" tone="page">{t('loading')}</Notice>}
      {snapshot === null && !status.loading && status.error && <Notice kind="error" tone="page">{t('error')}</Notice>}
      {snapshot !== null && !isRepo && <Notice kind="empty" tone="page">{t('notRepo')}</Notice>}
      {snapshot?.truncated === true && <Notice kind="warn">{t('statusTruncated')}</Notice>}

      {clean && <Notice kind="empty" tone="page">{t('changesClean')}</Notice>}

      {isRepo && !clean && (
        <>
          <SectionHeader
            label={t('unstaged')}
            count={unstagedEntries.length}
            action={unstagedEntries.length > 0
              ? (
                <button type="button" className={css.link} disabled={busy} onClick={() => { stageAll(false) }}>
                  {t('stageAll')}
                </button>
              )
              : undefined}
          />
          {unstagedEntries.map(entry => renderEntry(entry, false))}
          <SectionHeader
            label={t('staged')}
            count={stagedEntries.length}
            action={stagedEntries.length > 0
              ? (
                <button type="button" className={css.link} disabled={busy} onClick={() => { stageAll(true) }}>
                  {t('unstageAll')}
                </button>
              )
              : undefined}
          />
          {stagedEntries.map(entry => renderEntry(entry, true))}
        </>
      )}

      {isRepo && (
        <div className={css.commitBar}>
          <div className={css.commitRow}>
            <Input
              className={css.commitInput}
              placeholder={t('commitPlaceholder')}
              value={commitMsg}
              disabled={busy}
              onChange={(event) => { setCommitMsg(event.target.value); setActionError(null) }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') commit()
              }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || commitMsg.trim() === '' || stagedEntries.length === 0}
              onClick={commit}
            >
              {t('commit')}
            </Button>
          </div>
          {actionError !== null && <Notice kind="error" tone="inline" role="alert">{actionError}</Notice>}
        </div>
      )}

      {isRepo && (
        <>
          <SectionHeader label={t('history')} count={logEntries.length > 0 ? logEntries.length : undefined} />
          {logEntries.length === 0 && logFailed && <Notice kind="error">{t('historyLoadError')}</Notice>}
          {logEntries.length === 0 && !logFailed && logEnded && <Notice kind="empty" tone="page">{t('changesNoHistory')}</Notice>}
          {logEntries.map(entry => (
            <div
              key={entry.hashFull}
              role="button"
              tabIndex={0}
              className={css.logRow}
              data-selected={selectedRef?.kind === 'commit' && selectedRef.hashFull === entry.hashFull ? 'true' : undefined}
              title={`${entry.author} · ${entry.date}\n${entry.hashFull}`}
              onClick={() => { onPreview(commitRefOf(entry)) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onPreview(commitRefOf(entry))
                }
              }}
              onContextMenu={(event) => { openHistoryMenu(event, entry) }}
            >
              <span className={css.logLine1}>
                <span className={css.logHash}>{entry.hash}</span>
                <span className={css.logSubject}>{entry.subject}</span>
              </span>
              <span className={css.logLine2}>
                {refNames(entry.refs).map(ref => (
                  <span key={ref} className={css.logRef}>{ref}</span>
                ))}
                <span className={css.logMeta}>{entry.author} · {relativeTime(entry.date)}</span>
              </span>
            </div>
          ))}
          {!logEnded && (
            <button
              type="button"
              className={css.logMore}
              disabled={logLoadingMore || busy}
              onClick={() => { void loadMoreLog() }}
            >
              {logLoadingMore ? t('loading') : t('loadMore')}
            </button>
          )}
        </>
      )}

      {/*
        The one shared file-row context menu, positioned at the right-click
        cursor (portal so the panel's overflow clip cannot crop it).
      */}
      <Menu
        open={fileMenu !== null}
        onClose={() => { setFileMenu(null) }}
        items={[
          // A linked worktree outside the session workspace cannot be
          // opened in the editor while the host's workspace fence is
          // armed: it rejects every path under that checkout. Hide the
          // action for that checkout so the menu does not offer a no-op
          // that confuses the user; with the fence disarmed (the
          // `workspaceFence` pref) the open is allowed through.
          ...(fileMenu !== null && (store.getPrefs().workspaceFence === false || isWithinWorkspace(scope.cwd ?? '', resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, fileMenu.entry.path)))
            ? [{ id: 'open', label: t('openEditor'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          fileMenu?.staged === true
            ? { id: 'stage', label: t('unstage'), icon: <IconTrashOutlineRegular size={14} /> }
            : { id: 'stage', label: t('stage'), icon: <IconPlusOutlineRegular size={14} /> },
          ...(fileMenu !== null && !isUntracked(fileMenu.entry)
            ? [{ id: 'discard', label: t('discard'), icon: <IconTrashOutlineRegular size={14} />, danger: true }]
            : []),
          { type: 'separator', id: 'sep1' },
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
        ]}
        onSelect={(id) => {
          const target = fileMenu
          if (target === null) return
          setFileMenu(null)
          if (id === 'open') {
            const resolved = resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.entry.path)
            // Defense-in-depth: the menu hides this action when the
            // resolved path escapes the session workspace, but a
            // racing repo switch could still reach here with a path
            // the host would reject. No-op in that case — unless the
            // workspace fence is disarmed by pref.
            if (store.getPrefs().workspaceFence !== false && !isWithinWorkspace(scope.cwd ?? '', resolved)) return
            onOpenFile(resolved)
            return
          }
          if (id === 'stage') {
            stageEntry(target.entry, target.staged)
            return
          }
          if (id === 'discard') {
            runConfirmed({
              title: t('discardTitle'),
              description: t('discardDesc', { path: target.entry.path }),
              confirmLabel: t('discard'),
              onConfirm: () => api.gitDiscard(gitScopeNow(), target.entry.path, selectedWorktree),
            })
            return
          }
          if (id === 'relative') {
            copy(relativeTo(repoRoot ?? selectedWorktree ?? scope.cwd ?? '', target.entry.path))
            return
          }
          if (id === 'absolute') copy(resolveSidebarPath(repoRoot ?? selectedWorktree ?? scope.cwd, target.entry.path))
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (fileMenu === null ? null : new DOMRect(fileMenu.x, fileMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The shared history-row context menu. */}
      <Menu
        open={historyMenu !== null}
        onClose={() => { setHistoryMenu(null) }}
        items={[
          { id: 'view', label: t('viewCommitDiff') },
          { id: 'copyShort', label: t('copyShortHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copyFull', label: t('copyFullHash'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'copySubject', label: t('copySubject'), icon: <IconCopyOutlineRegular size={14} /> },
          { type: 'separator', id: 'sep2' },
          { id: 'revert', label: t('revertCommit'), danger: true },
          { id: 'cherryPick', label: t('cherryPickCommit'), danger: true },
        ]}
        onSelect={(id) => {
          const target = historyMenu
          if (target === null) return
          setHistoryMenu(null)
          if (id === 'view') {
            onPreview(commitRefOf(target.entry))
            return
          }
          if (id === 'copyShort') {
            copy(target.entry.hash)
            return
          }
          if (id === 'copyFull') {
            copy(target.entry.hashFull)
            return
          }
          if (id === 'copySubject') {
            copy(target.entry.subject)
            return
          }
          if (id === 'revert') {
            runConfirmed({
              title: t('revertTitle'),
              description: t('revertDesc', { subject: target.entry.subject }),
              confirmLabel: t('revertCommit'),
              onConfirm: () => api.gitRevert(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
            return
          }
          if (id === 'cherryPick') {
            runConfirmed({
              title: t('cherryPickTitle'),
              description: t('cherryPickDesc', { subject: target.entry.subject }),
              confirmLabel: t('cherryPickCommit'),
              onConfirm: () => api.gitCherryPick(gitScopeNow(), target.entry.hashFull, selectedWorktree),
            })
          }
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (historyMenu === null ? null : new DOMRect(historyMenu.x, historyMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* Destructive actions land here first: Cancel / Confirm. */}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={t('cancel')}
        danger
        busy={busy}
        onConfirm={confirmPending}
        onClose={() => { setConfirm(null) }}
      />
    </div>
  )
}

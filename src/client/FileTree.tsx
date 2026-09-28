/**
 * The controlled file tree behind the files window's tree panel (TreePanel
 * wraps it with the search box): a lazy VSCode-style tree rooted at the
 * session's working directory. Levels load on expansion (one API call per
 * directory; a stale response is dropped by generation guard + abort),
 * directories sort first, hidden entries render dimmed. The expansion set
 * lives in the per-session state (owned by the caller); the caller also owns
 * the refresh affordance — a `refreshTick` bump wipes the level cache so the
 * visible set reloads.
 *
 * Selection (VS Code semantics, no modifier = the old click semantics
 * untouched): Ctrl/Cmd+click toggles a row and sets the anchor, Shift+click
 * selects the visible range from the anchor, Escape / a blank click clears,
 * right-clicking outside the selection collapses it onto the row. A non-empty
 * selection shows the batch bar above the root row (copy paths / delete /
 * clear); the batch delete confirms once and removes sequentially.
 *
 * Git ink: rows read the shared `useGitStatus` store (the changes page reads
 * the same snapshot) — a changed file's name takes its tone and a letter
 * badge, a directory with a change below it is tinted without a letter, and a
 * non-repo silently renders plain.
 *
 * Row actions: hovering a row reveals an @-reference button on the far right
 * (appends `@<relative path>` to the composer draft), and right-click opens a
 * context menu: file rows offer the caller's open escapes (new tab / to the
 * side, only when the callbacks exist), the host's "open in app" section and
 * a download action (the host serves raw bytes, binary-safe); directory rows
 * offer "upload here" and "new folder" (an inline editor at the top of that
 * level); every row can copy the relative or absolute path (with a brief
 * "copied" label replacing the button after a successful write).
 *
 * Rows are memoized components (FileRow / DirRow) fed by stable callbacks and
 * per-row booleans, so a copy flash, a drag target or a selection change only
 * re-renders the rows it touches — not the whole tree.
 *
 * Uploads start here (drag-drop or the context menu picker) but run in the
 * caller: every request is reported through `onUploadRequest(dir, items)`
 * (VSCode semantics — a drop on a file row targets its parent directory),
 * and `busy` gates new drags while one upload is in flight.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  IconArchiveOutlineRegular, IconChevronRightOutlineRegular, IconCloseFillRegular, IconCodeOutlineRegular, IconCopyOutlineRegular,
  IconDownloadOutlineRegular,
  IconEditOutlineRegular, IconFolderOpenRegular, IconLinkOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular,
  Menu, type MenuEntry, type MenuItem, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import { VscFolderOpened, VscLinkExternal, VscPin, VscPinned } from 'react-icons/vsc'
import { api, archiveUrl, downloadUrl, isOutsideWorkspaceMessage, type FsEntry } from './api.ts'
import { FenceErrorNotice } from './FenceErrorNotice.tsx'
import { builtinFileIcon, builtinFolderIcon } from './file-icons.tsx'
import { IconUploadOutline16, IconVscode16 } from './icons.tsx'
import { isImeComposition } from './ime-guard.ts'
import { useSubmenuFlip } from './menu-flip.ts'
import type { OpenInApp, OpenInAppEntry } from './open-in-app.ts'
import type { OpenWithTarget } from './open-with.ts'
import { relativeTo } from './paths.ts'
import { t } from './locales.ts'
import type { BetterSidebarService } from './service.ts'
import type { SidebarStore } from './state.ts'
import {
  Chip, ConfirmDialog, IconButton, Notice, SectionHeader, StatusBadge, useGitStatus,
  type GitFileStatus, type GitTone, type StatusTone,
} from './ui/index.ts'
import { uploadItemsFromDrop, uploadItemsFromFiles, type UploadItem } from './upload.ts'
import { useDirectoryWatch } from './use-dir-watch.ts'
import css from './sidebar.module.css'

interface LevelData {
  entries?: FsEntry[]
  error?: string
  /** The host capped this level's listing (a huge directory). */
  truncated?: boolean
}

/** Root label: the last path segment (mirror of the host rootLabel). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The containing directory of an absolute row path (never the root edge here). */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at <= 0 ? path : path.slice(0, at)
}

/** Only OS file drags belong to the upload surface; in-app drags (tab reorder,
 *  split zones) must pass through untouched to the pane's tab-drop handling
 *  (mirror of Sidebar.tsx's panel-host shield gate). */
function isFileDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false
}

/** How long the row's "copied" label stays after a successful write. */
const COPIED_MS = 1200

/** One changed row's tooltip word (the badge's status vocabulary). */
function gitToneLabel(tone: GitTone): string {
  switch (tone) {
    case 'added': return t('gitStatusAdded')
    case 'deleted': return t('gitStatusDeleted')
    case 'untracked': return t('gitStatusUntracked')
    case 'renamed': return t('gitStatusRenamed')
    case 'conflict': return t('gitStatusConflict')
    // A copy is an added path from the tree's point of view, and the
    // `gitStatus*` vocabulary has no separate word for it.
    case 'copied': return t('gitStatusAdded')
    case 'modified': return t('gitStatusModified')
  }
}

/** The badge tone for one git tone (the kit has no separate 'copied' ink). */
function badgeToneOf(tone: GitTone): StatusTone {
  return tone === 'copied' ? 'added' : tone
}

/**
 * The drop overlay's hero art: an arrow rising out of a notched tray
 * (upload zone — the same glyph family as the toolbar's upload icon) and a
 * tilted pair of photo cards (chat zone). Hand-drawn, but every ink is a
 * theme token: the SVG paints `currentColor` and the classes below pick the
 * accent / tint / cut-out inks.
 */
const UploadDropIllustration = () => (
  <svg width="64" height="56" viewBox="0 0 64 56" fill="none" aria-hidden="true">
    <g className={css.uploadDropArtPrimary}>
      <path d="M32 28V11" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <path d="M23 20l9-9 9 9" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
    <path
      className={css.uploadDropArtAccent}
      d="M10 40a4 4 0 0 1 4-4h7l3.2 4.6a5 5 0 0 0 4.1 2.2h7.4a5 5 0 0 0 4.1-2.2L43 36h7a4 4 0 0 1 4 4v2a10 10 0 0 1-10 10H20A10 10 0 0 1 10 42v-2z"
      fill="currentColor"
    />
  </svg>
)

/** The chat zone's art: two tilted photo cards, each with its own
 *  sun-over-mountains motif (the back card carries detail too, so it never
 *  reads as a bare blob). Same token-only rule as the tray above. */
const ChatDropIllustration = () => (
  <svg width="96" height="76" viewBox="0 0 96 76" fill="none" aria-hidden="true">
    <g transform="rotate(-12 24 34)">
      <rect className={css.uploadDropArtAccent} x="6" y="16" width="36" height="36" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="16" cy="27" r="3.5" fill="currentColor" />
        <path d="M11 44l8-9 6 6 4-4 8 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
    <g transform="rotate(8 61 35)">
      <rect className={css.uploadDropArtPrimary} x="40" y="12" width="42" height="46" rx="10" fill="currentColor" />
      <g className={css.uploadDropArtCut}>
        <circle cx="55" cy="27" r="5" fill="currentColor" />
        <path d="M46 50l10-13 7 8 6-6 9 11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </g>
  </svg>
)

/** The modifier subset row activation needs (clicks and Enter/Space share it). */
interface ActivateModifiers {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * The stable per-row callback bundle. `FileRow` / `DirRow` are memoized, so
 * every handler here must keep its identity for the life of the tree; each
 * one reads the live props/state through the refs the tree maintains.
 */
interface RowActions {
  activate(event: ActivateModifiers, path: string, isDir: boolean): void
  contextMenu(event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean): void
  reference(path: string, isDir: boolean): void
  dragOver(event: DragEvent<HTMLDivElement>, dir: string): void
  drop(event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void
}

/** One open-in-app entry's leading glyph: the host's icon route / data URL,
 *  or a generic mark when the host has no icon for it. */
function AppGlyph(props: { entry: OpenInAppEntry }): ReactNode {
  const { icon } = props.entry
  if (icon === null || icon === '') return <IconCodeOutlineRegular size={14} />
  return <img className={css.explorerAppIcon} src={icon} alt="" width={14} height={14} />
}

/** One file row's props. Everything is a primitive or a stable reference so
 *  memo() actually bails out. */
interface FileRowProps {
  entry: FsEntry
  depth: number
  /** Registry revision: a fresh value re-resolves the row's icon. */
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  revealed: boolean
  /** A drag hovers this row's PARENT directory (upload target). */
  dropTarget: boolean
  copied: boolean
  git: GitFileStatus | undefined
  actions: RowActions
}

const FileRow = memo(function FileRow(props: FileRowProps): ReactNode {
  const { entry, depth, iconsVersion, service, selected, revealed, dropTarget, copied, git, actions } = props
  // Referenced so a registry change re-renders the row with its new icon.
  void iconsVersion
  const icon = service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx(
        css.explorerRow, entry.hidden && css.explorerHidden, entry.broken && css.explorerBroken,
        selected && css.explorerRowSelected,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.broken ? `${entry.path} — ${t('brokenSymlink')}` : entry.path}
      onClick={(event) => { actions.activate(event, entry.path, false) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, false)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, parentOf(entry.path)) }}
      onDrop={(event) => { actions.drop(event, entry.path, false) }}
      onContextMenu={(event) => { actions.contextMenu(event, entry.path, false) }}
    >
      {icon}
      <span className={clsx(css.explorerName, git !== undefined && css.explorerGitName)} data-git-tone={git?.tone}>
        {entry.name}
      </span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {git !== undefined && <StatusBadge tone={badgeToneOf(git.tone)} title={gitToneLabel(git.tone)}>{git.letter}</StatusBadge>}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(entry.path, false)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

/** One directory row's props (same stability rules as {@link FileRowProps}). */
interface DirRowProps {
  entry: FsEntry
  depth: number
  expanded: boolean
  iconsVersion: number
  service: BetterSidebarService | undefined
  selected: boolean
  revealed: boolean
  dropTarget: boolean
  /** A change exists at or below this directory (tinted, never lettered). */
  gitChanged: boolean
  copied: boolean
  actions: RowActions
}

const DirRow = memo(function DirRow(props: DirRowProps): ReactNode {
  const { entry, depth, expanded, iconsVersion, service, selected, revealed, dropTarget, gitChanged, copied, actions } = props
  void iconsVersion
  const icon = service !== undefined ? service.folderIcon(entry.path, expanded, 14) : builtinFolderIcon(expanded, 14)
  return (
    <div
      role="button"
      tabIndex={0}
      className={clsx(
        css.explorerRow, css.explorerDir, entry.hidden && css.explorerHidden,
        selected && css.explorerRowSelected,
        dropTarget && css.explorerRowDropTarget,
        revealed && css.explorerRowRevealed,
      )}
      data-dsh-revealed={revealed ? 'true' : undefined}
      data-dsh-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      style={{ paddingLeft: depth * 22 + 6 }}
      onClick={(event) => { actions.activate(event, entry.path, true) }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          actions.activate(event, entry.path, true)
        }
      }}
      onDragOver={(event) => { actions.dragOver(event, entry.path) }}
      onDrop={(event) => { actions.drop(event, entry.path, true) }}
      onContextMenu={(event) => { actions.contextMenu(event, entry.path, true) }}
    >
      {icon}
      <span className={clsx(css.explorerName, gitChanged && css.explorerDirChanged)}>{entry.name}</span>
      {entry.isSymlink && <IconLinkOutlineRegular size={12} className={css.explorerSymlink} />}
      {copied
        ? <span className={css.explorerCopied}>{t('copied')}</span>
        : (
          <button
            type="button"
            className={css.explorerRef}
            aria-label={t('referenceFile')}
            title={t('referenceFile')}
            onClick={(event) => {
              event.stopPropagation()
              actions.reference(entry.path, true)
            }}
          >
            {t('referenceFile')}
          </button>
        )}
    </div>
  )
})

export function FileTree(props: {
  sessionId: string
  cwd: string | undefined
  /** The sidebar store: the fence-refusal notice writes the `workspaceFence` pref through it. */
  store: SidebarStore
  expanded: string[]
  /** Files highlighted by a "Show in folder" reveal (absolute paths). */
  revealed: string[]
  onToggle: (path: string) => void
  onOpenFile: (path: string) => void
  /** Context-menu "open in a new tab" (file rows; absent → no entry). */
  onOpenFileNewTab?: (path: string) => void
  /** Context-menu "open to the side" (file rows; absent → no entry). */
  onOpenFileSide?: (path: string) => void
  /**
   * The host's open-in-app handle (EditorHost builds it and injects it).
   * Absent, or reporting the host cannot hand paths to the desktop, hides the
   * HOST half of the "打开方式" section (the plugin's own targets stay).
   */
  openInApp?: OpenInApp
  /**
   * The PLUGIN's own "open with" menu: resolved external targets (already
   * SSH-filtered and in menu order). Absent → no plugin half. Coexists with
   * {@link openInApp} — the section lists both.
   */
  openWithTargets?: OpenWithTarget[]
  /** Ids of targets pinned to the menu's top level (subset of the ids). */
  openWithPinned?: string[]
  /** Whether the workspace is remote (appends the SSH hint to target labels). */
  openWithSsh?: boolean
  /** Open one plugin target externally (reveal or URL — the caller decides). */
  onOpenWith?: (targetId: string, path: string) => void
  /** Toggle one plugin target's pinned state (the submenu row's pushpin). */
  onToggleOpenWithPin?: (targetId: string) => void
  /** Insert `@<relative path>` into the composer draft (file vs directory). */
  onReferenceFile: (path: string, isDir: boolean) => void
  /** A rename landed (old row path → new path): the caller retargets open tabs. */
  onPathRenamed?: (oldPath: string, newPath: string) => void
  /** A delete landed: the caller closes tabs at or under the removed path. */
  onPathDeleted?: (path: string, isDir: boolean) => void
  /** Bump to wipe the level cache and reload the visible set. */
  refreshTick: number
  /** Upload into `dir` (absolute, inside the workspace); runs in the caller. */
  onUploadRequest: (dir: string, items: UploadItem[]) => void
  /** True while an upload is in flight (drops are ignored). */
  busy: boolean
  /**
   * Park the tree out of the layout WITHOUT unmounting it: the search results
   * panel takes the surface while the level cache (and the live watcher) stays
   * warm, so clearing the query is free.
   */
  hidden?: boolean
  /**
   * Whether the owning tab is on screen. Defaults to true; a parked tab
   * passes false so the shared git-status store stops polling for rows
   * nobody can see (the workbench keeps every tab body mounted).
   */
  visible?: boolean
  /**
   * The sidebar registry service: when present, externally registered file
   * icons (`registerFileIcon`) outrank the host's file-type artwork on file rows.
   * Absent → the built-ins alone (the host always passes it today).
   */
  service?: BetterSidebarService
}) {
  // `onToggle` / `onOpenFile` are read through `propsRef` (the stable row
  // callbacks must not change identity when the caller re-renders).
  const {
    sessionId, cwd, store, expanded, revealed, onOpenFileNewTab, onOpenFileSide,
    openInApp, openWithTargets, openWithPinned, openWithSsh, onOpenWith, onToggleOpenWithPin,
    onReferenceFile, onPathRenamed, onPathDeleted, refreshTick, onUploadRequest, busy, hidden, visible, service,
  } = props
  /** The live props for the stable callbacks below (identity churns per render). */
  const propsRef = useRef(props)
  propsRef.current = props
  const [data, setData] = useState<Record<string, LevelData>>({})
  /**
   * Registry revision for the file-icon feature: bumps on ANY registry
   * change (register/dispose of tabs, viewers, or icons — one listener
   * set) so rows re-resolve their icons. Handed to the memoized rows as a
   * prop precisely so the bump reaches them.
   */
  const [iconsVersion, setIconsVersion] = useState(0)
  useEffect(
    () => service?.subscribe(() => { setIconsVersion(version => version + 1) }),
    [service],
  )
  /**
   * One directory row's leading glyph (the root row and the new-folder
   * editor use it directly; FileRow/DirRow resolve their own).
   */
  const dirRowIcon = (path: string, open: boolean): ReactNode =>
    service !== undefined ? service.folderIcon(path, open, 14) : builtinFolderIcon(open, 14)
  const dataRef = useRef(data)
  /** Every in-flight level fetch, keyed by directory (aborted on refresh/unmount). */
  const controllersRef = useRef(new Map<string, AbortController>())
  /** Bumped whenever the cache is wiped: a response from an older generation is dropped. */
  const generationRef = useRef(0)
  /** The row whose path was just copied ("copied" label replaces its button). */
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  /** Open context menu: the row path (and whether it is a directory) plus the cursor position. */
  const [rowMenu, setRowMenu] = useState<{ path: string; isDir: boolean; x: number; y: number } | null>(null)
  // The plugin submenu can tower past the viewport; publish its flip geometry
  // for layout.css while the row menu is open.
  useSubmenuFlip(rowMenu)
  /** The open-in-app rows for the open menu (null entries = listing failed). */
  const [apps, setApps] = useState<{ path: string; entries: readonly OpenInAppEntry[] | null } | null>(null)
  /** The row being renamed inline: its path plus the edit buffer. */
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  /** The inline new-folder editor: the directory it inserts into plus the buffer. */
  const [newFolder, setNewFolder] = useState<{ dir: string; value: string } | null>(null)
  /** The delete awaiting the confirmation modal's yes (single row). */
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDir: boolean; name: string } | null>(null)
  /** The batch delete awaiting the confirmation modal's yes. */
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false)
  /** True while the batch delete walks its paths (locks the dialog). */
  const [deletingSelected, setDeletingSelected] = useState(false)
  /** The last mutation failure (dismissable strip above the tree). */
  const [actionError, setActionError] = useState<string | null>(null)
  /** The multi-selection (absolute paths) and its Shift anchor. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const anchorRef = useRef<string | null>(null)
  /** Whether a dragged-over state exists at all (drives the portaled drop zone). */
  const [dropOver, setDropOver] = useState(false)
  /** The directory a drag is hovering right now (null = body, drop to root). */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /**
   * Enter/leave depth under the tree body. dragenter/dragleave fire per
   * element along the drag path (and bubble), so a counter — DSH InputBar's
   * own pattern — is the flicker-free signal; relatedTarget is unreliable
   * across engines for drag events.
   */
  const dropDepth = useRef(0)
  /** Explorer body element; its viewport rect anchors the portaled drop zone. */
  const bodyRef = useRef<HTMLDivElement>(null)
  /** The body's viewport rect captured at drag entry (null = not measured). */
  const [dropRect, setDropRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  /** Context-menu "upload here" target directory. */
  const pendingUploadDir = useRef<string | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** Reset all drag state (drop landed, the drag left, or a new drag begins). */
  const resetDrop = useCallback((): void => {
    dropDepth.current = 0
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])

  /**
   * Drop handlers: always swallow the event (a dropped file must never open
   * in the browser), then report the target directory to the caller. A drop
   * ends the drag without further leave events, so the depth resets here.
   * The payload collection is async (dropped folders are traversed through
   * their entry handles — captured synchronously inside uploadItemsFromDrop
   * while the dataTransfer is still live), so the request rides a then.
   */
  const reportDrop = useCallback((dir: string, transfer: DataTransfer | undefined): void => {
    if (propsRef.current.busy) return
    void uploadItemsFromDrop(transfer).then((items) => {
      if (items.length > 0) propsRef.current.onUploadRequest(dir, items)
    })
  }, [])
  const handleBodyDrop = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    const root = propsRef.current.cwd
    if (root !== undefined) reportDrop(root, event.dataTransfer)
  }, [reportDrop, resetDrop])
  const handleDirDrop = useCallback((event: DragEvent<HTMLDivElement>, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    resetDrop()
    reportDrop(dir, event.dataTransfer)
  }, [reportDrop, resetDrop])
  const handleBodyDragEnter = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    dropDepth.current += 1
    if (propsRef.current.busy) return
    // First entry: anchor the portaled drop zone to the body's rect.
    if (dropDepth.current === 1) {
      const rect = bodyRef.current?.getBoundingClientRect()
      setDropRect(rect === undefined ? null : { top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    }
    setDropOver(true)
  }, [])
  const handleBodyDragLeave = useCallback((): void => {
    dropDepth.current = Math.max(0, dropDepth.current - 1)
    if (dropDepth.current > 0) return
    setDropOver(false)
    setDropTarget(null)
    setDropRect(null)
  }, [])
  const handleBodyDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    // Rows stop propagation, so this only fires over non-row regions: the
    // drag targets the workspace root. dragover fires continuously, making
    // it the authoritative (flicker-free) place to clear the row target.
    setDropTarget(null)
  }, [])
  const handleRowDragOver = useCallback((event: DragEvent<HTMLDivElement>, dir: string): void => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = propsRef.current.busy ? 'none' : 'copy'
    if (propsRef.current.busy) return
    setDropTarget(dir)
  }, [])
  /** A row drop: a directory targets itself, a file its parent (VSCode semantics). */
  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>, path: string, isDir: boolean): void => {
    handleDirDrop(event, isDir ? path : parentOf(path))
  }, [handleDirDrop])

  const storeLevel = useCallback((path: string, level: LevelData) => {
    dataRef.current = { ...dataRef.current, [path]: level }
    setData(dataRef.current)
  }, [])

  /**
   * List one directory into the cache. Levels already loaded (including the
   * empty placeholder of an in-flight fetch) are left alone; a stale response
   * — the cache was wiped by a refresh tick, or a newer fetch for the same
   * directory started — is dropped instead of overwriting fresher data.
   */
  const loadDir = useCallback((dir: string) => {
    if (dataRef.current[dir] !== undefined) return
    const generation = generationRef.current
    controllersRef.current.get(dir)?.abort()
    const controller = new AbortController()
    controllersRef.current.set(dir, controller)
    storeLevel(dir, {})
    api.fsTree({ sessionId, cwd }, dir, controller.signal).then((listing) => {
      if (controller.signal.aborted || generation !== generationRef.current) return
      storeLevel(dir, { entries: listing.entries, truncated: listing.truncated })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== generationRef.current) return
      storeLevel(dir, { error: error instanceof Error ? error.message : String(error) })
    })
  }, [sessionId, cwd, storeLevel])

  /** Drop one level from the cache and reload it (the fence notice's retry,
   *  a watch notice, or a landed mutation). */
  const retryDir = useCallback((dir: string) => {
    delete dataRef.current[dir]
    setData({ ...dataRef.current })
    loadDir(dir)
  }, [loadDir])

  /**
   * Settle the tree after one rename/delete landed at `prefix`: drop every
   * cached level at or under the old path, collapse the now-stale expanded
   * directories below it, and reload the immediate parent so the new shape
   * shows without a full refresh tick.
   */
  const pruneTree = useCallback((prefix: string): void => {
    const parent = parentOf(prefix)
    const under = (key: string): boolean => key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)
    for (const key of Object.keys(dataRef.current)) {
      if (under(key)) delete dataRef.current[key]
    }
    if (parent !== prefix) delete dataRef.current[parent]
    setData({ ...dataRef.current })
    for (const dir of propsRef.current.expanded) {
      if (under(dir)) propsRef.current.onToggle(dir)
    }
    if (parent !== prefix) retryDir(parent)
  }, [retryDir])

  /** Client-side twin of the server's name rule (the server re-validates). */
  const validName = (name: string): boolean =>
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')

  /** Commit the inline rename: trim, no-op guard, then fs.rename + settle. */
  const commitRename = (path: string, raw: string): void => {
    setRenaming(null)
    const name = raw.trim()
    if (cwd === undefined || name === baseName(path) || !validName(name)) {
      if (name !== baseName(path) && !validName(name)) setActionError(t('renameInvalid'))
      return
    }
    api.fsRename({ sessionId, cwd }, path, name)
      .then((result) => {
        setActionError(null)
        pruneTree(path)
        onPathRenamed?.(path, result.path)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  // The caller's refresh tick wipes the cache (declared BEFORE the load
  // effect so the reload below sees the empty cache) and invalidates every
  // in-flight response, so a slow answer for the old generation can never
  // land on top of the fresh listing.
  const lastTick = useRef(refreshTick)
  useEffect(() => {
    if (lastTick.current === refreshTick) return
    lastTick.current = refreshTick
    generationRef.current += 1
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
    dataRef.current = {}
    setData({})
  }, [refreshTick])

  useEffect(() => {
    // Load the visible set; already-loaded levels (kept in the cache) are
    // not refetched. Only the refresh tick wipes the cache. Every level
    // starts its own fetch, so a tick reloads them all concurrently.
    const root = cwd
    if (root === undefined) return
    loadDir(root)
    for (const dir of expanded) loadDir(dir)
  }, [cwd, expanded, refreshTick, loadDir])

  // A torn-down tree must not leave requests running against an unmounted
  // component (their stores would be dropped anyway — this is lifecycle, not
  // correctness, but it keeps the network honest).
  useEffect(() => () => {
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
  }, [])

  // Live refresh: the host watches the folders this tree has expanded and
  // names the one that changed, so exactly that level is dropped and
  // re-listed instead of the whole tree. Without it a folder listed once when
  // it was opened stayed stale for the rest of the session.
  useDirectoryWatch({
    sessionId,
    root: cwd,
    dirs: expanded,
    onStale: retryDir,
  })

  // Bring a "Show in folder" reveal into view: the ancestors expand above
  // (revealPaths), but the row may not be scrolled into sight — a reveal on
  // a long tree should surface the highlighted file. Re-runs when the tree
  // data or reveal set changes (the row appears after its level loads).
  // Scrolls ONLY this tree's body: scrollIntoView would scroll every
  // scrollable ancestor, and the clipping panel host
  // ([data-dsh-panel-host]) is still programmatically scrollable — a deep
  // reveal shifted the whole panel, tab bar included, out of the viewport.
  useEffect(() => {
    if (revealed.length === 0 || propsRef.current.hidden === true) return
    const body = bodyRef.current
    if (body === null) return
    const row = body.querySelector<HTMLElement>('[data-dsh-revealed]')
    if (row === null) return
    const bodyTop = body.getBoundingClientRect().top
    const rowRect = row.getBoundingClientRect()
    const target = body.scrollTop + (rowRect.top + rowRect.height / 2) - (bodyTop + body.clientHeight / 2)
    const max = Math.max(body.scrollHeight - body.clientHeight, 0)
    body.scrollTo({ top: Math.min(Math.max(target, 0), max), behavior: 'smooth' })
  }, [revealed, data])

  /** Copy `text`; on success flip the row's copied label for a moment. */
  const copyPath = useCallback((text: string, path: string): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopiedPath(path)
      window.setTimeout(() => {
        setCopiedPath(current => current === path ? null : current)
      }, COPIED_MS)
    })
  }, [])

  // ── Multi-selection ────────────────────────────────────────────────────
  /** The selection's mirror for the stable callbacks (state itself re-renders). */
  const selectedRef = useRef(selected)
  /** Path → whether the row is a directory (the delete callback needs it). */
  const kindRef = useRef(new Map<string, boolean>())
  /** The visible rows in depth-first order: the Shift range's coordinate space. */
  const visibleRowsRef = useRef<{ path: string; isDir: boolean }[]>([])
  /** The expanded set for the stable callbacks. */
  const expandedSetRef = useRef<Set<string>>(new Set())

  const setSelection = useCallback((next: Set<string>): void => {
    selectedRef.current = next
    setSelected(next)
  }, [])

  /** Ctrl/Cmd+click: toggle one row and move the Shift anchor onto it. */
  const toggleSelect = useCallback((path: string, isDir: boolean): void => {
    const next = new Set(selectedRef.current)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      kindRef.current.set(path, isDir)
    }
    anchorRef.current = path
    setSelection(next)
  }, [setSelection])

  /** Shift+click: select the visible range between the anchor and the row. */
  const selectRange = useCallback((path: string, isDir: boolean): void => {
    const rows = visibleRowsRef.current
    const anchor = anchorRef.current
    const from = anchor === null ? -1 : rows.findIndex(row => row.path === anchor)
    const to = rows.findIndex(row => row.path === path)
    // No usable anchor (or a row that scrolled out of the tree): behave like
    // a plain Ctrl click, which also re-seats the anchor.
    if (from === -1 || to === -1) {
      toggleSelect(path, isDir)
      return
    }
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    const next = new Set(selectedRef.current)
    for (let index = low; index <= high; index += 1) {
      const row = rows[index]!
      next.add(row.path)
      kindRef.current.set(row.path, row.isDir)
    }
    // The anchor stays put: a second Shift+click re-ranges from the same start.
    setSelection(next)
  }, [setSelection, toggleSelect])

  const clearSelection = useCallback((): void => {
    if (selectedRef.current.size === 0) return
    anchorRef.current = null
    setSelection(new Set())
  }, [setSelection])

  const copySelectedPaths = useCallback((): void => {
    void writeClipboard([...selectedRef.current].join('\n'))
  }, [])

  /** Run the confirmed single-row delete: fs.remove + settle + close tabs. */
  const performDelete = (target: { path: string; isDir: boolean }): void => {
    if (cwd === undefined) return
    api.fsRemove({ sessionId, cwd }, target.path)
      .then(() => {
        setActionError(null)
        pruneTree(target.path)
        onPathDeleted?.(target.path, target.isDir)
        anchorRef.current = null
        setSelection(new Set())
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  // ── Stable row actions ─────────────────────────────────────────────────
  const handleActivate = useCallback((event: ActivateModifiers, path: string, isDir: boolean): void => {
    if (event.ctrlKey || event.metaKey) {
      toggleSelect(path, isDir)
      return
    }
    if (event.shiftKey) {
      selectRange(path, isDir)
      return
    }
    // Plain click: the original semantics, plus dropping any selection.
    clearSelection()
    if (isDir) propsRef.current.onToggle(path)
    else propsRef.current.onOpenFile(path)
  }, [clearSelection, selectRange, toggleSelect])

  const handleContextMenu = useCallback((event: MouseEvent<HTMLDivElement>, path: string, isDir: boolean): void => {
    event.preventDefault()
    event.stopPropagation()
    // VSCode semantics: right-clicking outside the selection collapses it
    // onto the row; right-clicking INSIDE it keeps the whole batch.
    if (!selectedRef.current.has(path)) {
      anchorRef.current = path
      kindRef.current.set(path, isDir)
      setSelection(new Set([path]))
    }
    setApps(null)
    setRowMenu({ path, isDir, x: event.clientX, y: event.clientY })
  }, [setSelection])

  const handleReference = useCallback((path: string, isDir: boolean): void => {
    propsRef.current.onReferenceFile(path, isDir)
  }, [])

  const actions = useMemo<RowActions>(() => ({
    activate: handleActivate,
    contextMenu: handleContextMenu,
    reference: handleReference,
    dragOver: handleRowDragOver,
    drop: handleDrop,
  }), [handleActivate, handleContextMenu, handleReference, handleRowDragOver, handleDrop])

  // ── New folder ─────────────────────────────────────────────────────────
  const newFolderRef = useRef(newFolder)
  newFolderRef.current = newFolder

  /** Open the inline editor at the TOP of `dir`'s level (expanding it first). */
  const startNewFolder = (dir: string): void => {
    const live = propsRef.current
    if (live.cwd !== undefined && dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
    setNewFolder({ dir, value: '' })
  }

  /**
   * Commit the inline new-folder name: Enter, blur, or the editor's own
   * cancel path. The ref guard makes the commit idempotent — a blur that
   * lands after Enter must not fire a second mkdir.
   */
  const commitNewFolder = (dir: string, raw: string): void => {
    if (newFolderRef.current === null) return
    newFolderRef.current = null
    setNewFolder(null)
    const name = raw.trim()
    const live = propsRef.current
    if (live.cwd === undefined) return
    if (!validName(name)) {
      setActionError(t('newFolderInvalid'))
      return
    }
    api.fsMkdir({ sessionId: live.sessionId, cwd: live.cwd }, dir, name)
      .then(() => {
        setActionError(null)
        if (dir !== live.cwd && !expandedSetRef.current.has(dir)) live.onToggle(dir)
        retryDir(dir)
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error))
      })
  }

  const cancelNewFolder = (): void => {
    newFolderRef.current = null
    setNewFolder(null)
  }

  // ── Batch delete ───────────────────────────────────────────────────────
  /**
   * Delete every selected row, ONE AT A TIME (the host refuses nothing here,
   * but a partial batch must be debuggable). The first failure stops the walk
   * and lands in the error strip; already-removed rows settle as they go.
   */
  const performBatchDelete = (): void => {
    const live = propsRef.current
    if (live.cwd === undefined || deletingSelected) return
    const paths = [...selectedRef.current]
    setConfirmDeleteSelected(false)
    if (paths.length === 0) return
    const scope = { sessionId: live.sessionId, cwd: live.cwd }
    setDeletingSelected(true)
    void (async () => {
      const removed: string[] = []
      for (const path of paths) {
        try {
          await api.fsRemove(scope, path)
        } catch (error: unknown) {
          setActionError(error instanceof Error ? error.message : String(error))
          // Keep the rows that were NOT removed selected, so a retry is one click.
          const next = new Set(selectedRef.current)
          for (const done of removed) next.delete(done)
          setSelection(next)
          setDeletingSelected(false)
          return
        }
        setActionError(null)
        pruneTree(path)
        live.onPathDeleted?.(path, kindRef.current.get(path) ?? false)
        removed.push(path)
      }
      setDeletingSelected(false)
      clearSelection()
    })()
  }

  // ── Open in app ────────────────────────────────────────────────────────
  /** Report one failed hand-off (open / reveal / app listing) in the strip. */
  const reportOpenFailure = useCallback((path: string): void => {
    setActionError(t('openInAppFailed', { path }))
  }, [])

  /**
   * Whether the host can hand paths to a native desktop — probed ONCE per
   * handle, on mount. The adapter starts in its `null` (unprobed) state, and
   * only the probe publishes the answer, so the menu reads this state instead
   * of the tri-state getter: reading `available()` alone left the whole
   * section permanently invisible (nothing ever probed).
   */
  const [appReady, setAppReady] = useState(() => openInApp?.available() === true)

  useEffect(() => {
    if (openInApp === undefined) {
      setAppReady(false)
      return
    }
    // An answer the handle already carries is authoritative; only the
    // unprobed (`null`) state needs the probe.
    const known = openInApp.available()
    if (known !== null) {
      setAppReady(known)
      return
    }
    let cancelled = false
    void openInApp.probe().then((ok) => {
      if (!cancelled) setAppReady(ok)
    }).catch(() => {
      if (!cancelled) setAppReady(false)
    })
    return () => { cancelled = true }
  }, [openInApp])

  /**
   * The open menu's app rows are fetched while the menu is open: the host
   * resolves a file's registered applications (or a directory's application
   * catalogue). A host that cannot hand paths to a desktop keeps `appReady`
   * false, so no listing is attempted.
   */
  useEffect(() => {
    if (rowMenu === null || openInApp === undefined || !appReady) {
      setApps(null)
      return
    }
    let cancelled = false
    const { path, isDir } = rowMenu
    setApps(null)
    const listing = isDir ? openInApp.directoryApps() : openInApp.fileApps(path)
    void listing.then((entries) => {
      if (cancelled) return
      setApps({ path, entries })
      if (entries === null) reportOpenFailure(path)
    }).catch(() => {
      if (cancelled) return
      setApps({ path, entries: null })
      reportOpenFailure(path)
    })
    return () => { cancelled = true }
  }, [rowMenu, openInApp, appReady, reportOpenFailure])

  const openWithApp = useCallback((path: string, application?: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    const call = application === undefined ? handle.open(path) : handle.open(path, application)
    void call.then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  const revealPath = useCallback((path: string): void => {
    const handle = propsRef.current.openInApp
    if (handle === undefined) return
    void handle.reveal(path).then((ok) => { if (!ok) reportOpenFailure(path) }).catch(() => { reportOpenFailure(path) })
  }, [reportOpenFailure])

  /** The menu label of one plugin open target: a locale key for the built-ins,
   *  the user's own name for custom editors, plus the SSH hint in remote mode. */
  const openWithLabelOf = (target: OpenWithTarget): string => {
    const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
    return openWithSsh === true && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
  }

  /**
   * The PLUGIN half of the "open with" section: the pinned targets as DIRECT
   * rows, then the parent row with every target as a nested submenu (main's
   * shape — pins, chevron, SSH suffixes). The section only renders when the
   * caller wired the feature and at least one target is left.
   *
   * `hostReady` filters out the built-in `explorer` target: the host's own
   * reveal row replaces it, and two identical "File Manager" rows would be
   * noise. When the host is NOT ready the target stays, so reveal is never
   * lost.
   */
  const openWithEntries = (hostReady: boolean): MenuEntry[] => {
    if (openWithTargets === undefined || onOpenWith === undefined) return []
    const targets = hostReady ? openWithTargets.filter(target => target.id !== 'explorer') : openWithTargets
    if (targets.length === 0) return []
    const pinnedIds = openWithPinned ?? []
    /** Brand marks for the built-ins (monochrome silhouettes, currentColor);
     *  reveal gets the folder glyph, custom editors a generic code mark.
     *  The compact menu's icon slot is 14px, so every mark renders at 14. */
    const itemIcon = (target: OpenWithTarget): ReactNode => {
      if (target.kind === 'reveal') return <VscFolderOpened size={14} />
      if (target.id === 'vscode') return <IconVscode16 size={14} />
      if (target.id === 'cursor') return <SiCursor size={14} />
      if (target.id === 'zed') return <SiZedindustries size={14} />
      return <IconCodeOutlineRegular size={14} />
    }
    const pinned = targets
      .filter(target => pinnedIds.includes(target.id))
      .map<MenuItem>(target => ({
        id: `open-with:${target.id}`,
        label: openWithLabelOf(target),
        icon: itemIcon(target),
      }))
    const submenu = targets.map<MenuItem>(target => {
      const pinnedNow = pinnedIds.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{openWithLabelOf(target)}</span>
            {/* The pushpin: a span (never a button — the Menu row itself is
                a button, so a nested interactive element would be invalid).
                Clicking it pins/unpins the target at the menu's top level
                WITHOUT selecting the row: the pin stops propagation, so the
                menu stays open and the icon flips on the next render. */}
            <span
              role="button"
              tabIndex={-1}
              className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
              aria-label={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleOpenWithPin?.(target.id)
              }}
            >
              {pinnedNow ? <VscPinned size={12} /> : <VscPin size={12} />}
            </span>
          </span>
        ),
        icon: itemIcon(target),
      }
    })
    return [
      ...pinned,
      ...(pinned.length > 0 ? [{ id: 'open-with-sep', type: 'separator' } as MenuEntry] : []),
      {
        id: 'open-with-menu',
        // The primitives Menu renders no chevron for submenu parents — the
        // trailing arrow is supplied inside the label (full-width flex row,
        // right-aligned), matching how the submenu rows right-align the pin.
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{t('openWithMenu')}</span>
            <IconChevronRightOutlineRegular size={14} className={css.openWithChevron} aria-hidden />
          </span>
        ),
        icon: <VscLinkExternal size={14} />,
        submenu,
      },
    ]
  }

  /**
   * The HOST half of the section: the default-application row (files, when the
   * OS reports one) followed by every registered handler. A pending listing
   * shows one disabled line, an empty/failed listing the disabled
   * `openInAppEmpty` line — the reveal row below still renders either way.
   */
  const hostAppEntries = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const entries = apps !== null && apps.path === target.path ? apps.entries : undefined
    if (entries === undefined) return [{ id: 'open-in-app-loading', label: t('loading'), disabled: true }]
    if (entries === null || entries.length === 0) {
      return [{ id: 'open-in-app-empty', label: t('openInAppEmpty'), disabled: true }]
    }
    const rows: MenuEntry[] = []
    const fallback = entries.find(entry => entry.isDefault)
    if (!target.isDir && fallback !== undefined) {
      rows.push({ id: 'open-in-app:default', label: t('openInAppDefault'), icon: <AppGlyph entry={fallback} /> })
    }
    for (const entry of entries) {
      if (!target.isDir && entry.isDefault) continue
      rows.push({ id: `open-in-app:${entry.id}`, label: entry.name, icon: <AppGlyph entry={entry} /> })
    }
    return rows
  }

  /**
   * The menu's "打开方式" section, where the host's capability and the plugin's
   * own targets COEXIST (the user asked for both). No heading row: the host
   * group is self-describing (application names + "用默认应用打开"), and
   * `openInApp` / `openWithMenu` read as near-duplicates in every dictionary —
   * two synonyms stacked in one menu read as a repeated item. The frozen order:
   *   host rows → separator → plugin rows (pinned direct + submenu) →
   *   separator → host reveal.
   * Separators only appear between two non-empty groups. The host rows (and
   * reveal) vanish entirely when no handle was injected or the host cannot
   * hand paths to a desktop; the plugin rows then stand alone, which is what
   * keeps a remote/SSH session usable. The plugin's `explorer` target is
   * dropped only while the host is ready (see {@link openWithEntries}).
   */
  const openWithSection = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const plugin = openWithEntries(appReady)
    if (!appReady && plugin.length === 0) return []
    const entries: MenuEntry[] = []
    const separate = (): void => {
      if (entries.length > 0) entries.push({ id: `open-with-group-${entries.length}`, type: 'separator' })
    }
    if (appReady) entries.push(...hostAppEntries(target))
    if (plugin.length > 0) {
      separate()
      entries.push(...plugin)
    }
    if (appReady) {
      separate()
      entries.push({ id: 'reveal-in-file-manager', label: t('revealInFileManager'), icon: <IconFolderOpenRegular size={14} /> })
    }
    return entries
  }

  /**
   * The selection's ZIP row: two or more selected rows archive together, and a
   * LONE directory archives its own subtree. A lone FILE is skipped — it would
   * only duplicate the plain download row.
   */
  const zipEntries = (target: { path: string; isDir: boolean }): MenuEntry[] => {
    const count = selected.size
    if (count >= 2) {
      return [{
        id: 'archive-selection',
        label: t('zipDownloadCount', { count }),
        icon: <IconArchiveOutlineRegular size={14} />,
      }]
    }
    if (count === 1 && target.isDir) {
      return [{ id: 'archive-selection', label: t('zipDownload'), icon: <IconArchiveOutlineRegular size={14} /> }]
    }
    return []
  }

  /** Download a file through the host route (raw bytes, binary-safe). */
  const downloadFile = (path: string): void => {
    const url = downloadUrl({ sessionId, cwd }, path)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  /**
   * Download one archive of `paths` through the host route. Unlike the
   * single-file download — a bare anchor whose failures belong to the browser
   * — the archive route answers the plugin's JSON error envelope for its caps
   * and refusals, and an anchor would happily save that envelope as a broken
   * `.zip`. So the bytes are fetched explicitly: a non-2xx answer is parsed for
   * its `{error: {message}}` envelope (the shape `api.ts` reads) and reported
   * through `zipFailed`; a 2xx body becomes an object URL handed to the same
   * hidden-anchor mechanics. `archiveBusyRef` keeps a double click from
   * packaging the same selection twice.
   */
  const archiveBusyRef = useRef(false)
  const downloadArchive = (paths: readonly string[]): void => {
    if (archiveBusyRef.current) return
    const name = paths.length === 1 ? `${baseName(paths[0]!)}.zip` : 'archive.zip'
    let url: string
    try {
      url = archiveUrl({ sessionId, cwd }, paths, name)
    } catch (error: unknown) {
      setActionError(t('zipFailed', { message: error instanceof Error ? error.message : String(error) }))
      return
    }
    archiveBusyRef.current = true
    void fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          const envelope: { error?: { message?: string } } | null = await response.json().catch(() => null)
          throw new Error(envelope?.error?.message ?? `HTTP ${response.status}`)
        }
        return await response.blob()
      })
      .then((blob) => {
        setActionError(null)
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = name
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        // Revoke on the next task, not synchronously: some engines have not
        // committed the download when click() returns, and revoking the URL
        // under them loses the file. One tick is enough and keeps the blob
        // from outliving the download.
        window.setTimeout(() => { URL.revokeObjectURL(objectUrl) }, 0)
      })
      .catch((error: unknown) => {
        setActionError(t('zipFailed', { message: error instanceof Error ? error.message : String(error) }))
      })
      .finally(() => { archiveBusyRef.current = false })
  }

  const root = cwd

  // Membership is tested per rendered row (deep trees run this thousands of
  // times per render): includes() made every row O(expanded), the whole tree
  // O(rows × expanded). One Set per render keeps it O(1) per row.
  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  const revealedSet = useMemo(() => new Set(revealed), [revealed])
  expandedSetRef.current = expandedSet

  /** The tree's shared git status (the changes page reads the same snapshot);
   *  a parked tab unsubscribes from the poll. */
  const gitStatus = useGitStatus({ sessionId, cwd }, { visible: visible !== false })

  // The Shift range walks the rows the user can actually see: depth-first,
  // expanded state decides. Recomputed with the level cache, never rendered.
  const visibleRows = useMemo(() => {
    const rows: { path: string; isDir: boolean }[] = []
    const walk = (dir: string): void => {
      const level = data[dir]
      if (level?.entries === undefined) return
      for (const entry of level.entries) {
        rows.push({ path: entry.path, isDir: entry.isDir })
        if (entry.isDir && expandedSet.has(entry.path)) walk(entry.path)
      }
    }
    if (root !== undefined) walk(root)
    return rows
  }, [data, expandedSet, root])
  visibleRowsRef.current = visibleRows

  /**
   * Focus + select an inline editor once, on mount. The callback identity
   * must stay STABLE (useCallback []): an inline arrow re-runs on every
   * render (detach null → attach el), and focus()/select() mid-keystroke
   * would reselect the whole buffer while typing. A plain <input>, not the
   * primitives Input — that one forwards no ref, and focus+select is the
   * entire point here.
   */
  const renameInputRef = useCallback((el: HTMLInputElement | null): void => {
    if (el !== null) {
      el.focus()
      el.select()
    }
  }, [])

  /** The inline rename editor replacing one row (dirs and files alike):
   *  same indent/icon/height for a seamless swap, Enter/blur commits,
   *  Escape cancels, IME composition keys never reach the handlers (the
   *  shared isImeComposition guard). */
  const renderRenameRow = (entry: FsEntry, depth: number): ReactNode => (
    <div
      key={entry.path}
      className={clsx(css.explorerRow, css.explorerRenaming)}
      style={{ paddingLeft: depth * 22 + 6 }}
    >
      {entry.isDir
        ? dirRowIcon(entry.path, expandedSet.has(entry.path))
        : service !== undefined ? service.fileIcon(entry.path, 14) : builtinFileIcon(entry.path, 14)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={renaming?.value ?? ''}
        aria-label={t('rename')}
        spellCheck={false}
        onChange={(event) => {
          setRenaming(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isImeComposition(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commitRename(entry.path, renaming?.value ?? '')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setRenaming(null)
          }
        }}
        onBlur={() => { commitRename(entry.path, renaming?.value ?? '') }}
      />
    </div>
  )

  /** The inline new-folder editor at the top of one level: the same
   *  interaction contract as the rename editor (Enter commits, Escape
   *  cancels, blur commits, IME guarded). */
  const renderNewFolderRow = (dir: string, depth: number): ReactNode => (
    <div className={clsx(css.explorerRow, css.explorerRenaming)} style={{ paddingLeft: depth * 22 + 6 }}>
      {dirRowIcon(dir, true)}
      <input
        ref={renameInputRef}
        className={css.explorerRenameInput}
        value={newFolder?.value ?? ''}
        placeholder={t('newFolderPlaceholder')}
        aria-label={t('newFolder')}
        spellCheck={false}
        onChange={(event) => {
          setNewFolder(prev => prev === null ? prev : { ...prev, value: event.target.value })
        }}
        onKeyDown={(event) => {
          if (isImeComposition(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commitNewFolder(dir, newFolder?.value ?? '')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancelNewFolder()
          }
        }}
        onBlur={() => { commitNewFolder(dir, newFolder?.value ?? '') }}
      />
    </div>
  )

  const renderLevel = (dir: string, depth: number): ReactNode => {
    const level = data[dir]
    const head = newFolder?.dir === dir ? renderNewFolderRow(dir, depth) : null
    if (level === undefined) {
      return (
        <>
          {head}
          <div className={css.explorerRow} style={{ paddingLeft: depth * 22 + 6 }}>{t('loading')}</div>
        </>
      )
    }
    if (level.error !== undefined) {
      // The fence refusal becomes the friendly notice (reason + one-click
      // global off + immediate retry of this directory), never the raw
      // `path "..." is outside workspace` wire text.
      return (
        <>
          {head}
          {isOutsideWorkspaceMessage(level.error)
            ? (
              <div style={{ paddingLeft: depth * 22 + 6 }}>
                <FenceErrorNotice store={store} onDisabled={() => { retryDir(dir) }} />
              </div>
            )
            : (
              <div className={clsx(css.explorerRow, css.explorerError)} style={{ paddingLeft: depth * 22 + 6 }}>
                {level.error}
              </div>
            )}
        </>
      )
    }
    const entries = level.entries ?? []
    return (
      <>
        {head}
        {entries.map((entry) => {
          // The row being renamed renders as its editor (no button semantics:
          // an editor is not a click target — and a nested interactive inside
          // role="button" would be invalid anyway).
          if (renaming?.path === entry.path) return renderRenameRow(entry, depth)
          if (entry.isDir) {
            const isOpen = expandedSet.has(entry.path)
            return (
              <div key={entry.path}>
                <DirRow
                  entry={entry}
                  depth={depth}
                  expanded={isOpen}
                  iconsVersion={iconsVersion}
                  service={service}
                  selected={selected.has(entry.path)}
                  revealed={revealedSet.has(entry.path)}
                  dropTarget={dropTarget === entry.path}
                  gitChanged={gitStatus.dirHasChanges(entry.path)}
                  copied={copiedPath === entry.path}
                  actions={actions}
                />
                {isOpen && renderLevel(entry.path, depth + 1)}
              </div>
            )
          }
          return (
            <FileRow
              key={entry.path}
              entry={entry}
              depth={depth}
              iconsVersion={iconsVersion}
              service={service}
              selected={selected.has(entry.path)}
              revealed={revealedSet.has(entry.path)}
              dropTarget={dropTarget === parentOf(entry.path)}
              git={gitStatus.statusOf(entry.path)}
              copied={copiedPath === entry.path}
              actions={actions}
            />
          )
        })}
        {/* The host capped this directory's listing: say so instead of
            silently showing a partial tree. */}
        {level.truncated === true && <Notice kind="hint">{t('filesTruncated')}</Notice>}
      </>
    )
  }

  return (
    <div
      ref={bodyRef}
      className={clsx(css.explorerBody, hidden === true && css.explorerHiddenPane)}
      hidden={hidden}
      onDragEnter={handleBodyDragEnter}
      onDragOver={handleBodyDragOver}
      onDragLeave={handleBodyDragLeave}
      onDrop={handleBodyDrop}
      onClick={(event) => {
        // A click on the body itself (below the last row) drops the selection.
        if (event.target === event.currentTarget) clearSelection()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') clearSelection()
      }}
    >
      {root === undefined ? (
        <div className={css.explorerEmpty}>{t('noSession')}</div>
      ) : (
        <>
          {/* The last mutation failure (rename/delete/mkdir/open-in-app):
              dismissable, raw server text — the same show-the-truth policy the
              fence notice uses. Any later action or a fresh attempt clears it. */}
          {actionError !== null && (
            <div className={css.explorerActionError} role="alert">
              <span className={css.explorerActionErrorText}>{actionError}</span>
              <IconButton
                size="sm"
                label={t('dismiss')}
                icon={<IconCloseFillRegular size={14} />}
                onClick={() => { setActionError(null) }}
              />
            </div>
          )}
          {selected.size > 0 && (
            <SectionHeader
              className={css.explorerSelectionBar}
              label={t('filesSelected', { count: selected.size })}
              action={(
                <span className={css.explorerSelectionActions}>
                  <Chip onClick={copySelectedPaths}>{t('copyPaths')}</Chip>
                  <Chip onClick={() => { setConfirmDeleteSelected(true) }}>{t('deleteSelected')}</Chip>
                  <Chip onClick={clearSelection}>{t('clearSelection')}</Chip>
                </span>
              )}
            />
          )}
          <div
            className={clsx(css.explorerRow, dropTarget === root && css.explorerRowDropTarget)}
            style={{ paddingLeft: 6 }}
            onDragOver={(event) => { handleRowDragOver(event, root) }}
            onDrop={(event) => { handleDirDrop(event, root) }}
            onContextMenu={(event) => { handleContextMenu(event, root, true) }}
          >
            {dirRowIcon(root, true)}
            <span className={clsx(css.explorerName, gitStatus.dirHasChanges(root) && css.explorerDirChanged)}>
              {baseName(root)}
            </span>
            {copiedPath === root
              ? <span className={css.explorerCopied}>{t('copied')}</span>
              : (
                <button
                  type="button"
                  className={css.explorerRef}
                  aria-label={t('referenceFile')}
                  title={t('referenceFile')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReferenceFile(root, true)
                  }}
                >
                  {t('referenceFile')}
                </button>
              )}
          </div>
          {renderLevel(root, 1)}
        </>
      )}
      {dropOver && dropRect !== null && createPortal(
        /*
         * The sidebar's drop surface, portaled to document.body at z-1001+ —
         * above DSH's own whole-page drop mask (z-1000, see InputBar's
         * document-level intake) so the two never compete. A LIGHT mask dims
         * the viewport: the dimmed conversation column still takes drops into
         * the chat natively (this layer is pointer-inert), while the dashed
         * frame marks the tree as the workspace-upload zone. Deliberate
         * exception to the "panel stays below the DSH float stack" rule:
         * transient, and the drop always lands on the element beneath. The
         * hint pill docks at the TOP edge of the zone — right under the
         * search row, the first thing the eye meets — keeping the rows
         * aimable.
         */
        <>
          <div className={css.uploadDropMask} />
          <div
            className={css.uploadDropZone}
            style={{
              top: dropRect.top + 2,
              left: dropRect.left + 2,
              width: dropRect.width - 4,
              height: dropRect.height - 4,
            }}
          >
            <div className={css.uploadDropHero}>
              <UploadDropIllustration />
              <div className={css.uploadDropZonePill}>
                <IconUploadOutline16 size={14} />
                <span className={css.uploadDropZoneText}>
                  {dropTarget !== null ? t('uploadTo', { dir: dropTarget }) : t('uploadDropHint')}
                </span>
              </div>
            </div>
          </div>
          {/* The left zone's invitation, centered in the space beside the
              tree; skipped when that space is too narrow to hold it. */}
          {dropRect.left >= 200 && (
            <div className={css.uploadDropChatHint} style={{ width: dropRect.left }}>
              <div className={css.uploadDropChatCard}>
                <ChatDropIllustration />
                <span>{t('uploadDropChat')}</span>
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
      {/*
        The one shared context menu, positioned at the right-click cursor
        (portal so the tree's overflow clip cannot crop it).
      */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => {
          const dir = pendingUploadDir.current ?? root
          pendingUploadDir.current = undefined
          if (dir !== undefined && !busy) onUploadRequest(dir, uploadItemsFromFiles(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Menu
        open={rowMenu !== null}
        onClose={() => { setRowMenu(null) }}
        items={[
          // The open escapes head the FILE menu (dirs only get copy).
          ...(rowMenu?.isDir === false && onOpenFileNewTab !== undefined
            ? [{ id: 'open-new-tab', label: t('openFileNewTab'), icon: <IconCodeOutlineRegular size={14} /> }]
            : []),
          ...(rowMenu?.isDir === false && onOpenFileSide !== undefined
            ? [{ id: 'open-side', label: t('openFileSide'), icon: <IconFolderOpenRegular size={14} /> }]
            : []),
          ...(rowMenu === null ? [] : openWithSection(rowMenu)),
          // Download applies to files only (the host route refuses directories).
          ...(rowMenu?.isDir === false
            ? [{ id: 'download', label: t('download'), icon: <IconDownloadOutlineRegular size={14} /> }]
            : []),
          // Upload into a directory (incl. the workspace root row).
          ...(rowMenu?.isDir === true
            ? [{ id: 'upload-here', label: t('uploadHere'), icon: <IconUploadOutline16 size={14} /> }]
            : []),
          // New folder into a directory (incl. the workspace root row).
          ...(rowMenu?.isDir === true
            ? [{ id: 'new-folder', label: t('newFolder'), icon: <IconPlusOutlineRegular size={14} /> }]
            : []),
          // ZIP of the current selection (≥2 rows, or one lone directory).
          ...(rowMenu === null ? [] : zipEntries(rowMenu)),
          { id: 'relative', label: t('copyRelative'), icon: <IconCopyOutlineRegular size={14} /> },
          { id: 'absolute', label: t('copyAbsolute'), icon: <IconCopyOutlineRegular size={14} /> },
          // Explorer mutations close the menu; the workspace ROOT row is the
          // session itself — never renamable or deletable (server double-guards).
          ...(rowMenu !== null && rowMenu.path !== cwd
            ? [
                { id: 'mutate-sep', type: 'separator' } as MenuEntry,
                { id: 'rename', label: t('rename'), icon: <IconEditOutlineRegular size={14} /> },
                { id: 'delete', label: t('delete'), icon: <IconTrashOutlineRegular size={14} />, danger: true },
              ]
            : []),
        ]}
        onSelect={(id) => {
          const target = rowMenu
          if (target === null) return
          setRowMenu(null)
          if (id === 'open-new-tab') {
            onOpenFileNewTab?.(target.path)
            return
          }
          if (id === 'open-side') {
            onOpenFileSide?.(target.path)
            return
          }
          if (id === 'open-in-app:default') {
            openWithApp(target.path)
            return
          }
          if (id.startsWith('open-in-app:')) {
            openWithApp(target.path, id.slice('open-in-app:'.length))
            return
          }
          // The plugin's own targets share one id space (pinned rows and
          // submenu children alike), so the caller gets the target id + path.
          if (id.startsWith('open-with:')) {
            onOpenWith?.(id.slice('open-with:'.length), target.path)
            return
          }
          if (id === 'reveal-in-file-manager') {
            revealPath(target.path)
            return
          }
          if (id === 'archive-selection') {
            downloadArchive([...selected])
            return
          }
          if (id === 'download') {
            downloadFile(target.path)
            return
          }
          if (id === 'upload-here') {
            pendingUploadDir.current = target.path
            fileInputRef.current?.click()
            return
          }
          if (id === 'new-folder') {
            startNewFolder(target.path)
            return
          }          if (id === 'rename') {
            setRenaming({ path: target.path, value: baseName(target.path) })
            return
          }
          if (id === 'delete') {
            setConfirmDelete({ path: target.path, isDir: target.isDir, name: baseName(target.path) })
            return
          }
          copyPath(
            id === 'relative' ? relativeTo(cwd ?? '', target.path) : target.path,
            target.path,
          )
        }}
        portal
        compact
        align="start"
        getAnchorRect={() => (rowMenu === null ? null : new DOMRect(rowMenu.x, rowMenu.y, 0, 0))}
        anchor={<span />}
      />

      {/* The single-row delete confirmation: destructive and permanent (no host
          trash), so it always lands here first — the shared kit dialog, the
          same shape the git lens uses for discard/revert/cherry-pick. */}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={confirmDelete === null ? '' : t('deleteTitle', { name: confirmDelete.name })}
        description={confirmDelete === null ? '' : t(confirmDelete.isDir ? 'deleteDescDir' : 'deleteDescFile')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        danger
        onConfirm={() => {
          const pending = confirmDelete
          if (pending === null) return
          setConfirmDelete(null)
          performDelete(pending)
        }}
        onClose={() => { setConfirmDelete(null) }}
      />

      {/* The batch delete: one confirmation for the whole selection, then one
          sequential fs.remove per row (the first failure stops the walk). */}
      <ConfirmDialog
        open={confirmDeleteSelected}
        title={t('deleteSelectedTitle', { count: selected.size })}
        description={t('deleteSelectedDesc')}
        confirmLabel={t('deleteSelected')}
        cancelLabel={t('cancel')}
        danger
        busy={deletingSelected}
        onConfirm={performBatchDelete}
        onClose={() => { setConfirmDeleteSelected(false) }}
      />
    </div>
  )
}

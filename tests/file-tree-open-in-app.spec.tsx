/**
 * FileTree "open in app" menu (the host's own capability, replacing the
 * plugin's removed open-with chain): a file row lists the host's registered
 * applications — the default-application row first, then one row per app —
 * followed by reveal-in-file-manager; a directory row lists the host's
 * application catalogue plus reveal. Clicking a row hands the absolute path
 * (plus the application id when one was chosen) to the injected handle, a
 * listing that yields nothing degrades to one DISABLED row, a host that
 * cannot open desktop paths hides the whole section, and a failure lands in
 * the tree's error strip.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createOpenInApp, type OpenInApp, type OpenInAppEntry } from '../src/client/open-in-app.ts'
import type { OpenWithTarget } from '../src/client/open-with.ts'
import { createSidebarStore } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      path: '/tmp',
      entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      ],
      truncated: false,
    }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the open-in-app section).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  isOutsideWorkspaceMessage: () => false,
}))

/** What the host reports for a file (the default entry first). */
const FILE_APPS: readonly OpenInAppEntry[] = [
  { id: 'textedit', name: 'TextEdit', icon: null, isDefault: true },
  { id: 'vscode', name: 'VS Code', icon: 'data:image/svg+xml,%3Csvg/%3E', isDefault: false },
]

/** What the host reports for a directory (no default concept). */
const DIRECTORY_APPS: readonly OpenInAppEntry[] = [
  { id: 'vscode', name: 'VS Code', icon: null, isDefault: false },
  { id: 'finder', name: 'Finder', icon: null, isDefault: false },
]

interface Handle {
  openInApp: OpenInApp
  open: ReturnType<typeof vi.fn>
  reveal: ReturnType<typeof vi.fn>
  fileApps: ReturnType<typeof vi.fn>
  directoryApps: ReturnType<typeof vi.fn>
}

function makeHandle(overrides: Partial<OpenInApp> = {}): Handle {
  const open = vi.fn(async () => true)
  const reveal = vi.fn(async () => true)
  const fileApps = vi.fn(async () => FILE_APPS)
  const directoryApps = vi.fn(async () => DIRECTORY_APPS)
  const openInApp: OpenInApp = {
    available: () => true,
    probe: async () => true,
    directoryApps,
    fileApps,
    open,
    reveal,
    ...overrides,
  }
  return { openInApp, open, reveal, fileApps, directoryApps }
}

interface Harness {
  container: HTMLDivElement
  onOpenWith: ReturnType<typeof vi.fn>
  onToggleOpenWithPin: ReturnType<typeof vi.fn>
  unmount: () => void
}

/** The plugin targets a caller (EditorHost) may hand FileTree alongside the
 *  host handle; names are distinct from FILE_APPS so assertions are exact. */
const PLUGIN_TARGETS: OpenWithTarget[] = [
  { id: 'explorer', nameKey: 'openWithExplorer', name: '', kind: 'reveal', isVscodeFamily: false, localOnly: true },
  { id: 'custom:w', name: 'Windsurf', kind: 'url', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false, localOnly: false },
]

async function mountTree(handle?: Handle, plugin: {
  targets?: OpenWithTarget[]
  pinned?: string[]
  ssh?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onOpenWith = vi.fn()
  const onToggleOpenWithPin = vi.fn()
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      ...(handle !== undefined ? { openInApp: handle.openInApp } : {}),
      ...(plugin.targets !== undefined ? {
        openWithTargets: plugin.targets,
        openWithPinned: plugin.pinned ?? [],
        openWithSsh: plugin.ssh ?? false,
        onOpenWith,
        onToggleOpenWithPin,
      } : {}),
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    // Settle the async app listing / availability probe the menu triggers.
    await Promise.resolve()
    await Promise.resolve()
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The row whose label text matches (rows are role="button" divs). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

/** Open one row's context menu and settle the async app listing. */
async function openMenu(container: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    rowByName(container, name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function menuLabels(): string[] {
  return menuItems().map(item => item.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = menuItems().find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

let harness: Harness
afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
})

describe('FileTree open-in-app menu', () => {
  it('lists the default application, the registered apps and reveal for a file row', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).toHaveBeenCalledWith('/tmp/a.ts')
    // No heading row any more: the host group is read from the application
    // names themselves (`openInApp` and `openWithMenu` are near-synonyms, so
    // two labels in one menu read as a repeated item). A data label entry is
    // a LEAF `role="presentation"` row inside the menu.
    const menu = document.querySelector('[role="menuitem"]')!.closest('[role="menu"]')
    expect([...(menu?.querySelectorAll('[role="presentation"]') ?? [])]
      .filter(row => row.children.length === 0)).toEqual([])
    expect(menuLabels()).toContain('Open with default app')
    expect(menuLabels()).toContain('VS Code')
    expect(menuLabels()).toContain('Reveal in File Manager')
    // The default row's glyph is the default app's own icon slot.
    expect(menuItems().some(item => item.querySelector('img[class*="explorerAppIcon"]') !== null)).toBe(true)
  })

  it('hands the path (and the chosen application id) to the open handle', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    clickMenuitem('Open with default app')
    expect(handle.open).toHaveBeenCalledWith('/tmp/a.ts')
    // Selecting closes the menu entirely.
    expect(menuItems()).toHaveLength(0)
    await openMenu(harness.container, 'a.ts')
    clickMenuitem('VS Code')
    expect(handle.open).toHaveBeenCalledWith('/tmp/a.ts', 'vscode')
    await openMenu(harness.container, 'a.ts')
    clickMenuitem('Reveal in File Manager')
    expect(handle.reveal).toHaveBeenCalledWith('/tmp/a.ts')
  })

  it('lists the host catalogue for a directory row, with no default row', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle)
    await openMenu(harness.container, 'sub')
    expect(handle.directoryApps).toHaveBeenCalled()
    expect(handle.fileApps).not.toHaveBeenCalled()
    expect(menuLabels()).not.toContain('Open with default app')
    expect(menuLabels()).toEqual(expect.arrayContaining(['VS Code', 'Finder', 'Reveal in File Manager']))
    clickMenuitem('Finder')
    expect(handle.open).toHaveBeenCalledWith('/tmp/sub', 'finder')
  })

  it('degrades to one DISABLED row when the host knows no application', async () => {
    const handle = makeHandle({ fileApps: async () => [] })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    const empty = menuItems().find(item => item.textContent === 'No application can open it')
    expect(empty).toBeDefined()
    expect((empty as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a failed hand-off in the error strip', async () => {
    const handle = makeHandle({ fileApps: async () => null })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('reports a hand-off the host refused (open resolving false)', async () => {
    const handle = makeHandle()
    handle.open.mockResolvedValue(false)
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    await act(async () => { clickMenuitem('VS Code'); await Promise.resolve(); await Promise.resolve() })
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Could not open: /tmp/a.ts')
  })

  it('hides the whole section when the host cannot open desktop paths', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle)
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).not.toHaveBeenCalled()
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    expect(document.body.textContent).not.toContain('Open with')
  })

  it('hides the section when no handle was injected at all', async () => {
    harness = await mountTree()
    await openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    expect(document.body.textContent).not.toContain('Open with')
  })

  it('probes the tri-state handle before deciding the section is unavailable', async () => {
    // The REAL adapter starts with `available() === null` and only publishes
    // an answer when `probe()` runs: a tree that reads the getter without
    // probing would hide the section forever. This case pins that lifecycle
    // with a handle that mimics it exactly.
    let probed = false
    let probes = 0
    const handle = makeHandle({
      available: () => (probed ? true : null),
      probe: async () => { probed = true; probes += 1; return true },
    })
    harness = await mountTree(handle)
    expect(handle.fileApps).not.toHaveBeenCalled()
    await openMenu(harness.container, 'a.ts')
    expect(handle.fileApps).toHaveBeenCalledWith('/tmp/a.ts')
    expect(menuLabels()).toContain('Open with default app')
    expect(menuLabels()).toContain('VS Code')
    expect(probes).toBe(1)
  })

  it('drives the real host adapter end to end: probe, list, open, reveal', async () => {
    // No hand-written handle here — the production adapter over a fake Host
    // Remote, so the wiring (probe → fileApps → open/reveal) cannot drift.
    const calls = { canOpen: 0, applications: [] as string[], open: [] as { path: string; application?: string }[] }
    const openInApp = createOpenInApp({
      get: (name) => name !== 'remote' ? undefined : {
        session: {
          canOpenWorkspacePath: async () => { calls.canOpen += 1; return { ok: true, value: true } },
          workspacePathApplications: async (request: { path: string }) => {
            calls.applications.push(request.path)
            return { ok: true, value: [{ id: 'textedit', name: 'TextEdit', default: true, icon: null }] }
          },
          openWorkspacePath: async (request: { path: string; application?: string }) => {
            calls.open.push({ path: request.path, ...(request.application !== undefined ? { application: request.application } : {}) })
            return { ok: true }
          },
        },
      },
    })
    expect(openInApp.available()).toBeNull()
    harness = await mountTree({ openInApp } as Handle)
    await openMenu(harness.container, 'a.ts')
    expect(calls.canOpen).toBe(1)
    expect(calls.applications).toEqual(['/tmp/a.ts'])
    expect(menuLabels()).toContain('Open with default app')
    await act(async () => { clickMenuitem('Open with default app'); await Promise.resolve() })
    expect(calls.open).toEqual([{ path: '/tmp/a.ts' }])
  })
})

describe('FileTree open-in-app + plugin open-with coexistence', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  /** The label rows of the single open menu, in DOM order. */
  function labelsOf(items: string[]): number[] {
    const labels = menuLabels()
    return items.map(item => labels.indexOf(item))
  }

  it('stacks the host rows above the plugin rows and ends with the host reveal', async () => {
    const handle = makeHandle()
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, pinned: ['custom:w'] })
    await openMenu(harness.container, 'a.ts')
    const [hostDefault, hostApp, pinnedPlugin, submenu, reveal] = labelsOf([
      'Open with default app', 'VS Code', 'Windsurf', 'Open with', 'Reveal in File Manager',
    ])
    // Every row exists, in the frozen order: host group → plugin group →
    // reveal.
    expect([hostDefault, hostApp, pinnedPlugin, submenu, reveal]).not.toContain(-1)
    expect(hostDefault!).toBeLessThan(hostApp!)
    expect(hostApp!).toBeLessThan(pinnedPlugin!)
    expect(pinnedPlugin!).toBeLessThan(submenu!)
    expect(submenu!).toBeLessThan(reveal!)
    // The plugin's `explorer` target is replaced by the host reveal row.
    expect(menuLabels()).not.toContain('File Manager')
    // Separator rows between each group.
    expect(document.querySelectorAll('[role="separator"]').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the plugin rows — explorer included — when the host cannot open desktop paths', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, pinned: ['custom:w'] })
    await openMenu(harness.container, 'a.ts')
    // No host rows at all…
    expect(menuLabels()).not.toContain('Open with default app')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    // …but the plugin's own reveal target survives, so reveal is never lost.
    expect(menuLabels()).toContain('Windsurf')
    const parent = menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')!
    act(() => { parent.click() })
    expect([...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .map(item => item.textContent?.trim())).toEqual(['File Manager', 'Windsurf'])
  })

  it('keeps the plugin rows when no host handle was injected at all', async () => {
    harness = await mountTree(undefined, { targets: PLUGIN_TARGETS, pinned: [] })
    await openMenu(harness.container, 'a.ts')
    expect(menuLabels()).not.toContain('Reveal in File Manager')
    expect(menuLabels()).toContain('Open with')
  })

  it('hands the plugin target id and path to onOpenWith (SSH suffix intact)', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, pinned: [], ssh: true })
    await openMenu(harness.container, 'a.ts')
    const parent = menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')!
    act(() => { parent.click() })
    const windsurf = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.trim() === 'Windsurf (SSH)')!
    act(() => { windsurf.click() })
    expect(harness.onOpenWith).toHaveBeenCalledWith('custom:w', '/tmp/a.ts')
  })

  it('routes a pin click to onToggleOpenWithPin without selecting a row', async () => {
    const handle = makeHandle({ available: () => false })
    harness = await mountTree(handle, { targets: PLUGIN_TARGETS, pinned: [] })
    await openMenu(harness.container, 'a.ts')
    act(() => { menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')!.click() })
    const pin = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.trim() === 'Windsurf')!
      .querySelector<HTMLElement>('[class*="openWithPin"]')!
    act(() => { pin.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(harness.onToggleOpenWithPin).toHaveBeenCalledWith('custom:w')
    expect(harness.onOpenWith).not.toHaveBeenCalled()
  })
})

/**
 * FileTree's PLUGIN open-with menu (restored in round two, and coexisting with
 * the host's open-in-app rows — the coexistence cases live in
 * file-tree-open-in-app.spec.tsx). With no host handle injected, the "打开方式"
 * section is the plugin's own: the pinned targets as direct rows, the
 * `openWithMenu` parent row with every target as a nested submenu (per-row
 * pushpins that toggle without selecting the row), SSH suffixes in remote
 * mode, and the reveal target kept (nothing else can reveal without the host).
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
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
    // every row plain.
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  archiveUrl: () => '/sidebar/archive',
  isOutsideWorkspaceMessage: () => false,
}))

/** The resolved target list a caller (EditorHost) would hand FileTree. */
const targets: OpenWithTarget[] = [
  { id: 'explorer', nameKey: 'openWithExplorer', name: '', kind: 'reveal', isVscodeFamily: false, localOnly: true },
  { id: 'vscode', nameKey: 'openWithVscode', name: '', kind: 'url', urlTemplate: 'vscode://file/{path}', isVscodeFamily: true, localOnly: false },
  { id: 'cursor', nameKey: 'openWithCursor', name: '', kind: 'url', urlTemplate: 'cursor://file/{path}', isVscodeFamily: true, localOnly: false },
  { id: 'zed', nameKey: 'openWithZed', name: '', kind: 'url', urlTemplate: 'zed://file/{path}', isVscodeFamily: false, localOnly: true },
  { id: 'custom:w', name: 'Windsurf', kind: 'url', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false, localOnly: false },
]

interface Harness {
  container: HTMLDivElement
  onOpenWith: ReturnType<typeof vi.fn>
  onToggleOpenWithPin: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(overrides: {
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onOpenWith = vi.fn()
  const onToggleOpenWithPin = vi.fn()
  // Property-presence semantics: an explicit `openWithTargets: undefined`
  // must reach FileTree (the section hides) instead of falling back.
  const has = (key: 'openWithTargets' | 'openWithPinned' | 'openWithSsh'): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, key)
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
      openWithTargets: has('openWithTargets') ? overrides.openWithTargets : targets,
      openWithPinned: has('openWithPinned') ? overrides.openWithPinned : ['vscode'],
      openWithSsh: has('openWithSsh') ? overrides.openWithSsh : false,
      onOpenWith,
      onToggleOpenWithPin,
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** The file row of the one-level tree. */
function fileRow(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
  if (row === undefined) throw new Error('file row not found')
  return row
}

/** Open the row's context menu at a fixed cursor position. */
function openMenu(container: HTMLDivElement): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { fileRow(container).dispatchEvent(event) })
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function submenuRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
}

function submenuParent(): HTMLElement {
  const parent = menuItems().find(item => item.getAttribute('aria-haspopup') === 'menu')
  if (parent === undefined) throw new Error('submenu parent not found')
  return parent
}

describe('FileTree plugin open-with menu', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute('data-dsh-sidebar-submenu')
  })

  it('renders the pinned direct row and the submenu parent for a file row', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    // The pinned VS Code sits at the top level (before the submenu parent).
    expect(menuItems().map(item => item.textContent?.trim())).toContain('VS Code')
    const parent = submenuParent()
    expect(parent.textContent).toContain('Open with')
    // The submenu parent carries the trailing chevron affordance (the
    // primitives Menu renders no arrow of its own), right-aligned inside a
    // full-width label row — the same structure the submenu children use.
    expect(parent.querySelector('[class*="openWithChevron"]')).not.toBeNull()
    expect(parent.querySelector('[class*="openWithLabel"]')).not.toBeNull()
  })

  it('opens the submenu on click and lists every target with pin toggles', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    expect(submenuRows().map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code', 'Cursor', 'Zed', 'Windsurf',
    ])
    expect(submenuRows().every(item => item.querySelector('[class*="openWithPin"]') !== null)).toBe(true)
    // Pinned state is carried per row by the pin's TITLE (it swaps the glyph
    // and the hover hint).
    const vscodeRow = submenuRows().find(item => item.textContent?.trim() === 'VS Code')
    const cursorRow = submenuRows().find(item => item.textContent?.trim() === 'Cursor')
    expect(vscodeRow?.querySelector('[title="Unpin"]')).not.toBeNull()
    expect(cursorRow?.querySelector('[title="Pin to menu"]')).not.toBeNull()
  })

  it('keeps the pin a mouse hot zone, never a fake nested control', async () => {
    // The Menu renders each row as `<button role="menuitem">`, so ANY
    // role=button/tabIndex on the pin would be invalid nesting AND
    // unreachable by keyboard (the row button owns focus). It is deliberately
    // a plain span: the pin's nameable affordance is its `title`, and the
    // reachable path to the same pinned list is the settings panel.
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const vscodePin = submenuRows().find(item => item.textContent?.trim() === 'VS Code')!
      .querySelector<HTMLElement>('[class*="openWithPin"]')!
    expect(vscodePin.tagName).toBe('SPAN')
    expect(vscodePin.getAttribute('role')).toBeNull()
    expect(vscodePin.hasAttribute('tabindex')).toBe(false)
    expect(vscodePin.getAttribute('title')).toBe('Unpin')
    // The row itself stays the only interactive element of the entry.
    expect(vscodePin.closest('[role="menuitem"]')?.tagName).toBe('BUTTON')
  })

  it('pin click toggles without selecting the row or closing the menu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const cursorRow = submenuRows().find(item => item.textContent?.trim() === 'Cursor')!
    const pin = cursorRow.querySelector<HTMLElement>('[class*="openWithPin"]')
    expect(pin).not.toBeNull()
    act(() => { pin!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(harness.onToggleOpenWithPin).toHaveBeenCalledWith('cursor')
    expect(harness.onOpenWith).not.toHaveBeenCalled()
    // The menu (and the submenu) stayed open.
    expect(document.querySelector('[role="menu"] [role="menu"]')).not.toBeNull()
  })

  it('selecting a submenu child invokes onOpenWith with the row path and closes the menu', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    act(() => { zedRow.click() })
    expect(harness.onOpenWith).toHaveBeenCalledWith('zed', '/tmp/a.ts')
    // Selecting closes the row menu entirely.
    expect(document.querySelector('[role="menu"] [role="menu"]')).toBeNull()
    expect(menuItems()).toHaveLength(0)
  })

  it('appends the SSH hint to VSCode-family labels in remote mode (reveal stays)', async () => {
    // The SSH-resolved list keeps `explorer` (see resolveOpenWithTargets):
    // reveal runs on the machine that owns the workspace, and it is the only
    // reveal left when the DSH host's open-in-app capability is unavailable.
    // Dropping it here would test a list the caller never produces.
    harness = await mountTree({
      openWithSsh: true,
      openWithTargets: targets.filter(target => !target.localOnly || target.kind === 'reveal'),
      openWithPinned: [],
    })
    openMenu(harness.container)
    act(() => { submenuParent().click() })
    expect(submenuRows().map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code (SSH)', 'Cursor (SSH)', 'Windsurf (SSH)',
    ])
  })

  it('hides the plugin section when the caller wires no targets', async () => {
    harness = await mountTree({ openWithTargets: undefined })
    openMenu(harness.container)
    expect(menuItems().some(item => item.textContent?.includes('Open with'))).toBe(false)
    expect(menuItems().some(item => item.getAttribute('aria-haspopup') === 'menu')).toBe(false)
  })
})

describe('FileTree plugin open-with menu flip geometry (submenu clamping)', () => {
  const ATTR = 'data-dsh-sidebar-submenu'

  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
    document.body.removeAttribute(ATTR)
  })

  it('publishes "down" for a top-of-tree opening and clears on selection', async () => {
    harness = await mountTree()
    // openMenu() right-clicks at (20, 30) — the upper half, plenty of right
    // room in jsdom's default viewport.
    openMenu(harness.container)
    expect(document.body.getAttribute(ATTR)).toBe('down')
    act(() => { submenuParent().click() })
    const zedRow = submenuRows().find(item => item.textContent?.trim() === 'Zed')!
    act(() => { zedRow.click() })
    expect(menuItems()).toHaveLength(0)
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })

  it('adds "left" when the cursor sits within the right-hand submenu room', async () => {
    harness = await mountTree()
    const nearRight = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: window.innerWidth - 10, clientY: 30 })
    act(() => { fileRow(harness.container).dispatchEvent(nearRight) })
    expect(document.body.getAttribute(ATTR)).toBe('down left')
  })

  it('clears the attribute on unmount with the menu still open', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    expect(document.body.getAttribute(ATTR)).toBe('down')
    harness.unmount()
    expect(document.body.hasAttribute(ATTR)).toBe(false)
  })
})

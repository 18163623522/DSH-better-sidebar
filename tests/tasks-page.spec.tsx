/**
 * Tasks page interaction tests (jsdom): the jobs drawer's auto-collapse at
 * the agent-count threshold, the graph/tree view toggle visible in BOTH
 * modes, node click → transcript jump, ⓘ → anchored popover, and the
 * settled-leaf fold aggregate expanding on click.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot } from './test-utils.ts'
import { SubagentView } from '../src/client/SubagentView.tsx'
import type {
  Context,
  SidebarSessionList,
  SidebarSessionSummary,
  SidebarSubagentCatalog,
} from '../src/context-types.ts'

/** A subscribable sessions-list snapshot (mirror of the runtime list feed). */
function makeStore(initial: SidebarSessionList) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next: SidebarSessionList) {
      snapshot = next
      for (const fn of [...listeners]) fn()
    },
  }
}

type Store = ReturnType<typeof makeStore>

/** The client context face SubagentView touches. */
function makeCtx(store: Store, spies: { openSubagent?: (address: unknown) => void } = {}): Context {
  return {
    sessions: {
      list: store,
      setSubagentCatalogOpen: () => {},
      openSubagent: spies.openSubagent ?? (() => {}),
      open: () => {},
      refreshSubagents: async () => {},
    },
  } as unknown as Context
}

function jsonResponse(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as unknown as Response
}

let teamPayload: unknown = { available: false }
const teamMutations: Array<{ method: string; body: Record<string, unknown> }> = []
const fetchedMethods: string[] = []

beforeEach(() => {
  teamPayload = { available: false }
  teamMutations.length = 0
  fetchedMethods.length = 0
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()
    fetchedMethods.push(method ?? '')
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    if (method === 'subagents.live') return jsonResponse({ ok: true, value: { live: {} } })
    if (method === 'workflows.list') return jsonResponse({ ok: true, value: { runs: [] } })
    if (method === 'teams.view') return jsonResponse({ ok: true, value: teamPayload })
    if (method === 'teams.taskCreate' || method === 'teams.taskUpdate') {
      teamMutations.push({ method: method ?? '', body })
      return jsonResponse({
        ok: true,
        value: {
          ok: true,
          value: {
            id: 't9', revision: 9, subject: body.subject ?? 'x', description: body.description ?? '',
            status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
          },
        },
      })
    }
    if (method === 'jobs.output') return jsonResponse({ ok: true, value: { text: 'out', truncated: false, read: true } })
    throw new Error(`unexpected fetch ${String(url)}`)
  })
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

/** A snapshot with N direct children of root (all settled one-shots). */
function snapshotWithChildren(count: number): SidebarSessionList {
  const byId: Record<string, SidebarSessionSummary> = {
    root: { id: 'root', displayTitle: '主会话', running: true },
  }
  const entries: SidebarSubagentCatalog['entries'] = []
  for (let index = 0; index < count; index += 1) {
    const id = `child-${index}`
    byId[id] = { id, displayTitle: id, origin: 'subagent', parentId: 'root', running: false }
    entries.push({ kind: 'child', id, activity: 'inactive', hasChildren: false, mode: 'one-shot', label: `子代理 ${index}` })
  }
  return {
    current: 'root',
    byId,
    subagentsByParent: {
      root: { entries, parentAvailable: true, state: 'ready', error: null },
    },
    jobsBySession: {
      root: [{ id: 'bash-1', kind: 'bash', label: 'sleep 300', status: 'running', startedAt: 1_000 }],
    },
  }
}

describe('Tasks page interactions', () => {
  it('keeps the jobs drawer open below the agent threshold', () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // 3 agents (root + 2 children) < 8: the drawer renders its rows open.
    expect(container.textContent).toContain('sleep 300')
    expect(container.textContent).not.toContain('已自动折叠')
    unmount()
  })

  it('auto-collapses the jobs drawer at 8+ agents, expandable by the bar', async () => {
    const store = makeStore(snapshotWithChildren(8))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // 9 agents ≥ 8: collapsed, the auto note explains, no rows rendered.
    expect(container.textContent).not.toContain('sleep 300')
    expect(container.textContent).toContain('已自动折叠')
    const bar = container.querySelector('button[aria-expanded]') as HTMLButtonElement
    expect(bar.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { bar.click() })
    expect(container.textContent).toContain('sleep 300')
    unmount()
  })

  it('toggles between graph and tree with the cluster visible in BOTH modes', async () => {
    const store = makeStore(snapshotWithChildren(2))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // Default graph: the toggle offers the tree switch.
    const toTree = container.querySelector('button[aria-label="切换为树状图"]') as HTMLButtonElement
    expect(toTree).not.toBeNull()
    expect(container.querySelector('[role="group"]')).not.toBeNull()
    await act(async () => { toTree.click() })
    // Tree mode: the toggle stays (the mockup's hidden-toggle bug is guarded).
    const toGraph = container.querySelector('button[aria-label="切换为工作流图"]') as HTMLButtonElement
    expect(toGraph).not.toBeNull()
    expect(container.querySelector('[role="tree"]')).not.toBeNull()
    await act(async () => { toGraph.click() })
    expect(container.querySelector('[role="group"]')).not.toBeNull()
    unmount()
  })

  it('jumps to the transcript on node click and opens the ⓘ popover', async () => {
    const opened: unknown[] = []
    const store = makeStore(snapshotWithChildren(1))
    const ctx = makeCtx(store, { openSubagent: (address) => { opened.push(address) } })
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx }),
    )
    // Folded by default: unfold so the settled child is visible.
    const foldToggle = container.querySelector('button[aria-label="展开已完成的节点"]') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const node = container.querySelector('[aria-label*="子代理 0"]') as HTMLElement
    await act(async () => { node.click() })
    expect(opened).toEqual([{ parentSessionId: 'root', childSessionId: 'child-0', mode: 'one-shot' }])
    unmount()
  })

  it('folds settled leaves into an aggregate that expands on click', async () => {
    const store = makeStore(snapshotWithChildren(3))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // Folded: one aggregate node, no individual children.
    expect(container.textContent).toContain('✓ 3 已完成')
    expect(container.querySelector('[aria-label*="子代理 0"]')).toBeNull()
    const fold = container.querySelector('[aria-label*="✓ 3 已完成"]') as HTMLElement
    await act(async () => { fold.click() })
    expect(container.textContent).toContain('子代理 0')
    expect(container.textContent).toContain('子代理 2')
    unmount()
  })

  it('opens the node detail popover from the ⓘ button', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    // The root node's detail affordance opens the detail card (portaled to body).
    const info = container.querySelector('button[aria-label="节点详情"]') as HTMLButtonElement
    await act(async () => { info.click() })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(document.body.textContent).toContain('查看转录')
    unmount()
  })
})

describe('Tasks page graph interactions and team board', () => {
  it('activates a graph node after a background pointerdown (no click theft)', async () => {
    const opened: unknown[] = []
    const store = makeStore(snapshotWithChildren(1))
    const ctx = makeCtx(store, { openSubagent: (address) => { opened.push(address) } })
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx }),
    )
    // Unfold so the settled child is visible, then simulate the real gesture
    // order on the canvas background before clicking the node.
    const foldToggle = container.querySelector('[data-graph-controls] button:nth-child(2)') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const canvas = container.querySelector('[role="group"]') as HTMLElement
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(node).not.toBeNull()
    await act(async () => { node.click() })
    expect(opened).toEqual([{ parentSessionId: 'root', childSessionId: 'child-0', mode: 'one-shot' }])
    unmount()
  })

  it('never starts a pan from a node (the gesture belongs to the node)', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const foldToggle = container.querySelector('[data-graph-controls] button:nth-child(2)') as HTMLButtonElement
    await act(async () => { foldToggle.click() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    const inner = node.parentElement as HTMLElement
    const before = inner.style.transform
    await act(async () => {
      node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 80, clientY: 90 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect(inner.style.transform).toBe(before)
    unmount()
  })

  it('shows the team board without any click when the root leads a team', async () => {
    teamPayload = {
      available: true,
      team: {
        members: [
          { id: 'root', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
          { id: 'child-0', name: 'writer', role: 'teammate', status: 'idle', model: 'glm-5.3', diagnostics: [] },
        ],
        tasks: [{
          id: 't1', revision: 1, subject: '收窄卡片', description: '', status: 'in_progress',
          blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
        }],
      },
    }
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    // Visible by default: header, members and the task row (no chip to click).
    expect(container.textContent).toContain('团队任务板')
    expect(container.textContent).toContain('lead')
    expect(container.textContent).toContain('writer')
    expect(container.textContent).toContain('收窄卡片')
    unmount()
  })
})

describe('Tasks page: owned tasks, host-primitive controls, draggable output', () => {
  /** A team payload whose only task is owned by the child agent. */
  function teamWithOwnedTask(): unknown {
    return {
      available: true,
      team: {
        members: [
          { id: 'root', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
          { id: 'child-0', name: 'writer', role: 'teammate', status: 'running', model: 'glm-5.3', diagnostics: [] },
        ],
        tasks: [
          {
            id: 't1', revision: 1, subject: '收窄卡片与图标化', description: '细节', status: 'in_progress',
            ownerName: 'writer', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
          },
          {
            id: 't2', revision: 2, subject: '补点击回归', description: '', status: 'pending',
            ownerName: 'writer', blockedBy: ['t1'], writeScopes: [], ready: false, writeScopeWarnings: [],
          },
        ],
      },
    }
  }

  it('renders the owned task on its agent node', async () => {
    teamPayload = teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const node = container.querySelector('[data-graph-node="child-0"]') as HTMLElement
    expect(node).not.toBeNull()
    // The node carries the task subject + its status word + the +N tail.
    expect(node.textContent).toContain('收窄卡片与图标化')
    expect(node.textContent).toContain('进行中')
    expect(node.textContent).toContain('+1')
    unmount()
  })

  it('ships no native select/input: the board edits through host primitives', async () => {
    teamPayload = teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    // No native form controls anywhere on the page.
    expect(container.querySelectorAll('select')).toHaveLength(0)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    // The row's overflow menu is a host Menu opened from a host Button.
    const menuButton = container.querySelector('button[aria-label^="任务操作"]') as HTMLButtonElement
    expect(menuButton).not.toBeNull()
    await act(async () => { menuButton.click() })
    expect(document.body.textContent).toContain('完成')
    expect(document.body.textContent).toContain('编辑')
    expect(document.body.textContent).toContain('删除')
    unmount()
  })

  it('creates a task through the dialog (host Input + modal) and posts the CAS-free create', async () => {
    teamPayload = teamWithOwnedTask()
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    await act(async () => { await Promise.resolve() })
    const create = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('新建任务'))
    expect(create).toBeDefined()
    await act(async () => { create?.click() })
    // The dialog's field is a host Input (rendered as a real <input> inside the modal).
    const field = document.querySelector('input[aria-label="标题"]') as HTMLInputElement
    expect(field).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(field, '新任务标题')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement
    expect(dialog).not.toBeNull()
    const save = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('新建任务'))
    expect(save).toBeDefined()
    expect(field.value).toBe('新任务标题')
    expect((save as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { save?.click() })
    await act(async () => { await Promise.resolve() })
    expect(fetchedMethods).toContain('teams.taskCreate')
    expect(teamMutations[0]?.body.subject).toBe('新任务标题')
    unmount()
  })

  it('drags the job output popover away from its anchor', async () => {
    const store = makeStore(snapshotWithChildren(1))
    const { container, unmount } = renderRoot(
      createElement(SubagentView, { sessionId: 'root', active: true, ctx: makeCtx(store) }),
    )
    const row = container.querySelector('button[aria-label*="sleep 300"]') as HTMLButtonElement
    await act(async () => { row.click() })
    const card = document.querySelector('[role="dialog"]') as HTMLElement
    expect(card).not.toBeNull()
    const before = { left: card.style.left, top: card.style.top }
    await act(async () => {
      card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }))
      window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 140, clientY: 120 }))
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    })
    expect({ left: card.style.left, top: card.style.top }).not.toEqual(before)
    unmount()
  })
})

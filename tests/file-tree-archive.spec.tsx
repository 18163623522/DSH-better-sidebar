/**
 * FileTree "zip and download": the context menu offers an archive row for a
 * multi-selection (≥2 rows) and for a LONE directory (a lone file is skipped —
 * the plain download row already covers it).
 *
 * The row is NOT a bare anchor any more: the bytes are fetched through
 * `archiveUrl(scope, paths, name)`, because the archive route reports its caps
 * and refusals as the plugin's JSON error envelope — an anchor would save that
 * envelope as a broken `.zip`. So these cases pin:
 *   - the URL parameters (scope / paths / name) and the appearance gates;
 *   - success: the response body becomes an object URL, saved through a hidden
 *     `<a download={name}>`, revoked on the next task;
 *   - failure: a non-2xx JSON envelope (`{error:{message}}`), a non-JSON body
 *     (`HTTP <status>`) and a network rejection all land in the error strip
 *     with the `zipFailed` copy;
 *   - a click while one request is in flight does not package twice.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

// vitest 4.1.11+ follows the OS locale; pin en-US so menu copy is English.
beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { archiveUrl, fetchMock } = vi.hoisted(() => ({
  archiveUrl: vi.fn((_scope: unknown, _paths: readonly string[], name: string) => `/sidebar/archive?name=${encodeURIComponent(name)}`),
  fetchMock: vi.fn(),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      path: '/tmp',
      entries: [
        { name: 'sub', path: '/tmp/sub', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
        { name: 'b.ts', path: '/tmp/b.ts', isDir: false },
      ],
      truncated: false,
    }),
    // The tree reads the shared git-status store; a non-repo answer keeps
    // every row plain (this spec is about the archive row).
    gitStatus: async () => ({ isRepo: false, entries: [] }),
  },
  downloadUrl: () => '/sidebar/file',
  archiveUrl,
  isOutsideWorkspaceMessage: () => false,
}))

/** jsdom implements neither object-URL helper; these ARE the download probe. */
const createdUrls: Blob[] = []
const revokedUrls: string[] = []
beforeAll(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      createdUrls.push(blob)
      return `blob:mock-${createdUrls.length}`
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => { revokedUrls.push(url) },
  })
})

interface Harness {
  container: HTMLDivElement
  unmount: () => void
}

async function mountTree(): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
    await Promise.resolve()
  })
  return {
    container,
    unmount: () => { act(() => { root.unmount() }); container.remove() },
  }
}

/** One tree row by its displayed name (the root row included). */
function rowByName(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[class*="explorerRow"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row not found: ${name}`)
  return row
}

function click(el: Element, init: MouseEventInit = {}): void {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init })) })
}

function rightClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  })
}

function menuLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent ?? '')
}

function clickMenuitem(label: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent === label)
  if (item === undefined) throw new Error(`menuitem not found: ${label}`)
  act(() => { item.click() })
}

/**
 * Flush the fetch → blob → anchor chain. The chain crosses several async
 * function boundaries (fetch promise → `await response.blob()` → object URL →
 * revoke), so a single microtask/timer pair is not enough on a loaded machine:
 * three macrotask ticks let every hop land, including the revoke `setTimeout`.
 */
async function settleDownload(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      await Promise.resolve()
      await new Promise<void>(resolve => { window.setTimeout(resolve, 0) })
    }
  })
}

/** A 200 answer carrying ZIP bytes. */
function okResponse(bytes = 'zip-bytes'): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([bytes], { type: 'application/zip' }),
  } as unknown as Response
}

/** A refused answer carrying the plugin's JSON envelope (or a non-JSON body). */
function errorResponse(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json')
      return body
    },
  } as unknown as Response
}

let harness: Harness
/** The anchors whose click() ran, as `href|download`. */
const downloads: string[] = []
const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement): void {
  downloads.push(`${this.getAttribute('href') ?? ''}|${this.download}`)
})

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(okResponse())
  archiveUrl.mockClear()
  archiveUrl.mockImplementation((_scope: unknown, _paths: readonly string[], name: string) =>
    `/sidebar/archive?name=${encodeURIComponent(name)}`)
})

afterEach(() => {
  harness.unmount()
  document.body.innerHTML = ''
  downloads.length = 0
  createdUrls.length = 0
  revokedUrls.length = 0
  clickSpy.mockClear()
  vi.unstubAllGlobals()
})

describe('FileTree zip and download', () => {
  it('archives a multi-selection through one fetched row', async () => {
    harness = await mountTree()
    click(rowByName(harness.container, 'a.ts'), { ctrlKey: true })
    click(rowByName(harness.container, 'b.ts'), { ctrlKey: true })
    // Right-clicking a row INSIDE the selection keeps the batch.
    rightClick(rowByName(harness.container, 'b.ts'))
    expect(menuLabels()).toContain('Zip and download (2 items)')
    clickMenuitem('Zip and download (2 items)')
    await settleDownload()
    expect(archiveUrl).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/a.ts', '/tmp/b.ts'], 'archive.zip')
    expect(fetchMock).toHaveBeenCalledWith('/sidebar/archive?name=archive.zip')
    // The body became an object URL saved through a hidden anchor…
    expect(createdUrls).toHaveLength(1)
    expect(downloads).toEqual(['blob:mock-1|archive.zip'])
    // …and the object URL is released on the next task.
    expect(revokedUrls).toEqual(['blob:mock-1'])
  })

  it('archives a lone directory under its own name', async () => {
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    expect(menuLabels()).toContain('Zip and download')
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(archiveUrl).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp/sub'], 'sub.zip')
    expect(fetchMock).toHaveBeenCalledWith('/sidebar/archive?name=sub.zip')
    expect(downloads).toEqual(['blob:mock-1|sub.zip'])
  })

  it('archives the workspace root row (a lone directory too)', async () => {
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'tmp'))
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(archiveUrl).toHaveBeenCalledWith({ sessionId: 's1', cwd: '/tmp' }, ['/tmp'], 'tmp.zip')
  })

  it('offers nothing for a lone FILE (the download row already covers it)', async () => {
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'a.ts'))
    expect(menuLabels()).toContain('Download')
    expect(menuLabels().some(label => label.startsWith('Zip and download'))).toBe(false)
    expect(archiveUrl).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a route refusal with the envelope message (caps, fence, bad request)', async () => {
    fetchMock.mockResolvedValue(errorResponse(413, { ok: false, error: { code: 'bad-request', message: 'archive would exceed 64 MB' } }))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: archive would exceed 64 MB')
    // Nothing was downloaded, and no object URL leaked.
    expect(downloads).toEqual([])
    expect(createdUrls).toEqual([])
  })

  it('falls back to the status when the refusal carries no JSON body', async () => {
    fetchMock.mockResolvedValue(errorResponse(500))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: HTTP 500')
    expect(downloads).toEqual([])
  })

  it('reports a network failure in the error strip', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: network down')
    expect(downloads).toEqual([])
  })

  it('reports a ZIP whose URL cannot be built without fetching', async () => {
    archiveUrl.mockImplementation(() => { throw new Error('boom: too large') })
    harness = await mountTree()
    rightClick(rowByName(harness.container, 'sub'))
    clickMenuitem('Zip and download')
    await settleDownload()
    expect(harness.container.querySelector('[role="alert"]')?.textContent)
      .toContain('Archive failed: boom: too large')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(downloads).toEqual([])
  })

  it('packages once while a request is in flight (double click guard)', async () => {
    let release: (response: Response) => void = () => {}
    fetchMock.mockImplementation(async () => await new Promise<Response>(resolve => { release = resolve }))
    harness = await mountTree()
    const pick = (): void => {
      rightClick(rowByName(harness.container, 'sub'))
      clickMenuitem('Zip and download')
    }
    pick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The row is still reachable (the menu closed on selection) and a second
    // pick must not start a second archive.
    pick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { release(okResponse()) })
    await settleDownload()
    expect(downloads).toEqual(['blob:mock-1|sub.zip'])
    // The guard releases once the request settled: another pick fetches again.
    fetchMock.mockResolvedValue(okResponse())
    pick()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await settleDownload()
  })
})

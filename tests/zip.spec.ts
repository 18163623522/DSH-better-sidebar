/**
 * ZIP builder + /sidebar/archive route.
 *
 * Two layers, no third-party ZIP dependency in either direction:
 *  - `buildZip` is checked by a minimal reader written HERE (EOCD → central
 *    directory → local header → inflate), so the test proves the bytes on the
 *    wire, not the writer's own bookkeeping. `unzip -t` is an extra check when
 *    the binary happens to exist (CI runners do not ship it).
 *  - the route is mounted against a fake cordis context (the same shape
 *    smoke.spec.ts uses) and answers a real request over a real temp
 *    workspace, covering the fence, the parameter guards and a full
 *    directory walk.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { apply } from '../src/index.ts'
import { archiveUrl } from '../src/client/api.ts'
import { archiveNameOf, collectZipEntries } from '../src/archive-route.ts'
import { crc32, buildZip, type ZipEntry } from '../src/zip.ts'
import { SidebarError } from '../src/wire.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** One parsed central-directory row + its local payload. */
interface ParsedEntry {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  flags: number
  externalAttributes: number
  isDirectory: boolean
  data: Buffer
}

/**
 * Minimal ZIP reader: locate the EOCD from the tail, walk the central
 * directory, then read each local header's payload. Enough to verify names
 * (UTF-8), methods, CRCs, sizes and both compression branches.
 */
function readZip(archive: Buffer): ParsedEntry[] {
  const eocdAt = archive.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06]))
  if (eocdAt < 0) throw new Error('no EOCD')
  if (eocdAt + 22 !== archive.length) throw new Error('EOCD is not the last record')
  const count = archive.readUInt16LE(eocdAt + 10)
  const directorySize = archive.readUInt32LE(eocdAt + 12)
  const directoryAt = archive.readUInt32LE(eocdAt + 16)
  if (count > 0 && archive.readUInt32LE(directoryAt) !== 0x02014B50) throw new Error('bad central directory signature')
  if (directoryAt + directorySize > eocdAt) throw new Error('central directory overruns the EOCD')

  const entries: ParsedEntry[] = []
  let cursor = directoryAt
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014B50) throw new Error(`bad central header ${index}`)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const crc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const size = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localAt = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (archive.readUInt32LE(localAt) !== 0x04034B50) throw new Error(`bad local header for ${name}`)
    const localNameLength = archive.readUInt16LE(localAt + 26)
    const localExtraLength = archive.readUInt16LE(localAt + 28)
    if (archive.readUInt32LE(localAt + 14) !== crc) throw new Error(`local CRC mismatch for ${name}`)
    if (archive.readUInt32LE(localAt + 18) !== compressedSize) throw new Error(`local compressed size mismatch for ${name}`)
    if (archive.readUInt32LE(localAt + 22) !== size) throw new Error(`local size mismatch for ${name}`)
    const payloadAt = localAt + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(payloadAt, payloadAt + compressedSize)
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      flags,
      externalAttributes,
      isDirectory: name.endsWith('/'),
      data: method === 8 ? inflateRawSync(payload) : Buffer.from(payload),
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** /sidebar/archive mounted against a fake context, as the host runs it. */
function mountArchive(): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (route: SidebarWebUpgradeRoute) => { void route; return () => {} },
    },
    sessions: { get: () => undefined },
    tools: { register: () => () => {} },
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  const route = routes.find(candidate => candidate.path === '/sidebar/archive')
  if (route === undefined) throw new Error('test setup: /sidebar/archive route not registered')
  return route
}

/** One GET against a mounted route, collecting raw bytes. */
async function get(route: SidebarWebRoute, url: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const out: { status: number; headers: Record<string, string>; chunks: Buffer[] } = { status: 200, headers: {}, chunks: [] }
  const req = { method: 'GET', url, headers: { host: '127.0.0.1:3080' } } as never
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}) => { out.status = status; out.headers = headers },
    end: (chunk?: Buffer | string) => { if (chunk !== undefined) out.chunks.push(Buffer.from(chunk)) },
  } as never
  await route.handler(req, res)
  return { status: out.status, headers: out.headers, body: Buffer.concat(out.chunks) }
}

/** A temp workspace (plus an outside sibling) removed after each test. */
const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sidebar-zip-'))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('buildZip', () => {
  it('round-trips a deflated file: name, content and CRC-32', async () => {
    const root = tempRoot()
    const path = join(root, 'hello.txt')
    const content = 'hello zip\n'.repeat(200)
    writeFileSync(path, content)
    const archive = await buildZip([{ path, name: 'hello.txt' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.name).toBe('hello.txt')
    expect(entry.method).toBe(8)
    expect(entry.data.toString('utf8')).toBe(content)
    expect(entry.crc).toBe(crc32(Buffer.from(content)))
    expect(entry.size).toBe(Buffer.byteLength(content))
    expect(entry.isDirectory).toBe(false)
  })

  it('stores incompressible data (method 0) and marks UTF-8 names (bit 11)', async () => {
    const root = tempRoot()
    const path = join(root, 'random.bin')
    // High-entropy bytes: deflateRaw expands them (4096 → ~4100), so the
    // writer must fall back to `store`. Generated from a fixed seed so the
    // case stays deterministic.
    const random = Buffer.alloc(4096)
    let state = 0x9E3779B9
    for (let i = 0; i < random.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      random[i] = (state >>> 16) & 0xFF
    }
    writeFileSync(path, random)
    const archive = await buildZip([{ path, name: '数据/随机.bin' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.method).toBe(0)
    expect(entry.name).toBe('数据/随机.bin')
    expect((entry.flags & 0x0800) !== 0).toBe(true)
    expect(entry.data.equals(random)).toBe(true)
    expect(entry.crc).toBe(crc32(random))
  })

  it('writes directory rows with a trailing slash, zero payload and the dir attribute', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'a.txt'), 'a')
    const archive = await buildZip([
      { path: join(root, 'nested'), name: 'nested', isDir: true },
      { path: join(root, 'nested', 'a.txt'), name: 'nested/a.txt' },
    ])
    const entries = readZip(archive)
    expect(entries.map(entry => entry.name)).toEqual(['nested/', 'nested/a.txt'])
    const dir = entries[0]!
    expect(dir.isDirectory).toBe(true)
    expect(dir.size).toBe(0)
    expect(dir.crc).toBe(0)
    // The external-attributes word carries the Unix mode in the high half and
    // the MS-DOS directory bit in the low half: without the mode Info-ZIP
    // extracts every member as mode 000.
    expect(dir.externalAttributes & 0x10).toBe(0x10)
    expect(dir.externalAttributes >>> 16).toBe(0o40755)
    expect(entries[1]!.externalAttributes & 0x10).toBe(0)
    expect(entries[1]!.externalAttributes >>> 16).toBe(0o100644)
  })

  it('accepts an empty directory set and produces a valid empty archive', async () => {
    const archive = await buildZip([])
    expect(readZip(archive)).toEqual([])
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054B50)
  })

  it('rejects an over-limit entry count before reading anything', async () => {
    const root = tempRoot()
    const path = join(root, 'a.txt')
    writeFileSync(path, 'a')
    await expect(buildZip([{ path, name: 'a.txt' }], { maxEntries: 0 })).rejects.toThrow(SidebarError)
    await expect(buildZip([{ path, name: 'a.txt' }], { maxEntries: 0 })).rejects.toMatchObject({ code: 'fs-error' })
  })

  it('rejects an over-limit payload with fs-error', async () => {
    const root = tempRoot()
    const path = join(root, 'big.txt')
    writeFileSync(path, 'x'.repeat(4096))
    await expect(buildZip([{ path, name: 'big.txt' }], { maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'fs-error' })
  })

  it('reports an unreadable source as fs-error and refuses traversal names', async () => {
    const root = tempRoot()
    await expect(buildZip([{ path: join(root, 'missing.txt'), name: 'missing.txt' }]))
      .rejects.toMatchObject({ code: 'fs-error' })
    await expect(buildZip([{ path: join(root, 'x'), name: '../escape.txt' }]))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('passes `unzip -t` when the binary exists (skipped otherwise)', async () => {
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' })
    if (probe.error !== undefined || probe.status !== 0) return
    const root = tempRoot()
    const content = 'unzip parity\n'.repeat(100)
    writeFileSync(join(root, 'a.txt'), content)
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'b.txt'), content)
    const archive = await buildZip([
      { path: join(root, 'a.txt'), name: 'a.txt' },
      { path: join(root, 'dir'), name: 'dir', isDir: true },
      { path: join(root, 'dir', 'b.txt'), name: 'dir/b.txt' },
    ])
    const file = join(root, 'out.zip')
    writeFileSync(file, archive)
    const result = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('No errors detected')
    // `-t` only checks CRCs; extract too, so a broken external-attributes word
    // (Info-ZIP writes mode 000 files) cannot pass unnoticed.
    const extracted = join(root, 'out')
    const unpack = spawnSync('unzip', ['-o', file, '-d', extracted], { encoding: 'utf8' })
    expect(unpack.status, unpack.stderr).toBe(0)
    const inMode = statSync(join(root, 'a.txt')).mode & 0o777
    const outMode = statSync(join(extracted, 'a.txt')).mode & 0o777
    expect(outMode).toBe(inMode & 0o644)
    expect(readFileSync(join(extracted, 'a.txt'), 'utf8')).toBe(content)
    expect(readFileSync(join(extracted, 'dir', 'b.txt'), 'utf8')).toBe(content)
  })
})

describe('collectZipEntries', () => {
  it('walks directories depth-first in name order and bounds the row count', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'd'))
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'd', 'b.txt'), 'b')
    const entries: ZipEntry[] = []
    await collectZipEntries(root, 'root', entries)
    expect(entries.map(entry => entry.name)).toEqual(['root', 'root/a.txt', 'root/d', 'root/d/b.txt'])
    expect(entries[0]!.isDir).toBe(true)

    const bounded: ZipEntry[] = []
    await expect(collectZipEntries(root, 'root', bounded, 2))
      .rejects.toMatchObject({ code: 'fs-error' })
    // The bound stops the walk early instead of filling the list first.
    expect(bounded.length).toBeLessThanOrEqual(2)
  })

  it('treats an unreadable row as fs-error', async () => {
    const root = tempRoot()
    const entries: ZipEntry[] = []
    await expect(collectZipEntries(join(root, 'missing'), 'missing', entries))
      .rejects.toMatchObject({ code: 'fs-error' })
  })
})

describe('archiveNameOf', () => {
  it('strips separators / quotes / control chars and applies the .zip suffix once', () => {
    expect(archiveNameOf(null)).toBe('archive.zip')
    expect(archiveNameOf('')).toBe('archive.zip')
    expect(archiveNameOf('   ')).toBe('archive.zip')
    expect(archiveNameOf('docs')).toBe('docs.zip')
    expect(archiveNameOf('docs.zip')).toBe('docs.zip')
    expect(archiveNameOf('DOCS.ZIP')).toBe('DOCS.ZIP')
    // Path separators, traversal dots and quotes never survive.
    expect(archiveNameOf('../../etc/passwd')).toBe('etcpasswd.zip')
    expect(archiveNameOf('a\\b".zip')).toBe('ab.zip')
    expect(archiveNameOf('bad\u0000name\u001F.zip')).toBe('badname.zip')
    // Length is capped, and a bare ".zip" input falls back to the default.
    expect(archiveNameOf(`${'x'.repeat(300)}.zip`).length).toBe(124)
    expect(archiveNameOf('.zip')).toBe('archive.zip')
  })
})

describe('/sidebar/archive route', () => {
  it('archiveUrl builds the GET URL the route parses (repeated path, encoded)', () => {
    const url = archiveUrl({ sessionId: 's-1', cwd: '/work tree' }, ['/work tree/a b.txt', '/work tree/子目录'], 'my zip.zip')
    const parsed = new URL(url, 'http://dsh.internal')
    expect(parsed.pathname).toBe('/sidebar/archive')
    expect(parsed.searchParams.get('sessionId')).toBe('s-1')
    expect(parsed.searchParams.get('cwd')).toBe('/work tree')
    expect(parsed.searchParams.get('name')).toBe('my zip.zip')
    expect(parsed.searchParams.getAll('path')).toEqual(['/work tree/a b.txt', '/work tree/子目录'])
    // A scope without a cwd omits the parameter entirely (same as downloadUrl).
    expect(archiveUrl({ sessionId: 's-2' }, ['/a'], 'x.zip')).toBe('/sidebar/archive?sessionId=s-2&name=x.zip&path=%2Fa')
  })

  it('zips a selected file and a selected directory, walking it recursively', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'index.ts'), 'export {}\n')
    writeFileSync(join(workspace, 'src', 'deep', 'nested.ts'), 'nested\n')
    writeFileSync(join(workspace, 'notes.md'), '# notes\n')
    const route = mountArchive()
    const url = `/sidebar/archive?sessionId=s-zip&cwd=${encodeURIComponent(workspace)}`
      + `&name=${encodeURIComponent('我的打包.zip')}`
      + `&path=${encodeURIComponent(join(workspace, 'src'))}`
      + `&path=${encodeURIComponent(join(workspace, 'notes.md'))}`
    const response = await get(route, url)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toBe('application/zip')
    expect(response.headers['content-disposition']).toBe('attachment; filename="我的打包.zip"')
    expect(Number(response.headers['content-length'])).toBe(response.body.byteLength)
    const entries = readZip(response.body)
    expect(entries.map(entry => entry.name)).toEqual([
      'src/',
      'src/deep/',
      'src/deep/nested.ts',
      'src/index.ts',
      'notes.md',
    ])
    const byName = new Map(entries.map(entry => [entry.name, entry]))
    expect(byName.get('src/index.ts')!.data.toString('utf8')).toBe('export {}\n')
    expect(byName.get('notes.md')!.data.toString('utf8')).toBe('# notes\n')
  })

  it('never follows a symlink out of the workspace', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    try {
      symlinkSync(outside, join(workspace, 'link'))
      // A file INSIDE the workspace, so the archive itself is readable.
      writeFileSync(join(workspace, 'keep.txt'), 'keep')
    } catch {
      return // symlink creation needs privileges on Windows
    }
    const route = mountArchive()
    const scope = `sessionId=s-zip&cwd=${encodeURIComponent(workspace)}`
    // Selecting the escaping link refuses at the workspace fence (the route
    // canonicalizes before walking), so its target is never read…
    const linked = await get(route, `/sidebar/archive?${scope}&path=${encodeURIComponent(join(workspace, 'link'))}`)
    expect(linked.status).toBe(403)
    // …and walking the containing directory reports the link as an entry-less
    // row instead of descending into it.
    const walked = await get(route, `/sidebar/archive?${scope}&path=${encodeURIComponent(workspace)}`)
    expect(walked.status).toBe(200)
    const entries = readZip(walked.body)
    expect(entries.map(entry => entry.name)).toEqual(['workspace/', 'workspace/keep.txt'])
    expect(entries.some(entry => entry.data.toString('utf8').includes('secret'))).toBe(false)
  })

  it('refuses a path outside the workspace with 403', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const outside = join(root, 'outside')
    mkdirSync(workspace)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const route = mountArchive()
    const url = `/sidebar/archive?sessionId=s-zip&cwd=${encodeURIComponent(workspace)}`
      + `&path=${encodeURIComponent(join(outside, 'secret.txt'))}`
    const response = await get(route, url)
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('rejects a missing path (and a missing sessionId) with 400', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const route = mountArchive()
    const noPath = await get(route, `/sidebar/archive?sessionId=s-zip&cwd=${encodeURIComponent(workspace)}`)
    expect(noPath.status).toBe(400)
    expect(JSON.parse(noPath.body.toString('utf8'))).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    const noSession = await get(route, `/sidebar/archive?cwd=${encodeURIComponent(workspace)}&path=${encodeURIComponent(workspace)}`)
    expect(noSession.status).toBe(400)
  })

  it('sanitizes the download name (separators stripped, default and suffix applied)', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'a.txt'), 'a')
    const route = mountArchive()
    const path = encodeURIComponent(join(workspace, 'a.txt'))
    const scope = `sessionId=s-zip&cwd=${encodeURIComponent(workspace)}&path=${path}`
    const traversal = await get(route, `/sidebar/archive?${scope}&name=${encodeURIComponent('../evil")b.zip')}`)
    expect(traversal.headers['content-disposition']).toBe('attachment; filename="evil)b.zip"')
    const bare = await get(route, `/sidebar/archive?${scope}&name=docs`)
    expect(bare.headers['content-disposition']).toBe('attachment; filename="docs.zip"')
    const fallback = await get(route, `/sidebar/archive?${scope}`)
    expect(fallback.headers['content-disposition']).toBe('attachment; filename="archive.zip"')
  })

  it('rejects a non-GET method', async () => {
    const route = mountArchive()
    const out: { status: number; body: string } = { status: 200, body: '' }
    const req = { method: 'POST', url: '/sidebar/archive?sessionId=s&path=/x', headers: { host: '127.0.0.1:3080' } } as never
    const res = {
      writeHead: (status: number) => { out.status = status },
      end: (chunk?: string) => { out.body += String(chunk ?? '') },
    } as never
    await route.handler(req, res)
    expect(out.status).toBe(405)
  })
})

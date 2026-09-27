/**
 * The host's "new folder" mutation (`fs.mkdir` route → mkdirWorkspaceEntry):
 * shape rules, existence refusal, containment under the fence, the root row
 * as a legal PARENT, and the happy path against a real temporary filesystem.
 */
import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirWorkspaceEntry } from '../src/fs-operations.ts'

let root: string
/** The workspace root as the host will report it (macOS /tmp is a symlink). */
let realRoot: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-mkdir-'))
  realRoot = await realpath(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The wire code of a rejected call (the route maps it to an HTTP status). */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
  return 'resolved'
}

describe('mkdirWorkspaceEntry', () => {
  it('creates one directory inside the named row and returns its absolute path', async () => {
    await mkdir(join(root, 'sub'))
    const result = await mkdirWorkspaceEntry({ cwd: root, path: join(root, 'sub'), name: 'fresh' })
    expect(result.path).toBe(join(realRoot, 'sub', 'fresh'))
    expect(await readdir(join(root, 'sub'))).toEqual(['fresh'])
  })

  it('accepts the workspace root itself as the parent', async () => {
    const result = await mkdirWorkspaceEntry({ cwd: root, path: root, name: 'top' })
    expect(result.path).toBe(join(realRoot, 'top'))
    expect(await readdir(root)).toEqual(['top'])
  })

  it('refuses a name that is not a single path segment', async () => {
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: 'a/b' }))).toBe('bad-request')
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: '..' }))).toBe('bad-request')
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: '' }))).toBe('bad-request')
  })

  it('refuses an existing destination with the same conflict code as rename', async () => {
    await mkdir(join(root, 'taken'))
    expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: root, name: 'taken' }))).toBe('fs-error')
  })

  it('refuses a parent outside the workspace while the fence is armed, and allows it when disarmed', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-outside-'))
    try {
      await writeFile(join(outside, 'marker.txt'), 'x')
      expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: outside, name: 'nope' }))).toBe('forbidden')
      // The fence is the guard, not the path shape: disarmed, the same call lands.
      const result = await mkdirWorkspaceEntry({ cwd: root, path: outside, name: 'allowed', fence: false })
      expect(result.path).toBe(join(await realpath(outside), 'allowed'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('refuses to create INSIDE a symlink that escapes the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-link-'))
    try {
      await symlink(outside, join(root, 'escape'))
      expect(await codeOf(() => mkdirWorkspaceEntry({ cwd: root, path: join(root, 'escape'), name: 'nope' }))).toBe('forbidden')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

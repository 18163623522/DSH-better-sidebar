/**
 * Helpers for the `/sidebar/archive` route (the file tree's "zip and
 * download" action): the download-name sanitizer and the recursive entry
 * walk. Kept apart from index.ts so both are directly unit-testable — the
 * walk's bounds live inside the collector, and the route module is a
 * cordis plugin whose setup needs a whole fake context.
 *
 * The walk is the security-relevant half: every row comes from an already
 * fenced path (index.ts resolves each selection through
 * `ensureWorkspacePath` first), and a symlink is skipped rather than followed,
 * so it can neither escape the workspace nor cycle.
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SidebarError } from './wire.ts'
import { ZIP_MAX_ENTRIES, type ZipEntry } from './zip.ts'

/** Maximum archive-name length (keeps the Content-Disposition header sane). */
export const ARCHIVE_NAME_MAX = 120

/**
 * Sanitize the archive's download name: one flat file name, never a path.
 * Separators, control characters, quotes and leading dots are stripped (a
 * name cannot look like a traversal or hide as a dotfile); an empty result
 * falls back to `archive.zip`, and a `.zip` suffix is applied once.
 */
export function archiveNameOf(raw: string | null): string {
  // A bare `.zip` (or nothing at all) is the caller asking for the default:
  // check BEFORE the leading-dot strip below, which would turn it into `zip`.
  const trimmed = (raw ?? '').trim()
  if (trimmed === '' || trimmed === '.zip') return 'archive.zip'
  // Character filter (not a character-class regex): separators, quotes and
  // C0/DEL control characters cannot survive into the header.
  const cleaned = [...trimmed]
    .filter((char) => {
      const code = char.codePointAt(0)!
      return char !== '\\' && char !== '/' && char !== '"' && char !== '\'' && code >= 0x20 && code !== 0x7F
    })
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, ARCHIVE_NAME_MAX)
  if (cleaned === '') return 'archive.zip'
  return cleaned.toLowerCase().endsWith('.zip') ? cleaned : `${cleaned}.zip`
}

/**
 * Collect one selected path into the archive: a file becomes one entry, a
 * directory is walked depth-first and each level contributes its own entry
 * (a trailing '/' name), files keep their layout under the directory's own
 * name. Symlinks are skipped, never followed. Iterative (an explicit stack)
 * because a deep tree must not blow the JS stack, and the count bound is
 * enforced HERE so a runaway directory fails before its rows pile up.
 *
 * @param absolute - the (already fenced) absolute path of the selection.
 * @param name - the in-archive name of that selection (its basename).
 * @param out - the entry list appended to, in archive order.
 * @param maxEntries - entry-count bound.
 * @throws {SidebarError} fs-error when a row cannot be read or the bound is hit.
 */
export async function collectZipEntries(
  absolute: string,
  name: string,
  out: ZipEntry[],
  maxEntries = ZIP_MAX_ENTRIES,
): Promise<void> {
  const stack: Array<{ path: string; name: string }> = [{ path: absolute, name }]
  while (stack.length > 0) {
    const item = stack.pop()!
    if (out.length >= maxEntries) {
      throw new SidebarError('fs-error', `too many entries for one archive (> ${maxEntries})`, 400)
    }
    const info = await lstat(item.path).catch((error: unknown) => {
      throw new SidebarError('fs-error', `cannot read "${item.path}": ${error instanceof Error ? error.message : String(error)}`, 400)
    })
    if (info.isSymbolicLink()) {
      // A link row is not a file to read and not a directory to walk: it is
      // skipped (an archive of a dangling link has nothing to store). Never
      // followed — no escape and no cycle.
      continue
    }
    if (!info.isDirectory()) {
      out.push({ path: item.path, name: item.name })
      continue
    }
    out.push({ path: item.path, name: item.name, isDir: true })
    let level
    try {
      level = await readdir(item.path, { withFileTypes: true })
    } catch (error) {
      throw new SidebarError('fs-error', `cannot list "${item.path}": ${error instanceof Error ? error.message : String(error)}`, 400)
    }
    // Reverse order: the stack pops the first child next, so the archive reads
    // top-down in directory order.
    for (let index = level.length - 1; index >= 0; index -= 1) {
      const child = level[index]!
      stack.push({ path: join(item.path, child.name), name: `${item.name}/${child.name}` })
    }
  }
}

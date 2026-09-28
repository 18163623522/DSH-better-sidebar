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
import { basename, dirname, join } from 'node:path'
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
 * The `content-disposition` value for one archive download.
 *
 * A non-latin1 name (a Chinese folder → `报告.zip`) CANNOT go into the header
 * verbatim: Node's `writeHead` validates header values and rejects anything
 * above U+00FF with `Invalid character in header content` — the route turned
 * that into a 500. So the name is sent twice, exactly like `/sidebar/file`
 * does for a download: an ASCII-only `filename="…"` fallback for old clients
 * and the RFC 5987 `filename*=UTF-8''…` form (percent-encoded, therefore pure
 * ASCII) for everyone else, which wins in every current browser.
 */
export function contentDispositionOf(name: string): string {
  return `attachment; filename="${asciiFallbackOf(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * The ASCII-only fallback of a download name: characters a quoted header
 * string cannot carry (or that no latin1 client could render) drop out, and a
 * stray quote or backslash does too. A result with no stem left (`''` or a
 * bare extension, as a fully non-latin1 name reduces to) becomes
 * `download.zip`, so the header always names a usable file.
 */
function asciiFallbackOf(name: string): string {
  const ascii = [...name]
    .filter(char => {
      const code = char.codePointAt(0)!
      return code >= 0x20 && code <= 0x7E && char !== '"' && char !== '\\'
    })
    .join('')
  const stem = ascii.replace(/\.zip$/i, '')
  if (stem === '' || /^\.+$/.test(stem)) return 'download.zip'
  return ascii
}

/**
 * The in-archive name of every selection, disambiguated.
 *
 * The common case keeps the intuition "one selection is named by its own
 * basename" — archive `/ws/src` and the entries live under `src/`. Two
 * selections that would collide (multi-select `/ws/a/index.ts` and
 * `/ws/b/index.ts` both wanting `index.ts`) are extended with parent
 * segments until every name is unique, so an extractor cannot silently
 * overwrite one member with another. A path that runs out of ancestors
 * (selecting the filesystem root, or `/a` twice) falls back to the full
 * '/'-joined path, which is unique by construction.
 *
 * @param selections - absolute (already fenced) paths, in selection order.
 * @returns one '/'-separated archive name per selection, same order.
 */
export function disambiguateArchiveNames(selections: readonly string[]): string[] {
  const segmentsOf = (absolute: string, depth: number): string => {
    const parts: string[] = []
    let current = absolute
    for (let level = 0; level < depth; level += 1) {
      const part = basename(current)
      const parent = dirname(current)
      if (part === '' || parent === current) break
      parts.unshift(part)
      current = parent
    }
    return parts.join('/')
  }
  const deepEnough = (absolute: string, name: string): string => {
    const full = segmentsOf(absolute, Number.MAX_SAFE_INTEGER)
    // Still colliding after every segment is in play (two identical paths, or
    // a root-level duplicate): the full path is the best available identity.
    return full === name ? absolute.replace(/^\/+/, '') : name
  }
  const depth = new Map<string, number>(selections.map(path => [path, 1]))
  for (let round = 0; round < 64; round += 1) {
    const names = selections.map(path => segmentsOf(path, depth.get(path)!))
    const counts = new Map<string, number>()
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
    if ([...counts.values()].every(count => count === 1)) return names
    const grown = new Set<string>()
    for (const [index, path] of selections.entries()) {
      if ((counts.get(names[index]!) ?? 0) <= 1) continue
      depth.set(path, depth.get(path)! + 1)
      grown.add(path)
    }
    if (grown.size === 0) break
  }
  return selections.map(path => deepEnough(path, segmentsOf(path, depth.get(path)!)))
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

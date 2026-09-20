/**
 * Elevation guard of the task page, shadcn/ui stock edition.
 *
 * Static panels (cards, rows, the drawer) may carry the stock LIGHT shadows
 * only — `shadow-xs` (button-like compact surfaces such as graph node cards)
 * and `shadow-sm` (cards / panels). Anything heavier (`shadow-md|lg|xl|2xl`,
 * bare `shadow`, `shadow-inner`, arbitrary `shadow-[…]`) on a static panel is
 * the regression: elevation beyond the stock pair reads as a floating layer
 * that nothing anchors.
 *
 * Real floating layers keep their deeper shadows: the `AnchoredPopover` shell
 * (the task window / node popover chassis) and the vendored `popover` /
 * `dropdown-menu` / `tooltip` primitives, which render into a portal.
 *
 * The guard is deliberately source-level: a `shadow-*` utility dropped into a
 * static panel is exactly the regression, and the class name is the only place
 * it is visible (Tailwind generates the CSS at build time).
 */
// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const VENDORED_UI_DIR = 'src/client/ui'

/** Panels that are laid out IN the page: light stock shadows only. */
const STATIC_PANEL_FILES = [
  'src/client/SubagentView.tsx',
  'src/client/SubagentView.module.css',
  'src/client/TasksGraph.tsx',
  'src/client/TasksTree.tsx',
  'src/client/TaskWindow.tsx',
  'src/client/TeamBoard.tsx',
  'src/client/JobsDrawer.tsx',
  'src/client/TasksPopovers.tsx',
  'src/client/tasks-shared.tsx',
  'src/client/tasks-canvas.module.css',
]

/** The only files allowed to paint a deeper elevation shadow (floating layers). */
const FLOATING_FILES = [
  'src/client/AnchoredPopover.tsx',
  `${VENDORED_UI_DIR}/popover.tsx`,
  `${VENDORED_UI_DIR}/dropdown-menu.tsx`,
  `${VENDORED_UI_DIR}/tooltip.tsx`,
]

/**
 * Every shadow utility a file uses (Tailwind spellings, but NOT `box-shadow`,
 * which is how the components spell the focus-ring transition
 * (`transition-[color,box-shadow]`) and the ring plumbing (`--tw-shadow`)).
 */
const SHADOW_UTILITY = /(?<![-\w])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|none)|\[|\()?/g

/** The stock pair a static panel may paint. */
const STATIC_ALLOWED = new Set(['shadow-xs', 'shadow-sm'])

/** Every non-allowed shadow utility in the source, for a readable failure. */
function offendingShadows(source: string): string[] {
  return (source.match(SHADOW_UTILITY) ?? [])
    .filter(match => !STATIC_ALLOWED.has(match))
}

/** A literal `box-shadow` declaration is the same defect in stylesheet form. */
const BOX_SHADOW_DECLARATION = /(?:^|;)\s*box-shadow\s*:/

/** Comments are prose about shadows ("no shadow — a node never floats"). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const read = (file: string) => stripComments(readFileSync(resolve(ROOT, file), 'utf8'))

describe('task page: static panels keep stock light shadows only', () => {
  it.each(STATIC_PANEL_FILES)('%s carries no shadow beyond shadow-xs/shadow-sm', (file) => {
    expect(offendingShadows(read(file)), file).toEqual([])
  })

  it('no migrated stylesheet declares box-shadow', () => {
    for (const file of [...STATIC_PANEL_FILES, ...FLOATING_FILES].filter(name => name.endsWith('.css'))) {
      expect(read(file), file).not.toMatch(BOX_SHADOW_DECLARATION)
    }
  })

  it('keeps the deep shadows in the floating allowlist only', () => {
    const uiFiles = readdirSync(resolve(ROOT, VENDORED_UI_DIR))
      .filter(name => /\.(?:tsx|ts|css)$/.test(name))
      .map(name => `${VENDORED_UI_DIR}/${name}`)
    const surface = [...STATIC_PANEL_FILES, ...FLOATING_FILES, ...uiFiles]
    for (const file of new Set(surface)) {
      if (FLOATING_FILES.includes(file)) continue
      expect(offendingShadows(read(file)), file).toEqual([])
    }
  })

  it('is not a dead allowlist: the floating layers really carry deep shadows', () => {
    // If a floating file stops carrying its shadow, the allowlist is hiding a
    // regression elsewhere (or the elevation policy drifted back to flat).
    expect(read('src/client/AnchoredPopover.tsx')).toMatch(/(?<![-\w])shadow-lg/)
    expect(read(`${VENDORED_UI_DIR}/popover.tsx`)).toMatch(/(?<![-\w])shadow-md/)
    expect(read(`${VENDORED_UI_DIR}/dropdown-menu.tsx`)).toMatch(/(?<![-\w])shadow-lg/)
  })
})

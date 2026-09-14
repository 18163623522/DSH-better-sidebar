/**
 * The layered top-down layout of the Tasks graph canvas: a tidy-tree
 * simplification — every node sits one row below its parent, siblings share
 * a row in model order, and each parent is horizontally centered over its
 * children's band. Pure and dependency-free (the bundle-purity rule forbids
 * pulling a graph library into the core bundle; <100-node trees need no
 * virtualisation), unit-testable in the node environment.
 */
import type { TasksNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'

/** Geometry constants of the canvas (px, pre-scale). */
export const GRAPH_NODE_W = 140
export const GRAPH_NODE_H = 48
/** Extra height of an agent node carrying a live line. */
export const GRAPH_LIVE_H = 16
export const GRAPH_GAP_X = 28
export const GRAPH_GAP_Y = 72
export const GRAPH_PAD = 16

/** One laid-out node. */
export interface GraphBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** The layout result: one box per node plus the canvas extent. */
export interface GraphLayout {
  boxes: ReadonlyMap<string, GraphBox>
  width: number
  height: number
}

/** The display height of one node (live lines grow agent rows). */
function nodeHeight(node: TasksNode): number {
  if (node.kind === 'agent' && node.live !== undefined) return GRAPH_NODE_H + GRAPH_LIVE_H
  return GRAPH_NODE_H
}

/**
 * Lay out the model top-down. Nodes whose parent is missing (a fold node
 * whose parent scrolled out of the model — defensive) attach to the first
 * root. The algorithm is the classic two-walk tidy pass: a post-order walk
 * accumulates each subtree's width, a pre-order walk assigns x so every
 * parent centers over its children.
 * @param nodes - the model's pre-order node list (roots = parentless rows).
 */
export function layoutTasksGraph(nodes: readonly TasksNode[]): GraphLayout {
  const roots = nodes.filter(node => node.parentId === undefined || !nodes.some(candidate => candidate.id === node.parentId))
  const childrenOf = new Map<string, TasksNode[]>()
  for (const edge of tasksEdges(nodes)) {
    const child = nodes.find(node => node.id === edge.to)
    if (child === undefined) continue
    const list = childrenOf.get(edge.from)
    if (list === undefined) childrenOf.set(edge.from, [child])
    else list.push(child)
  }

  /** Post-order: the width of the subtree rooted at `node`. */
  const subtreeWidth = (node: TasksNode): number => {
    const children = childrenOf.get(node.id) ?? []
    if (children.length === 0) return GRAPH_NODE_W
    const band = children.reduce((sum, child) => sum + subtreeWidth(child), 0)
      + GRAPH_GAP_X * (children.length - 1)
    return Math.max(GRAPH_NODE_W, band)
  }

  const boxes = new Map<string, GraphBox>()
  /** Pre-order: place `node` so its band centers on `centerX`; `depth` is
   *  the row (the tallest ancestor row so far offsets uniformly). */
  const place = (node: TasksNode, centerX: number, depth: number): void => {
    const h = nodeHeight(node)
    boxes.set(node.id, {
      id: node.id,
      x: Math.round(centerX - GRAPH_NODE_W / 2),
      y: GRAPH_PAD + depth * (GRAPH_NODE_H + GRAPH_LIVE_H + GRAPH_GAP_Y),
      w: GRAPH_NODE_W,
      h,
    })
    const children = childrenOf.get(node.id) ?? []
    if (children.length === 0) return
    const total = children.reduce((sum, child) => sum + subtreeWidth(child), 0)
      + GRAPH_GAP_X * (children.length - 1)
    let cursor = centerX - total / 2
    for (const child of children) {
      const width = subtreeWidth(child)
      place(child, cursor + width / 2, depth + 1)
      cursor += width + GRAPH_GAP_X
    }
  }

  // Single-root forest in practice (the topology root); the loop stays so a
  // defensive orphan still lands inside the canvas extent.
  let offset = GRAPH_PAD
  for (const root of roots) {
    const width = subtreeWidth(root)
    place(root, offset + width / 2, 0)
    offset += width + GRAPH_GAP_X
  }

  const allBoxes = [...boxes.values()]
  const width = Math.max(GRAPH_PAD * 2 + GRAPH_NODE_W, ...allBoxes.map(box => box.x + box.w + GRAPH_PAD))
  const height = Math.max(GRAPH_PAD * 2 + GRAPH_NODE_H, ...allBoxes.map(box => box.y + box.h + GRAPH_PAD))
  return { boxes, width, height }
}

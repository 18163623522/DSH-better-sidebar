/**
 * Unit tests for the layered graph layout (layoutTasksGraph): parent
 * centering over children bands, depth rows, and live-line heights.
 */
import { describe, expect, it } from 'vitest'
import {
  GRAPH_GAP_Y,
  GRAPH_LIVE_H,
  GRAPH_NODE_H,
  GRAPH_NODE_W,
  GRAPH_PAD,
  layoutTasksGraph,
} from '../src/client/tasks-graph-layout.ts'
import type { TasksAgentNode, TasksNode } from '../src/client/tasks-model.ts'

/** An agent node. */
function agent(id: string, parentId?: string, live = false): TasksAgentNode {
  return {
    kind: 'agent', id, ...(parentId === undefined ? {} : { parentId }),
    label: id, state: 'running', activity: 'running', current: false,
    ...(live ? { live: { text: 'x' } } : {}),
  }
}

describe('layoutTasksGraph', () => {
  it('places the root on row 0 and children one row below', () => {
    const nodes: TasksNode[] = [agent('root'), agent('a', 'root'), agent('b', 'root')]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('root')).toMatchObject({ y: GRAPH_PAD, h: GRAPH_NODE_H })
    const rowY = GRAPH_PAD + GRAPH_NODE_H + GRAPH_LIVE_H + GRAPH_GAP_Y
    expect(layout.boxes.get('a')?.y).toBe(rowY)
    expect(layout.boxes.get('b')?.y).toBe(rowY)
  })

  it('centers a parent over its children band', () => {
    const nodes: TasksNode[] = [agent('root'), agent('a', 'root'), agent('b', 'root')]
    const layout = layoutTasksGraph(nodes)
    const a = layout.boxes.get('a')
    const b = layout.boxes.get('b')
    const root = layout.boxes.get('root')
    expect(a).toBeDefined(); expect(b).toBeDefined(); expect(root).toBeDefined()
    const bandCenter = ((a!.x + b!.x + GRAPH_NODE_W) / 2)
    expect(root!.x + GRAPH_NODE_W / 2).toBeCloseTo(bandCenter, 5)
  })

  it('widens the canvas for deep/wide forests and grows live rows', () => {
    const nodes: TasksNode[] = [
      agent('root'), agent('a', 'root', true),
      agent('a1', 'a'), agent('a2', 'a'), agent('a3', 'a'),
    ]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('a')?.h).toBe(GRAPH_NODE_H + GRAPH_LIVE_H)
    expect(layout.width).toBeGreaterThan(3 * GRAPH_NODE_W)
    expect(layout.height).toBeGreaterThan(2 * (GRAPH_NODE_H + GRAPH_GAP_Y))
  })

  it('gives every node a box even with a defensive orphan', () => {
    const nodes: TasksNode[] = [agent('root'), agent('ghost', 'missing')]
    const layout = layoutTasksGraph(nodes)
    expect(layout.boxes.get('root')).toBeDefined()
    expect(layout.boxes.get('ghost')).toBeDefined()
  })
})

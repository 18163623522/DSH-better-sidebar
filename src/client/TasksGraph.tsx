/**
 * The workflow-graph mode of the Tasks page: the approved Variant D canvas —
 * layered agent/workflow nodes over bezier edges, pointer-drag pan,
 * wheel-zoom-to-cursor, per-phase dashed frames, fold aggregate nodes, and a
 * bottom-right control cluster (view toggle / zoom out / percentage / zoom
 * in / fit / fold toggle). The cluster lives OUTSIDE the scroll surface so
 * the view toggle stays reachable in both modes (a lesson of the mockup).
 *
 * The layout comes from the pure `layoutTasksGraph`; this component owns
 * only the transform state and DOM wiring.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import { IconChevronUpOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksFoldNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { tasksEdges } from './tasks-model.ts'
import { GRAPH_NODE_H, GRAPH_NODE_W, layoutTasksGraph, type GraphBox } from './tasks-graph-layout.ts'
import { agentSecondary, foldPreviews, LiveLine, nodeDotState } from './tasks-shared.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'

/** The zoom bounds of the canvas. */
const ZOOM_MIN = 0.15
const ZOOM_MAX = 2.5
/** Drag-vs-click separation: pointer travel below this stays a click. */
const CLICK_TOLERANCE_PX = 4

/** The workflow run status label key. */
function workflowStatusKey(status: TasksWorkflowNode['run']['status']): CopyKey {
  switch (status) {
    case 'running': return 'workflowRunning'
    case 'completed': return 'workflowCompleted'
    case 'cancelled': return 'workflowCancelled'
    case 'failed': return 'workflowFailed'
  }
}

/** The member tally of a run (`done` = every member with an outcome). */
function memberTally(run: TasksWorkflowNode['run']): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const phase of run.phases) {
    for (const member of phase.members) {
      total += 1
      if (member.outcome !== undefined) done += 1
    }
  }
  return { done, total }
}

/** One phase frame of a run node (the dashed box behind its members). */
interface PhaseFrame {
  key: string
  title: string | undefined
  x: number
  y: number
  w: number
  h: number
}

export interface TasksGraphProps {
  nodes: readonly TasksNode[]
  folded: boolean
  /** Re-fit trigger: the topology root id (a tree switch re-centers). */
  rootId: string | undefined
  onActivate(node: TasksAgentNode): void
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}

/** The shared view-mode toggle button (also used by the tree mode). */
export function ViewModeToggle(props: {
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
}): ReactNode {
  const { mode, onModeChange } = props
  const toTree = mode === 'graph'
  return (
    <button
      type="button"
      className={css.controlBtn}
      aria-label={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      title={t(toTree ? 'tasksViewSwitchToTree' : 'tasksViewSwitchToGraph')}
      onClick={() => { onModeChange(toTree ? 'tree' : 'graph') }}
    >
      {toTree ? '☰' : '⌗'}
    </button>
  )
}

/** The fold toggle button (shared by both modes). */
export function FoldToggleButton(props: { folded: boolean; onToggleFold(): void }): ReactNode {
  const { folded, onToggleFold } = props
  return (
    <button
      type="button"
      className={clsx(css.controlBtn, folded && css.controlBtnActive)}
      aria-pressed={folded}
      aria-label={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      title={t(folded ? 'tasksFoldExpand' : 'tasksFoldCollapse')}
      onClick={onToggleFold}
    >
      <span
        aria-hidden="true"
        style={{ display: 'inline-flex', transform: folded ? 'rotate(90deg)' : 'rotate(180deg)' }}
      >
        <IconChevronUpOutline14 size={12} />
      </span>
    </button>
  )
}

export function TasksGraph(props: TasksGraphProps): ReactNode {
  const { nodes, folded, rootId, onActivate, onNodeInfo, onWorkflowInfo, onToggleFold, mode, onModeChange } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 })
  const [dragging, setDragging] = useState(false)
  /** Pointer travel of the in-flight gesture (click suppression). */
  const travelRef = useRef(0)
  const tfRef = useRef(tf)
  tfRef.current = tf

  const layout = useMemo(() => layoutTasksGraph(nodes), [nodes])
  const edges = useMemo(() => tasksEdges(nodes), [nodes])
  const nodeById = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])

  /** Fit the whole canvas into the container (initial mount + ⌂ + reroot). */
  const fit = useCallback((): void => {
    const container = containerRef.current
    if (container === null) return
    const cw = container.clientWidth
    const ch = container.clientHeight
    if (cw === 0 || ch === 0) return
    const k = Math.min((cw - 40) / layout.width, (ch - 40) / layout.height, 1)
    setTf({ x: (cw - layout.width * k) / 2, y: 12, k })
  }, [layout.width, layout.height])

  useLayoutEffect(() => { fit() }, [fit, rootId])

  // Wheel-zoom to cursor (non-passive: the page must not scroll).
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const { x, y, k } = tfRef.current
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * Math.exp(-event.deltaY * 0.0014)))
      if (next === k) return
      setTf({
        x: mx - (mx - x) * (next / k),
        y: my - (my - y) * (next / k),
        k: next,
      })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => { container.removeEventListener('wheel', onWheel) }
  }, [])

  const zoomBy = useCallback((factor: number): void => {
    const container = containerRef.current
    const { x, y, k } = tfRef.current
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k * factor))
    if (next === k || container === null) return
    const mx = container.clientWidth / 2
    const my = container.clientHeight / 2
    setTf({ x: mx - (mx - x) * (next / k), y: my - (my - y) * (next / k), k: next })
  }, [])

  // Drag-pan: pointer capture on the container, any start point pans.
  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    travelRef.current = 0
    const startX = event.clientX
    const startY = event.clientY
    const { x, y } = tfRef.current
    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const onMove = (move: globalThis.PointerEvent): void => {
      const dx = move.clientX - startX
      const dy = move.clientY - startY
      travelRef.current = Math.max(travelRef.current, Math.abs(dx) + Math.abs(dy))
      setTf(current => ({ ...current, x: x + dx, y: y + dy }))
      if (travelRef.current > CLICK_TOLERANCE_PX) setDragging(true)
    }
    const onUp = (): void => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
      setDragging(false)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }, [])

  /** Suppress node clicks that ended a drag gesture. */
  const clickAllowed = useCallback((): boolean => travelRef.current <= CLICK_TOLERANCE_PX, [])

  // Phase frames: group each run's members by phase and box them.
  const phaseFrames = useMemo((): PhaseFrame[] => {
    const frames: PhaseFrame[] = []
    for (const node of nodes) {
      if (node.kind !== 'workflow') continue
      const runNode = node
      runNode.run.phases.forEach((phase, phaseIndex) => {
        const boxes: GraphBox[] = []
        for (const member of phase.members) {
          const id = member.childId !== '' ? member.childId : `wfmember:${runNode.run.runId}:${member.seq}`
          const box = layout.boxes.get(id)
          if (box !== undefined) boxes.push(box)
        }
        if (boxes.length === 0) return
        const x1 = Math.min(...boxes.map(box => box.x)) - 12
        const y1 = Math.min(...boxes.map(box => box.y)) - 22
        const x2 = Math.max(...boxes.map(box => box.x + box.w)) + 12
        const y2 = Math.max(...boxes.map(box => box.y + box.h)) + 12
        frames.push({
          key: `${runNode.id}:${phaseIndex}`,
          title: phase.title,
          x: x1, y: y1, w: x2 - x1, h: y2 - y1,
        })
      })
    }
    return frames
  }, [nodes, layout])

  /** The bezier edge path between two boxes (top-down). */
  const edgePath = (from: GraphBox, to: GraphBox): string => {
    const x1 = from.x + from.w / 2
    const y1 = from.y + from.h
    const x2 = to.x + to.w / 2
    const y2 = to.y
    const midY = (y1 + y2) / 2
    return `M ${x1} ${y1} C ${x1} ${midY} ${x2} ${midY} ${x2} ${y2}`
  }

  return (
    <div className={css.graphView}>
      <div
        ref={containerRef}
        className={clsx(css.canvas, dragging && css.canvasDragging)}
        role="group"
        aria-label={t('tasksViewGraph')}
        onPointerDown={onPointerDown}
      >
        <div
          className={css.canvasInner}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.k})`,
          }}
        >
          <svg className={css.edges} width={layout.width} height={layout.height} aria-hidden="true">
            {edges.map((edge) => {
              const from = layout.boxes.get(edge.from)
              const to = layout.boxes.get(edge.to)
              if (from === undefined || to === undefined) return null
              const target = nodeById.get(edge.to)
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  className={clsx(
                    css.edge,
                    (edge.kind === 'team' || edge.kind === 'workflow') && css.edgeTeam,
                    target?.kind === 'fold' && css.edgeFold,
                  )}
                  d={edgePath(from, to)}
                />
              )
            })}
          </svg>
          {phaseFrames.map(frame => (
            <div
              key={frame.key}
              className={css.phaseFrame}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            >
              <span className={css.phaseLabel}>{frame.title ?? t('workflowPhaseUnnamed')}</span>
            </div>
          ))}
          {nodes.map((node) => {
            const box = layout.boxes.get(node.id)
            if (box === undefined) return null
            const style = { left: box.x, top: box.y, width: GRAPH_NODE_W, minHeight: box.h }
            if (node.kind === 'fold') return renderFoldNode(node, style, onToggleFold, clickAllowed)
            if (node.kind === 'workflow') {
              return renderWorkflowNode(node, style, onWorkflowInfo, clickAllowed)
            }
            return renderAgentNode(node, style, onActivate, onNodeInfo, clickAllowed)
          })}
        </div>
      </div>
      <div className={css.controls}>
        <ViewModeToggle mode={mode} onModeChange={onModeChange} />
        <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
        <button
          type="button"
          className={css.controlBtn}
          aria-label={t('tasksZoomOut')}
          title={t('tasksZoomOut')}
          onClick={() => { zoomBy(1 / 1.25) }}
        >
          −
        </button>
        <button
          type="button"
          className={clsx(css.controlBtn, css.controlPct)}
          aria-label={t('tasksZoomFit')}
          title={t('tasksZoomFit')}
          onClick={fit}
        >
          {Math.round(tf.k * 100)}%
        </button>
        <button
          type="button"
          className={css.controlBtn}
          aria-label={t('tasksZoomIn')}
          title={t('tasksZoomIn')}
          onClick={() => { zoomBy(1.25) }}
        >
          +
        </button>
      </div>
    </div>
  )
}

/** One agent node card. */
function renderAgentNode(
  node: TasksAgentNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onActivate: (node: TasksAgentNode) => void,
  onNodeInfo: (node: TasksAgentNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  return (
    <div
      key={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${node.label} ${agentSecondary(node)}`}
      aria-current={node.current ? 'true' : undefined}
      className={clsx(
        css.node,
        node.state === 'running' && css.nodeRunning,
        node.state === 'done' && css.nodeDone,
        node.state === 'error' && css.nodeError,
        node.current && css.nodeCurrent,
      )}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onActivate(node)
        void event
      }}
    >
      <span className={css.nodeHeader}>
        <StateDot state={nodeDotState(node.state)} size={8} className={css.nodeDot} />
        <span className={css.nodeTitle} title={node.label}>{node.label}</span>
      </span>
      <span className={css.nodeSecondary} title={agentSecondary(node)}>{agentSecondary(node)}</span>
      {node.state === 'running' && <LiveLine live={node.live} />}
      <button
        type="button"
        className={css.nodeInfo}
        aria-label={t('tasksNodeState')}
        title={t('tasksNodeState')}
        onClick={(event) => {
          event.stopPropagation()
          onNodeInfo(node, event.currentTarget)
        }}
      >
        ⓘ
      </button>
    </div>
  )
}

/** One workflow run node card. */
function renderWorkflowNode(
  node: TasksWorkflowNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onWorkflowInfo: (node: TasksWorkflowNode, anchor: HTMLElement) => void,
  clickAllowed: () => boolean,
): ReactNode {
  const tally = memberTally(node.run)
  return (
    <div
      key={node.id}
      role="button"
      tabIndex={-1}
      aria-label={node.run.name}
      className={clsx(css.node, css.nodeWorkflow, node.run.status === 'running' && css.nodeRunning)}
      style={style}
      onClick={(event) => {
        if (!clickAllowed()) return
        onWorkflowInfo(node, event.currentTarget)
      }}
    >
      <span className={css.nodeHeader}>
        <span aria-hidden="true">▶</span>
        <span className={css.nodeTitle} title={node.run.name}>{node.run.name}</span>
      </span>
      <span className={css.nodeSecondary}>
        {`${t(workflowStatusKey(node.run.status))} · ${t('workflowMembers', { done: tally.done, total: tally.total })}`}
      </span>
    </div>
  )
}

/** One fold aggregate node. */
function renderFoldNode(
  node: TasksFoldNode,
  style: { left: number; top: number; width: number; minHeight: number },
  onToggleFold: () => void,
  clickAllowed: () => boolean,
): ReactNode {
  return (
    <div
      key={node.id}
      role="button"
      tabIndex={-1}
      aria-label={`${t('tasksFoldCompleted', { count: node.count })} · ${t('tasksFoldExpand')}`}
      className={clsx(css.node, css.nodeFold)}
      style={style}
      onClick={() => {
        if (!clickAllowed()) return
        onToggleFold()
      }}
    >
      <span className={css.nodeTitle}>{t('tasksFoldCompleted', { count: node.count })}</span>
      <span className={css.nodeSecondary}>{foldPreviews(node.previews)}</span>
    </div>
  )
}

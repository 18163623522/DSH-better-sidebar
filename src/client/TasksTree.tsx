/**
 * The tree mode of the Tasks page: the SAME unified model rendered as a
 * classic indentation tree (keyboard navigable, the official catalog's
 * arrow-key recipe). Fold aggregates are rows; workflow runs are group rows
 * whose members indent one level deeper. The control cluster (view toggle +
 * fold toggle) stays visible bottom-right — the mockup's lesson.
 */
import { useCallback, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TasksAgentNode, TasksNode, TasksWorkflowNode } from './tasks-model.ts'
import { agentSecondary, foldPreviews, LiveLine, nodeDotState } from './tasks-shared.tsx'
import { FoldToggleButton, ViewModeToggle } from './TasksGraph.tsx'
import { t, type CopyKey } from './locales.ts'
import css from './tasks-graph.module.css'
import legacy from './SubagentView.module.css'

/** Pixels of indentation per depth level (the classic tree's rhythm). */
const INDENT_PX = 18

/** The workflow run status label key. */
function workflowStatusKey(status: TasksWorkflowNode['run']['status']): CopyKey {
  switch (status) {
    case 'running': return 'workflowRunning'
    case 'completed': return 'workflowCompleted'
    case 'cancelled': return 'workflowCancelled'
    case 'failed': return 'workflowFailed'
  }
}

export interface TasksTreeProps {
  nodes: readonly TasksNode[]
  folded: boolean
  onActivate(node: TasksAgentNode): void
  onNodeInfo(node: TasksAgentNode, anchor: HTMLElement): void
  onWorkflowInfo(node: TasksWorkflowNode, anchor: HTMLElement): void
  onToggleFold(): void
  mode: 'graph' | 'tree'
  onModeChange(mode: 'graph' | 'tree'): void
  /** Fallback loading rows while the root catalog hydrates. */
  loading?: boolean
}

export function TasksTree(props: TasksTreeProps): ReactNode {
  const {
    nodes, folded, onActivate, onNodeInfo, onWorkflowInfo, onToggleFold, mode, onModeChange, loading,
  } = props
  const bodyRef = useRef<HTMLDivElement>(null)

  /** Depth of every node (roots at 0), derived from the parent chain. */
  const depthById = useMemo(() => {
    const byId = new Map(nodes.map(node => [node.id, node]))
    const depths = new Map<string, number>()
    const depthOf = (node: TasksNode, guard: number): number => {
      const known = depths.get(node.id)
      if (known !== undefined) return known
      if (node.parentId === undefined || guard > 64) {
        depths.set(node.id, 0)
        return 0
      }
      const parent = byId.get(node.parentId)
      const depth = parent === undefined ? 0 : depthOf(parent, guard + 1) + 1
      depths.set(node.id, depth)
      return depth
    }
    for (const node of nodes) depthOf(node, 0)
    return depths
  }, [nodes])

  /** Arrow-key navigation over the visible rows (official catalog recipe). */
  const focusAt = useCallback((index: number): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-tasks-row]') ?? []
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }, [])
  const onTreeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-tasks-row]') ?? []
    const index = Array.prototype.indexOf.call(items, document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    }
  }, [focusAt])

  const activateOnKey = (event: KeyboardEvent, action: () => void): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  return (
    <div className={css.graphView}>
      <div
        ref={bodyRef}
        className={css.treeView}
        role="tree"
        aria-label={t('subagent')}
        onKeyDown={onTreeKeyDown}
      >
        {loading === true && (
          <div className={legacy.subagentEmpty}>{t('loading')}</div>
        )}
        {nodes.map((node) => {
          const depth = depthById.get(node.id) ?? 0
          const indent = { marginLeft: depth * INDENT_PX }
          if (node.kind === 'fold') {
            return (
              <div
                key={node.id}
                data-tasks-row
                role="treeitem"
                tabIndex={0}
                aria-level={depth + 1}
                aria-label={t('tasksFoldExpand')}
                className={clsx(css.treeRow, css.treeFold)}
                style={indent}
                onClick={onToggleFold}
                onKeyDown={(event) => { activateOnKey(event, onToggleFold) }}
              >
                <span className={css.treeContent}>
                  <span className={css.nodeTitle}>{t('tasksFoldCompleted', { count: node.count })}</span>
                  <span className={css.nodeSecondary}>{foldPreviews(node.previews)}</span>
                </span>
              </div>
            )
          }
          if (node.kind === 'workflow') {
            const done = node.run.phases.reduce(
              (sum, phase) => sum + phase.members.filter(member => member.outcome !== undefined).length,
              0,
            )
            const total = node.run.phases.reduce((sum, phase) => sum + phase.members.length, 0)
            return (
              <div
                key={node.id}
                data-tasks-row
                role="treeitem"
                tabIndex={0}
                aria-level={depth + 1}
                aria-expanded="true"
                aria-label={node.run.name}
                className={css.treeRow}
                style={indent}
                onClick={(event) => { onWorkflowInfo(node, event.currentTarget) }}
                onKeyDown={(event) => {
                  activateOnKey(event, () => { onWorkflowInfo(node, event.currentTarget as HTMLElement) })
                }}
              >
                <span aria-hidden="true">▶</span>
                <span className={css.treeContent}>
                  <span className={css.nodeTitle}>{node.run.name}</span>
                  <span className={css.nodeSecondary}>
                    {`${t(workflowStatusKey(node.run.status))} · ${t('workflowMembers', { done, total })}`}
                  </span>
                </span>
              </div>
            )
          }
          return (
            <div
              key={node.id}
              data-tasks-row
              role="treeitem"
              tabIndex={0}
              aria-level={depth + 1}
              aria-label={`${node.label} ${agentSecondary(node)}`}
              aria-current={node.current ? 'true' : undefined}
              className={clsx(
                css.treeRow,
                node.current && css.treeRowActive,
                node.state === 'done' && css.treeRowDone,
              )}
              style={indent}
              onClick={() => { onActivate(node) }}
              onKeyDown={(event) => { activateOnKey(event, () => { onActivate(node) }) }}
            >
              <StateDot state={nodeDotState(node.state)} className={legacy.subagentDot} />
              <span className={css.treeContent}>
                <span className={css.nodeTitle}>{node.label}</span>
                <span className={css.nodeSecondary}>{agentSecondary(node)}</span>
                {node.state === 'running' && <LiveLine live={node.live} />}
              </span>
              <button
                type="button"
                className={css.treeInfo}
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
        })}
      </div>
      <div className={css.controls}>
        <ViewModeToggle mode={mode} onModeChange={onModeChange} />
        <FoldToggleButton folded={folded} onToggleFold={onToggleFold} />
      </div>
    </div>
  )
}

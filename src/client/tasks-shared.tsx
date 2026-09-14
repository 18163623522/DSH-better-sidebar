/**
 * Shared presentation bits of the Tasks page's two modes (graph + tree):
 * the state-dot mapping, the secondary card line, the iconified live
 * activity row ("glyph + tool + args" — the user-approved format replacing
 * the old `>read[file]` text), and the fold aggregate caption. Kept in one
 * module so graph and tree can never drift apart visually.
 */
import type { ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LastActivity } from '../subagent-activity.ts'
import type { TasksAgentNode, TasksNodeState } from './tasks-model.ts'
import { toolGlyph } from './tool-icons.tsx'
import { t } from './locales.ts'
import css from './tasks-graph.module.css'

/** Preview cap of one tool-call argument line. */
const ARGS_PREVIEW = 60

/** The host StateDot semantic of a node display state. */
export function nodeDotState(state: TasksNodeState): StateDotState {
  switch (state) {
    case 'running': return 'ongoing'
    case 'idle': return 'idle'
    case 'done': return 'done'
    case 'error': return 'error'
  }
}

/** First `limit` characters with an ellipsis when truncated. */
export function preview(text: string, limit: number = ARGS_PREVIEW): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Collapse whitespace for single-line previews. */
export function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The secondary line of an agent node: display title (when it differs from
 * the durable label) · mode · activity · teammate model. Empty parts drop
 * out. Synthesized workflow members show their origin instead of a mode.
 */
export function agentSecondary(node: TasksAgentNode): string {
  const parts: string[] = []
  if (node.title !== undefined && node.title !== node.label) parts.push(node.title)
  if (node.mode !== undefined) {
    parts.push(node.mode === 'one-shot' ? t('subagentModeOneShot') : t('subagentModeContinuable'))
  } else if (node.synthesized === true) {
    parts.push(t('tasksWorkflowMember'))
  }
  parts.push(node.activity === 'running' ? t('subagentRunning') : t('subagentInactive'))
  if (node.team?.model !== undefined) parts.push(node.team.model)
  return parts.join(' · ')
}

/**
 * The live activity row of a RUNNING agent node: the tool line renders as
 * "glyph + tool + args" (the approved live-line format), plus the flattened
 * last text line underneath. A running node with neither reads "thinking…".
 */
export function LiveLine(props: { live: LastActivity | undefined }): ReactNode {
  const { live } = props
  if (live?.text === undefined && live?.tool === undefined) {
    return <span className={css.liveLine}>{t('subagentThinking')}</span>
  }
  return (
    <>
      {live.tool !== undefined && (
        <span className={css.liveLine}>
          <span className={css.liveGlyph} aria-hidden="true">{toolGlyph(live.tool.name)(10)}</span>
          <span className={css.liveTool}>{live.tool.name}</span>
          {live.tool.args !== '' && (
            <span className={css.liveArgs}>{preview(live.tool.args)}</span>
          )}
        </span>
      )}
      {live.text !== undefined && (
        <span className={css.liveText}>{flatten(live.text)}</span>
      )}
    </>
  )
}

/** The fold aggregate's subtitle: up to two label previews joined by ·. */
export function foldPreviews(previews: readonly string[]): string {
  return previews.join(' · ')
}

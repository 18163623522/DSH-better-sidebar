/**
 * The ONE task window: view, edit and create all live here, and every task
 * surface (the board's rows, an agent node's task line, the node detail
 * popover) opens THIS component — pointer targets stay thin, the window owns
 * the behaviour.
 *
 * Shape: a non-fullscreen, DRAGGABLE card (never a modal dialog). Details
 * render as multi-line MARKDOWN by default; 编辑 switches the same card into
 * multi-line editing, so reading and writing never jump between surfaces.
 * Actions: owner reassignment (CAS-immediate), edit/save, reopen or complete,
 * and a two-step delete.
 *
 * Visual base: the vendored shadcn/ui set, composed the way the registry
 * intends — the full `Card` (header + title + action slot + content + footer),
 * the task itself as an `Item` slab, the editable half as a `FieldGroup` of
 * `Field` rows (`FieldLabel` + control + `FieldDescription`), the owner picker
 * as a `ToggleGroup`, status as a stock `Badge` variant and every action a
 * stock `Button` variant (the armed delete takes the `destructive` variant
 * instead of a hand-painted red outline). Colours and type therefore come from
 * the components and the semantic tokens; `className` stays layout.
 *
 * Three resets ride the card root on purpose: the window paints NO surface of
 * its own. It is portaled to `document.body`, where `AnchoredPopover` owns the
 * floating border/radius/shadow, so `border-0 bg-transparent shadow-none` let
 * that shell's surface show through instead of nesting a second, shadowed card
 * inside it (the page's "static panels cast no shadow" rule).
 *
 * That portal also sits OUTSIDE the task page root, so the card re-declares
 * the page root class (`dsw-tasks`) to pick up the scoped base reset the
 * plugin ships instead of preflight — box-sizing and form-control font
 * inheritance; without preflight a bare `<button>`/`<textarea>` would render
 * in the UA's own font.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  IconCheckOutline14, IconCloseOutline16, IconEditOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16, MarkdownText, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarTeamMemberView, SidebarTeamTaskView } from '../context-types.ts'
import { api } from './api.ts'
import { markdownTextProps } from './markdown-labels.tsx'
import { AnchoredPopover } from './AnchoredPopover.tsx'
import { t, type CopyKey } from './locales.ts'
import { Badge } from './ui/badge.tsx'
import { Button } from './ui/button.tsx'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card.tsx'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from './ui/field.tsx'
import { Input } from './ui/input.tsx'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from './ui/item.tsx'
import { Separator } from './ui/separator.tsx'
import { Textarea } from './ui/textarea.tsx'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group.tsx'
import { cn } from './ui/utils.ts'

/** One mutation outcome (the host route's own union). */
type MutationResult = { ok: true } | { ok: false; error: { code: string; message: string } }

/** The task status label key. */
function taskStatusKey(status: SidebarTeamTaskView['status']): CopyKey {
  switch (status) {
    case 'pending': return 'teamTaskPending'
    case 'in_progress': return 'teamTaskInProgress'
    case 'completed': return 'teamTaskCompleted'
    case 'deleted': return 'teamTaskDeleted'
  }
}

/**
 * The status badge's stock variant: in progress takes `default` (the accent),
 * everything else settles on `secondary`; a BLOCKED task wears `outline` with
 * warning ink — hue carries meaning only, and readiness outranks the status
 * word (the board row maps it the same way).
 */
function statusVariant(task: SidebarTeamTaskView): 'default' | 'secondary' | 'outline' {
  if (task.status === 'in_progress' && task.ready) return 'default'
  if (!task.ready) return 'outline'
  return 'secondary'
}

/** The blocked badge's warning ink (the `outline` variant is otherwise neutral). */
function statusTone(task: SidebarTeamTaskView): string {
  return task.ready ? '' : 'text-warning'
}

/**
 * The plugin's own multi-line input: the host primitive set ships no
 * textarea, so this is OUR component (token-styled, drag-exempt) and every
 * multi-line edit in the page goes through it. The surface is the vendored
 * shadcn `Textarea`; `rows` keeps the caller's height contract and the
 * content-driven growth is capped so a long body cannot outgrow the viewport.
 */
export function MultilineField(props: {
  value: string
  label: string
  placeholder?: string
  rows?: number
  onChange?(next: string): void
}): ReactNode {
  return (
    <Textarea
      className="max-h-[45vh] min-h-[120px] resize-y"
      value={props.value}
      rows={props.rows ?? 7}
      placeholder={props.placeholder}
      aria-label={props.label}
      data-popover-no-drag
      onChange={(event) => { props.onChange?.(event.target.value) }}
    />
  )
}

/**
 * The unowned option's sentinel value: Radix reads an EMPTY string as "nothing
 * is selected" (`value ? [value] : []`), so `''` could never render pressed —
 * and the unowned chip must be visibly the active one on an unowned task.
 */
const UNOWNED = '__unowned__'

/**
 * The owner picker (single-select toggles; CAS-immediate, so never a draft
 * field). The chips are the toggle's DEFAULT variant, the same one the board's
 * owner filter uses: its own state pair separates hover (accent tint, meta ink)
 * from pressed (accent tint, full ink) without help. That is not true of the
 * `outline` variant — its hover rules outrank the base ones, so hover and
 * pressed would look exactly alike and the picked owner would be invisible.
 */
export function OwnerPicker(props: {
  members: readonly SidebarTeamMemberView[]
  owner: string | undefined
  disabled: boolean
  onPick(owner: string): void
}): ReactNode {
  return (
    <ToggleGroup
      type="single"
      value={props.owner ?? UNOWNED}
      disabled={props.disabled}
      spacing={1}
      aria-label={t('teamTaskOwner')}
      className="flex-wrap"
      onValueChange={(next) => {
        // '' is Radix's deselect of the pressed chip (the reader re-clicked the
        // current owner): the old pill row re-sent the same owner, i.e. no
        // mutation — the window never unassigns behind a re-click.
        if (next === '') return
        props.onPick(next === UNOWNED ? '' : next)
      }}
    >
      <ToggleGroupItem value={UNOWNED} size="sm">
        {t('teamTaskUnowned')}
      </ToggleGroupItem>
      {props.members.map(member => (
        <ToggleGroupItem key={member.id} value={member.name} size="sm">
          {member.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** The read-only body: the task slab, the markdown description, the owner picker. */
function TaskViewBody(props: {
  task: SidebarTeamTaskView
  teammates: readonly SidebarTeamMemberView[]
  busy: boolean
  onReassign(owner: string): void
}): ReactNode {
  const { task } = props
  const body = task.description.trim()
  return (
    <FieldGroup className="gap-4">
      {/* The task's own slab: an `Item` is the registry's row primitive, so the
          subject leads, the owner / blocker meta follows as its description and
          the status rides the trailing action slot. */}
      <Item variant="muted" size="sm" className="min-w-0 flex-nowrap gap-2 px-2 py-1.5">
        <ItemMedia>
          <StateDot
            size={6}
            state={task.status === 'completed' ? 'done' : task.ready ? 'ongoing' : 'warning'}
          />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full min-w-0">
            <span className="min-w-0 flex-1 truncate" title={task.subject}>{task.subject}</span>
          </ItemTitle>
          {/* The meta line keeps the page's three ink levels: the labels are a
              step quieter than the values, and ids stay mono. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="text-foreground-3">{t('teamTaskOwner')}</span>
            <span>{task.ownerName ?? t('teamTaskUnowned')}</span>
            {task.blockedBy.length > 0 && (
              <>
                <span className="text-foreground-3">{t('teamTaskBlockedBy')}</span>
                <span className="font-mono tabular-nums">{task.blockedBy.join(' · ')}</span>
              </>
            )}
          </span>
        </ItemContent>
        <ItemActions>
          <Badge variant={statusVariant(task)} className={cn('flex-none', statusTone(task))}>
            {t(task.ready ? taskStatusKey(task.status) : 'teamTaskBlocked')}
          </Badge>
        </ItemActions>
      </Item>

      {/* The description is READ-ONLY here (the markdown preview is the point of
          the view mode); 编辑 is what turns it into the multi-line editor. */}
      <Field>
        <FieldTitle>{t('teamTaskDescription')}</FieldTitle>
        {body === ''
          ? <FieldDescription>{t('teamTaskNoDescription')}</FieldDescription>
          : (
            <div className="max-h-[260px] overflow-y-auto">
              <MarkdownText
                {...markdownTextProps(body, { copyLabel: t('copy'), copiedLabel: t('copied') })}
              />
            </div>
          )}
      </Field>

      <Field data-disabled={props.busy ? true : undefined}>
        <FieldLabel>{t('teamTaskOwner')}</FieldLabel>
        <OwnerPicker
          members={props.teammates}
          owner={task.ownerName}
          disabled={props.busy}
          onPick={props.onReassign}
        />
      </Field>
    </FieldGroup>
  )
}

/**
 * The editing body: subject (a stock `Input`) and description (our multi-line
 * field) as two `Field` rows. A BLANK subject is the form's only invalid state
 * — it is reported on the `Field` (`data-invalid`) and the control
 * (`aria-invalid`) once the reader has been in the field, and Save stays
 * disabled until it is filled.
 *
 * The one-line input carries its hint as a `FieldDescription` (a placeholder
 * would vanish the moment the reader focuses it); the tall textarea keeps its
 * hint inside the field, where there is room for it.
 */
function TaskEditBody(props: {
  subject: string
  description: string
  invalid: boolean
  onSubject(next: string): void
  onDescription(next: string): void
}): ReactNode {
  const subjectId = useId()
  const subjectHintId = useId()
  return (
    <FieldGroup className="gap-4" data-popover-no-drag>
      <Field data-invalid={props.invalid ? true : undefined}>
        <FieldLabel htmlFor={subjectId}>{t('teamTaskSubject')}</FieldLabel>
        <Input
          id={subjectId}
          value={props.subject}
          aria-label={t('teamTaskSubject')}
          aria-invalid={props.invalid ? true : undefined}
          aria-describedby={subjectHintId}
          onChange={(event) => { props.onSubject(event.target.value) }}
        />
        <FieldDescription id={subjectHintId}>{t('teamTaskSubjectPlaceholder')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>{t('teamTaskDescription')}</FieldLabel>
        <MultilineField
          value={props.description}
          label={t('teamTaskDescription')}
          placeholder={t('teamTaskDescriptionPlaceholder')}
          onChange={props.onDescription}
        />
      </Field>
    </FieldGroup>
  )
}

export interface TaskWindowProps {
  rootId: string
  /** The task under view/edit; undefined = create mode. */
  task: SidebarTeamTaskView | undefined
  members: readonly SidebarTeamMemberView[]
  /** Re-pull `teams.view` after a mutation (the parent owns the poller). */
  onChanged(): void
  /** Close the window (the caller's popover state). */
  onClose(): void
}

/** The task window content (the caller supplies the popover shell). */
export function TaskWindow(props: TaskWindowProps): ReactNode {
  const { rootId, task, members, onChanged, onClose } = props
  const creating = task === undefined
  const [editing, setEditing] = useState(creating)
  const [subject, setSubject] = useState(task?.subject ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  /** The reader has been in the subject field (see TaskEditBody's contract). */
  const [subjectTouched, setSubjectTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | undefined>(undefined)
  const [armedDelete, setArmedDelete] = useState(false)

  // Re-seed the draft when the caller swaps the subject task: the poller
  // hands us fresh revisions, and unsaved text must not leak across tasks.
  // Keyed by id on purpose — a same-id revision bump must NOT clobber the
  // reader's in-flight edit (the seed rides a render-time ref so the effect
  // depends on the id alone).
  const seedRef = useRef({
    subject: task?.subject ?? '',
    description: task?.description ?? '',
    creating: task === undefined,
  })
  seedRef.current = {
    subject: task?.subject ?? '',
    description: task?.description ?? '',
    creating: task === undefined,
  }
  useEffect(() => {
    const seed = seedRef.current
    setSubject(seed.subject)
    setDescription(seed.description)
    setSubjectTouched(false)
    setEditing(seed.creating)
  }, [task?.id])

  const teammates = members.filter(member => member.role === 'teammate')

  /** Run one CAS mutation with the shared busy/conflict handling. */
  const mutate = async (
    action: () => Promise<MutationResult>,
    options: { close?: boolean } = {},
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote(undefined)
    try {
      const result = await action()
      if (!result.ok) {
        setNote(result.error.code === 'team-task-conflict'
          ? t('teamTaskConflict')
          : t('teamTaskError', { message: result.error.message }))
      } else {
        if (options.close === true) onClose()
        else setEditing(false)
      }
      onChanged()
    } catch (error) {
      setNote(t('teamTaskError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  /** Save the draft (create closes the window; edit returns to the view). */
  const save = (): void => {
    const nextSubject = subject.trim()
    if (nextSubject === '') return
    void mutate(() => (creating
      ? api.teamsTaskCreate(rootId, { subject: nextSubject, description: description.trim() })
      : api.teamsTaskUpdate(rootId, {
        taskId: task.id,
        expectedRevision: task.revision,
        action: 'edit',
        subject: nextSubject,
        description: description.trim(),
      })), { close: creating })
  }

  /** Reassign the task (or return it to the unowned pool). */
  const reassign = (owner: string): void => {
    if (task === undefined || busy) return
    void mutate(() => api.teamsTaskUpdate(rootId, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      ...(owner === '' ? {} : { owner }),
    }))
  }

  return (
    <Card
      className="dsw-tasks box-border gap-0 rounded-lg border-0 bg-transparent py-0 shadow-none"
      data-popover-handle
    >
      <CardHeader className="items-center px-4 py-3">
        <CardTitle className="min-w-0 truncate">
          {creating ? t('teamTaskCreate') : editing ? t('teamTaskEdit') : t('teamTaskDetail')}
        </CardTitle>
        <CardAction data-popover-no-drag>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('teamTaskCancel')}
            title={t('teamTaskCancel')}
            onClick={onClose}
          >
            <IconCloseOutline16 />
          </Button>
        </CardAction>
      </CardHeader>
      <Separator />

      <CardContent className="px-4 py-3">
        {editing || task === undefined
          ? (
            <TaskEditBody
              subject={subject}
              description={description}
              invalid={subjectTouched && subject.trim() === ''}
              onSubject={(next) => { setSubjectTouched(true); setSubject(next) }}
              onDescription={setDescription}
            />
          )
          : (
            <TaskViewBody
              task={task}
              teammates={teammates}
              busy={busy}
              onReassign={reassign}
            />
          )}
        {/* The mutation outcome (CAS conflict / failure) is the form's own
            alert: FieldError carries the role and the destructive ink. */}
        {note !== undefined && <FieldError className="mt-2">{note}</FieldError>}
      </CardContent>

      <Separator />
      <CardFooter className="flex-wrap justify-end gap-1.5 px-4 py-3" data-popover-no-drag>
        {editing
          ? (
            <>
              <Button
                size="sm"
                disabled={busy || subject.trim() === ''}
                onClick={save}
              >
                <IconCheckOutline14 />
                {creating ? t('teamTaskCreate') : t('teamTaskSave')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (creating) onClose()
                  else if (task !== undefined) {
                    setSubject(task.subject)
                    setDescription(task.description)
                    setSubjectTouched(false)
                    setEditing(false)
                  }
                }}
              >
                {t('teamTaskCancel')}
              </Button>
            </>
          )
          : task === undefined ? null : (
            <>
              <Button variant="outline" size="sm" onClick={() => { setEditing(true) }}>
                <IconEditOutline16 />
                {t('teamTaskEdit')}
              </Button>
              {task.status === 'completed'
                ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'reopen',
                    }))}
                  >
                    <IconRefreshOutline14 />
                    {t('teamTaskReopen')}
                  </Button>
                )
                : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void mutate(() => api.teamsTaskUpdate(rootId, {
                      taskId: task.id, expectedRevision: task.revision, action: 'complete',
                    }))}
                  >
                    <IconCheckOutline14 />
                    {t('teamTaskComplete')}
                  </Button>
                )}
              <Button
                // Two-step confirm: the ARMED click takes the `destructive`
                // variant (its copy already says 确认删除) — danger is a
                // component variant, never a permanently red button and never a
                // hand-painted outline.
                variant={armedDelete ? 'destructive' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (!armedDelete) { setArmedDelete(true); return }
                  setArmedDelete(false)
                  void mutate(() => api.teamsTaskUpdate(rootId, {
                    taskId: task.id, expectedRevision: task.revision, action: 'delete',
                  }), { close: true })
                }}
              >
                <IconTrashOutline16 />
                {armedDelete ? t('teamTaskDeleteConfirm') : t('teamTaskDelete')}
              </Button>
            </>
          )}
      </CardFooter>
    </Card>
  )
}

/**
 * The task window inside its draggable popover shell — the single entry point
 * every task surface uses (board row, node task line, node detail list).
 */
export function TaskPopover(props: TaskWindowProps & { anchor: HTMLElement | null }): ReactNode {
  const { anchor, onClose, ...windowProps } = props
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} draggable width={430}>
      {anchor === null ? null : <TaskWindow {...windowProps} onClose={onClose} />}
    </AnchoredPopover>
  )
}

/** The create affordance every surface shares. */
export function TaskCreateButton(props: {
  disabled?: boolean
  onClick(anchor: HTMLElement): void
}): ReactNode {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={props.disabled}
      onClick={(event) => { props.onClick(event.currentTarget) }}
    >
      <IconPlusOutline16 />
      {t('teamTaskCreate')}
    </Button>
  )
}

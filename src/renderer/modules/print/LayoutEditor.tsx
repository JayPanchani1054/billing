/**
 * (2.0) "Customize what prints" — the print layout editor beside the print preview (Alt+L on Print
 * Preview; "Customize layout…" in Invoice Printing). Presentational: the model, the switches' and texts'
 * meaning and what saving writes come from lib/layoutParts.ts; the screens own the state.
 *
 *   Show tab  — the parts of this template, grouped; a switch each (Space toggles, Tab moves on), a lock
 *               for parts that always print, the GST rule of a statutory particular (amber when hidden),
 *               where the value comes from ("Hidden for all documents", "Hidden for Sales", "This print"),
 *               and "nothing to print on this document" when the part is empty here.
 *   Texts tab — one box per printed wording; the placeholder is what prints otherwise; ↺ goes back to it.
 *
 * Clicking a part in the preview opens its group and focuses its switch (`pick`). Esc in the panel returns
 * focus to the preview (`onEscape`); a second Esc leaves the screen as before. Texts are plain text.
 *
 * 2.1 (SPEC-21 §1.11): the title stays; the one-line description is for screen readers only (the panel's
 * `aria-describedby`); group captions drop the "(n of m shown)" count — "Header · 2 hidden" only when
 * something is hidden; a row's notes (GST rule, where the value comes from, "nothing to print") show for the
 * row last focused by keyboard or click-to-select, or clicked, and are otherwise visually hidden (still its
 * `aria-describedby`) — a mouse press never moves them (lib/calm.ts `activeNoteRow`), so no row slides
 * under the pointer between press and release; the parts that always print collapse to one line per group,
 * "Always printed: Invoice no., Date, …".
 */
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { PrintPartId } from '../../../shared/printLayout.ts';
import { Badge, Banner, Button, Card, Field, IconButton, Inline, ScrollArea, Stack, Switch, Tabs, TextArea, TextInput } from '../../ui/index.ts';
import { activeNoteRow, groupCaption, type NoteEvent } from './lib/calm.ts';
import type { EditorModel, EditorPartRow, EditorTextRow } from './lib/layoutParts.ts';

/** DOM id of a part's switch (click-to-select focuses it). */
export function partSwitchId(id: PrintPartId): string {
  return `bp-part-${id.replace(/\./g, '-')}`;
}

export interface LayoutEditorProps {
  model: EditorModel;
  /** Plain-language lines for hidden statutory particulars (layoutWarnings). */
  warnings: readonly string[];
  onPart: (row: EditorPartRow, shown: boolean) => void;
  onText: (row: EditorTextRow, value: string | null) => void;
  /** A part clicked in the preview; `seq` changes on every click. */
  pick: { id: PrintPartId; seq: number } | null;
  /** Esc inside the panel: give focus back to the preview. */
  onEscape: () => void;
  /** Which documents the changes apply to (2.1: read to screen readers with the panel; not shown). */
  description: ReactNode;
  /** Above the tabs (e.g. "apply the changes made earlier in this session"). */
  notice?: ReactNode;
  /** Save / reset buttons. */
  footer?: ReactNode;
  readOnly?: boolean;
  /** Focus the panel's tabs when it opens. */
  autoFocus?: boolean;
}

export function LayoutEditor({ model, warnings, onPart, onText, pick, onEscape, description, notice, footer, readOnly = false, autoFocus = true }: LayoutEditorProps) {
  const [tab, setTab] = useState<string>('show');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(model.groups.slice(0, 1).map((g) => g.id)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const descId = useId();
  // The row whose notes show, and whether a pointer button is down (a press must not move the rows).
  const [noteRow, setNoteRow] = useState<string | null>(null);
  const pointerDown = useRef(false);
  const onNote = (e: NoteEvent): void => setNoteRow((current) => activeNoteRow(current, e));
  useEffect(() => {
    const root = rootRef.current;
    const down = (): void => {
      pointerDown.current = true;
    };
    const up = (): void => {
      pointerDown.current = false;
    };
    root?.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      root?.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    // Only when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Click-to-select: open the part's group on the Show tab and focus its switch.
  useEffect(() => {
    if (!pick) return undefined;
    const group = model.groups.find((g) => g.rows.some((r) => r.id === pick.id));
    if (!group) return undefined;
    setTab('show');
    setOpen((o) => (o.has(group.id) ? o : new Set([...o, group.id])));
    const timer = window.setTimeout(() => {
      const el = document.getElementById(partSwitchId(pick.id)) ?? document.getElementById(`${partSwitchId(pick.id)}-row`);
      el?.scrollIntoView?.({ block: 'nearest' });
      el?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick?.seq]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    onEscape();
    // The preview could not take focus (nothing to scroll): leave the panel anyway, so the next Esc goes back.
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
  };

  const toggleGroup = (id: string): void =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const showTab = (
    <Stack gap={3}>
      {model.groups.map((g) => {
        const isOpen = open.has(g.id);
        const bodyId = `bp-layout-group-${g.id}`;
        const locked = g.rows.filter((r) => r.locked);
        return (
          <Stack key={g.id} gap={2}>
            <Button variant="ghost" size="sm" icon={isOpen ? 'chevron-down' : 'chevron-right'} aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggleGroup(g.id)}>
              {groupCaption(g.label, g.rows)}
            </Button>
            {isOpen ? (
              <Stack gap={2} id={bodyId}>
                {g.rows
                  .filter((r) => !r.locked)
                  .map((row) => (
                    <PartRow
                      key={row.id}
                      row={row}
                      readOnly={readOnly}
                      onPart={onPart}
                      notesShown={readOnly || noteRow === row.id}
                      onFocusRow={() => onNote({ type: 'focus', row: row.id, pointerDown: pointerDown.current })}
                      onClickRow={() => onNote({ type: 'click', row: row.id })}
                    />
                  ))}
                {locked.length > 0 ? <AlwaysPrinted rows={locked} /> : null}
              </Stack>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );

  const textsTab = (
    <Stack gap={3}>
      {model.texts.map((row) => (
        <TextRow key={row.id} row={row} readOnly={readOnly} onText={onText} />
      ))}
    </Stack>
  );

  return (
    <aside aria-label="Customize what prints" aria-describedby={descId} style={{ position: 'sticky', top: 0 }}>
      <Card title="Customize what prints" padding="sm">
        <p id={descId} className="bx-sr-only">
          {description}
        </p>
        <div
          ref={rootRef}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            // Focus left the panel (Esc to the preview, a click on the sheet): no row's notes stay out.
            const to = e.relatedTarget;
            if (to instanceof Node && !e.currentTarget.contains(to)) onNote({ type: 'leave' });
          }}
        >
          <Stack gap={3}>
            {notice}
            <ScrollArea maxHeight="calc(100vh - 300px)" shadows>
              <Tabs
                aria-label="Customize"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'show', label: 'Show', content: showTab },
                  { id: 'texts', label: 'Texts', content: textsTab },
                ]}
              />
            </ScrollArea>
            {warnings.length > 0 ? (
              <Banner tone="warning" title="Hidden details GST rules require">
                {warnings.length === 1 ? (
                  warnings[0]
                ) : (
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </Banner>
            ) : null}
            {footer}
          </Stack>
        </div>
      </Card>
    </aside>
  );
}

/** The notes of a part: its GST rule (amber "Required: …" when hidden), where its value comes from, and "nothing to print". */
function partNotes(row: EditorPartRow): ReactNode[] {
  const notes: ReactNode[] = [];
  if (row.rule) {
    notes.push(
      <Badge key="rule" size="sm" tone={row.shown ? 'neutral' : 'warning'}>
        {row.shown ? row.rule : `Required: ${row.rule}`}
      </Badge>,
    );
  }
  if (row.sourceText) notes.push(<span key="source">{row.sourceText}</span>);
  if (row.empty) notes.push(<span key="empty">(nothing to print on this document)</span>);
  return notes;
}

/** A part of the "Always printed" line in words — its tooltip and what a screen reader hears on it. */
function lockedPartText(row: EditorPartRow): string {
  return ['Always printed', row.rule, row.sourceText, row.empty ? 'nothing to print on this document' : ''].filter(Boolean).join(' · ');
}

/**
 * The parts of a group that always print, on one line. Each name keeps the id click-to-select focuses
 * (`<switch id>-row`), so a click on a locked part in the preview still lands here; its notes are its
 * tooltip and description.
 */
function AlwaysPrinted({ rows }: { rows: readonly EditorPartRow[] }) {
  return (
    <p className="bx-muted" style={{ margin: 0 }}>
      {'Always printed: '}
      {rows.map((row, i) => (
        <Fragment key={row.id}>
          {i > 0 ? ', ' : null}
          <span id={`${partSwitchId(row.id)}-row`} tabIndex={-1} title={lockedPartText(row)}>
            {row.label}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * A part's switch; its notes show when `notesShown` (the editor's notes row, or always when read-only — a
 * disabled switch cannot take the focus) and are visually hidden otherwise, still its description.
 */
function PartRow({
  row,
  readOnly,
  onPart,
  notesShown,
  onFocusRow,
  onClickRow,
}: {
  row: EditorPartRow;
  readOnly: boolean;
  onPart: (row: EditorPartRow, shown: boolean) => void;
  notesShown: boolean;
  onFocusRow: () => void;
  onClickRow: () => void;
}) {
  const noteId = useId();
  const notes = partNotes(row);
  return (
    <Stack gap={1} onFocus={onFocusRow} onClick={onClickRow}>
      <Switch
        id={partSwitchId(row.id)}
        size="sm"
        checked={row.shown}
        label={row.label}
        disabled={readOnly}
        aria-describedby={notes.length > 0 ? noteId : undefined}
        onChange={(v) => onPart(row, v)}
      />
      {notes.length > 0 ? (
        <Inline gap={2} id={noteId} className={notesShown ? 'bx-muted' : 'bx-muted bx-sr-only'}>
          {notes}
        </Inline>
      ) : null}
    </Stack>
  );
}

function TextRow({ row, readOnly, onText }: { row: EditorTextRow; readOnly: boolean; onText: (row: EditorTextRow, value: string | null) => void }) {
  // An emptied box inherits the wording in grey — except an Invoice Printing option edited for all
  // documents, where blank prints nothing (as in its form) and ↺ restores the built-in default.
  const set = (value: string): void => onText(row, value === '' && !row.blankPrintsNothing ? null : value);
  const reset = row.set ? (
    <IconButton icon="undo" size="sm" variant="ghost" aria-label={`Use the default ${row.label.toLowerCase()}`} disabled={readOnly} onClick={() => onText(row, row.resetValue)} />
  ) : undefined;
  return (
    <Field label={row.label} hint={row.sourceText || undefined} labelAction={reset}>
      {row.multiline ? (
        <TextArea value={row.value} placeholder={row.placeholder} rows={2} autoGrow maxRows={6} maxLength={row.max} readOnly={readOnly} onChange={(e) => set(e.target.value)} />
      ) : (
        <TextInput value={row.value} placeholder={row.placeholder} maxLength={row.max} readOnly={readOnly} onChange={(e) => set(e.target.value)} />
      )}
    </Field>
  );
}

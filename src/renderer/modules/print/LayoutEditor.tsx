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
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { PrintPartId } from '../../../shared/printLayout.ts';
import { Badge, Banner, Button, Card, Field, Icon, IconButton, Inline, ScrollArea, Stack, Switch, Tabs, TextArea, TextInput } from '../../ui/index.ts';
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
  /** One line under the title (which documents the changes apply to). */
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
        return (
          <Stack key={g.id} gap={2}>
            <Button variant="ghost" size="sm" icon={isOpen ? 'chevron-down' : 'chevron-right'} aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggleGroup(g.id)}>
              {`${g.label} (${g.shownCount} of ${g.rows.length} shown)`}
            </Button>
            {isOpen ? (
              <Stack gap={2} id={bodyId}>
                {g.rows.map((row) => (
                  <PartRow key={row.id} row={row} readOnly={readOnly} onPart={onPart} />
                ))}
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
    <aside aria-label="Customize what prints" style={{ position: 'sticky', top: 0 }}>
      <Card title="Customize what prints" subtitle={description} padding="sm">
        <div ref={rootRef} onKeyDown={onKeyDown}>
          <Stack gap={3}>
            {notice}
            <ScrollArea maxHeight="calc(100vh - 340px)" shadows>
              <Tabs
                aria-label="Customize"
                variant="pill"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'show', label: 'Show', content: showTab },
                  { id: 'texts', label: 'Texts', content: textsTab },
                ]}
              />
            </ScrollArea>
            {warnings.length > 0 ? (
              <Banner tone="warning" title="Statutory particulars hidden">
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

function PartRow({ row, readOnly, onPart }: { row: EditorPartRow; readOnly: boolean; onPart: (row: EditorPartRow, shown: boolean) => void }) {
  const noteId = useId();
  const notes: ReactNode[] = [];
  if (row.rule) {
    notes.push(
      <Badge key="rule" size="sm" tone={row.shown ? 'neutral' : 'warning'} icon={row.shown ? undefined : 'alert'}>
        {row.shown ? row.rule : `Required: ${row.rule}`}
      </Badge>,
    );
  }
  if (row.sourceText) notes.push(<span key="source">{row.sourceText}</span>);
  if (row.empty) notes.push(<span key="empty">(nothing to print on this document)</span>);
  return (
    <Stack gap={1}>
      {row.locked ? (
        <Inline gap={2} id={`${partSwitchId(row.id)}-row`} tabIndex={-1} aria-describedby={notes.length > 0 ? noteId : undefined}>
          <Icon name="lock" size="sm" label="Always printed" />
          <span>{row.label}</span>
        </Inline>
      ) : (
        <Switch
          id={partSwitchId(row.id)}
          size="sm"
          checked={row.shown}
          label={row.label}
          disabled={readOnly}
          aria-describedby={notes.length > 0 ? noteId : undefined}
          onChange={(v) => onPart(row, v)}
        />
      )}
      {notes.length > 0 ? (
        <Inline gap={2} id={noteId} className="bx-muted">
          {notes}
        </Inline>
      ) : null}
    </Stack>
  );
}

function TextRow({ row, readOnly, onText }: { row: EditorTextRow; readOnly: boolean; onText: (row: EditorTextRow, value: string | null) => void }) {
  const set = (value: string): void => onText(row, value === '' ? null : value);
  const reset = row.set ? (
    <IconButton icon="undo" size="sm" variant="ghost" aria-label={`Use the default ${row.label.toLowerCase()}`} disabled={readOnly} onClick={() => onText(row, null)} />
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

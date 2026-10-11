/**
 * Screen pieces shared by the print screens: the paper preview, the template / page size / copies
 * controls (one line), the printer dialog and the one-line "Before you print" banner.
 */
import { useEffect, useId } from 'react';
import type { MouseEvent as ReactMouseEvent, Ref } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintCopyLabels, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_COPIES, PRINT_PAGE_SIZES } from '../../../shared/types/print.ts';
import { isPrintPartId, type PrintPartId } from '../../../shared/printLayout.ts';
import { Banner, Button, Checkbox, Field, Inline, keyTip, Modal, ScrollArea, Select, Spinner, Tooltip } from '../../ui/index.ts';
import { printerOptions, printerTitle, warningsLine } from './lib/calm.ts';
import { isRoll, PAGE_SIZE_LABELS, TEMPLATE_LABELS, toggleCopy } from './lib/layout.ts';
import type { LayoutLayers } from './lib/layoutParts.ts';
import { DOCUMENT_CSS, editingCss, previewCss } from './lib/styles.ts';
import { PrintDocuments, type PrintItem } from './templates/PrintDocuments.tsx';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: InvoiceTemplate; label: string }> = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
  { value: 'compact', label: 'Compact receipt' },
];

const SIZE_OPTIONS: ReadonlyArray<{ value: PrintPageSize; label: string }> = PRINT_PAGE_SIZES.map((s) => ({ value: s, label: PAGE_SIZE_LABELS[s] }));

/** Printer for direct printing (usePrinterChoice): '' asks every time through the OS dialog. */
export interface PrinterControl {
  printer: string;
  setPrinter: (name: string) => void;
  printers: ReadonlyArray<{ name: string; displayName: string }> | null;
  load: () => void;
}

/** A quiet inline label before its control (2.1: "Template [Modern ▾] · Paper [A4 ▾]" on one line). */
function InlineLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label htmlFor={htmlFor} className="bx-muted">
      {children}
    </label>
  );
}

/**
 * (2.1, SPEC-21 §1.11) Template · Paper · Copies on one line with inline labels. The paper select keeps
 * its accessible name "Paper size"; field hints are tooltips; the copies' keys (Ctrl+1/2/3) are in their
 * tooltips and `aria-keyshortcuts`, not printed. The printer for direct printing is not here: it is the
 * screen's More item "Printer: …" (PrinterDialog).
 */
export function PrintControls({
  template,
  onTemplate,
  pageSize,
  onPageSize,
  copies,
  onCopies,
  copyLabels,
  showCopies = true,
}: {
  template: InvoiceTemplate;
  onTemplate: (t: InvoiceTemplate) => void;
  pageSize: PrintPageSize;
  onPageSize: (s: PrintPageSize) => void;
  copies: readonly PrintCopy[];
  onCopies: (c: PrintCopy[]) => void;
  copyLabels: PrintCopyLabels;
  showCopies?: boolean;
}) {
  const id = useId();
  return (
    <Inline gap={5} rowGap={2} align="center">
      <Inline gap={2} align="center" wrap={false}>
        <InlineLabel htmlFor={`${id}-template`}>Template</InlineLabel>
        <Select<InvoiceTemplate>
          id={`${id}-template`}
          aria-label="Template"
          title={keyTip(TEMPLATE_LABELS[template], 'Alt+T')}
          options={TEMPLATE_OPTIONS}
          value={template}
          onChange={onTemplate}
          size="sm"
        />
      </Inline>
      <Inline gap={2} align="center" wrap={false}>
        <InlineLabel htmlFor={`${id}-paper`}>Paper</InlineLabel>
        <Select<PrintPageSize>
          id={`${id}-paper`}
          aria-label="Paper size"
          title={keyTip(isRoll(pageSize) ? 'Thermal roll: the page is as long as the receipt' : 'Paper size', 'Alt+S')}
          options={SIZE_OPTIONS}
          value={pageSize}
          onChange={onPageSize}
          size="sm"
        />
      </Inline>
      {showCopies ? (
        <div role="group" aria-label="Copies to print">
          <Inline gap={4} align="center">
            {PRINT_COPIES.map((c, i) => (
              <Tooltip key={c} content={keyTip(copyLabels[c], `Ctrl+${i + 1}`)} describeChild={false}>
                <Checkbox checked={copies.includes(c)} label={copyLabels[c]} aria-keyshortcuts={`Control+${i + 1}`} onChange={() => onCopies(toggleCopy(copies, c))} />
              </Tooltip>
            ))}
          </Inline>
        </div>
      ) : null}
    </Inline>
  );
}

/**
 * (2.1) The printer for direct printing, chosen from the screen's More item "Printer: Ask every time…"
 * (2.0 showed the select beside the paper on every print screen). The choice applies at once and is
 * remembered on this computer per paper kind (usePrinterChoice); Esc or Done closes.
 */
export function PrinterDialog({ printer, roll, onClose }: { printer: PrinterControl; roll: boolean; onClose: () => void }) {
  const { load } = printer;
  useEffect(() => load(), [load]);
  const title = printerTitle(roll);
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {/* The dialog's title already names the choice: the label is for screen readers only (2.0 printed it twice). */}
      <Field label={title} hideLabel hint={printer.printer ? 'Prints directly, without the printer dialog.' : 'Every print opens the printer dialog.'} hintApplies>
        <Select<string> aria-label="Printer" data-autofocus="" options={printerOptions(printer.printer, printer.printers)} value={printer.printer} onChange={printer.setPrinter} />
      </Field>
    </Modal>
  );
}

/** (2.0) Click-to-select while the layout editor is open: the clicked part and the selected one. */
export interface PreviewEditing {
  selected: PrintPartId | null;
  onSelect: (id: PrintPartId) => void;
}

/**
 * The documents drawn as sheets of paper. `rootRef` is the element that gets printed. `layers`: this
 * print's layout layer (and the Invoice Printing draft's company layer). `editing`: the layout editor is
 * open — parts are outlined on hover and a click selects the part's switch; the `.bp-editing` class and its
 * styles stay on this container, outside the printed `.bp-docs` element.
 */
export function PreviewPane({
  items,
  template,
  pageSize,
  rootRef,
  preparing,
  label = 'Print preview',
  layers,
  editing,
  paneRef,
}: {
  items: readonly PrintItem[];
  template: InvoiceTemplate;
  pageSize: PrintPageSize;
  rootRef: Ref<HTMLDivElement>;
  preparing?: boolean;
  label?: string;
  layers?: LayoutLayers;
  editing?: PreviewEditing | null;
  /** The scrollable preview region (focus returns here from the editor). */
  paneRef?: Ref<HTMLDivElement>;
}) {
  const onClick = editing
    ? (e: ReactMouseEvent<HTMLDivElement>): void => {
        const target = e.target instanceof Element ? e.target.closest('[data-part]') : null;
        const id = target?.getAttribute('data-part');
        if (isPrintPartId(id)) editing.onSelect(id);
      }
    : undefined;
  return (
    // `horizontal`: a sheet is drawn at its real width (A4 ≈ 794 px), wider than the pane beside the layout
    // editor on a small window or at a large zoom — scroll to its right edge instead of cutting it off.
    <ScrollArea ref={paneRef} className={editing ? 'bp-preview bp-editing' : 'bp-preview'} aria-label={label} shadows horizontal onClick={onClick}>
      <style>{DOCUMENT_CSS + previewCss(pageSize) + (editing ? editingCss(editing.selected) : '')}</style>
      {preparing ? (
        <Inline gap={2}>
          <Spinner size="sm" decorative />
          <span>Preparing QR codes…</span>
        </Inline>
      ) : null}
      <PrintDocuments items={items} template={template} pageSize={pageSize} rootRef={rootRef} layers={layers} />
    </ScrollArea>
  );
}

/**
 * "Before you print" (2.1: one line — the warnings joined by " · ", wrapping only when they do not fit;
 * the title stays verbatim). Printing is never blocked by it.
 */
export function WarningsBanner({ warnings, title = 'Before you print' }: { warnings: readonly string[]; title?: string }) {
  const line = warningsLine(warnings);
  if (line === '') return null;
  return (
    <Banner tone="warning" title={title}>
      {line}
    </Banner>
  );
}

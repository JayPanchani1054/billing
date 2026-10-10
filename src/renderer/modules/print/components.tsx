/**
 * Screen pieces shared by the print screens: the paper preview and the template / page size /
 * copies controls.
 */
import type { MouseEvent as ReactMouseEvent, Ref } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintCopyLabels, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_COPIES, PRINT_PAGE_SIZES } from '../../../shared/types/print.ts';
import { isPrintPartId, type PrintPartId } from '../../../shared/printLayout.ts';
import { Banner, Checkbox, Field, Inline, ScrollArea, SegmentedControl, Select, Spinner } from '../../ui/index.ts';
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

export function PrintControls({
  template,
  onTemplate,
  pageSize,
  onPageSize,
  copies,
  onCopies,
  copyLabels,
  showCopies = true,
  printer,
}: {
  template: InvoiceTemplate;
  onTemplate: (t: InvoiceTemplate) => void;
  pageSize: PrintPageSize;
  onPageSize: (s: PrintPageSize) => void;
  copies: readonly PrintCopy[];
  onCopies: (c: PrintCopy[]) => void;
  copyLabels: PrintCopyLabels;
  showCopies?: boolean;
  printer?: PrinterControl;
}) {
  const printerOptions = [
    { value: '', label: 'Ask every time (printer dialog)' },
    ...(printer?.printers ?? []).map((p) => ({ value: p.name, label: p.displayName })),
    ...(printer && printer.printer && !(printer.printers ?? []).some((p) => p.name === printer.printer) ? [{ value: printer.printer, label: printer.printer }] : []),
  ];
  return (
    <Inline gap={5} align="end">
      <Field label="Template" hint={TEMPLATE_LABELS[template]}>
        <SegmentedControl aria-label="Template" options={TEMPLATE_OPTIONS} value={template} onChange={onTemplate} size="sm" />
      </Field>
      <Field label="Paper" hint={isRoll(pageSize) ? 'Thermal roll: the page is as long as the receipt.' : undefined}>
        <Select<PrintPageSize> aria-label="Paper size" options={SIZE_OPTIONS} value={pageSize} onChange={onPageSize} size="sm" />
      </Field>
      {printer ? (
        <Field label={isRoll(pageSize) ? 'Receipt printer' : 'Printer'} hint={printer.printer ? 'Prints directly, without the dialog.' : undefined}>
          <Select<string>
            aria-label="Printer"
            options={printerOptions}
            value={printer.printer}
            onChange={printer.setPrinter}
            onFocus={printer.load}
            size="sm"
          />
        </Field>
      ) : null}
      {showCopies ? (
        <div role="group" aria-label="Copies to print">
          <Inline gap={4}>
            {PRINT_COPIES.map((c, i) => (
              <Checkbox
                key={c}
                checked={copies.includes(c)}
                label={copyLabels[c]}
                description={`Alt+${i + 1}`}
                onChange={() => onCopies(toggleCopy(copies, c))}
              />
            ))}
          </Inline>
        </div>
      ) : null}
    </Inline>
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
    <ScrollArea ref={paneRef} className={editing ? 'bp-preview bp-editing' : 'bp-preview'} aria-label={label} shadows onClick={onClick}>
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

export function WarningsBanner({ warnings, title = 'Before you print' }: { warnings: readonly string[]; title?: string }) {
  if (warnings.length === 0) return null;
  return (
    <Banner tone="warning" title={title}>
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
  );
}

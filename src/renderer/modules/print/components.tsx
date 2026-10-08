/**
 * Screen pieces shared by the print screens: the paper preview and the template / page size /
 * copies controls.
 */
import type { Ref } from 'react';
import type { InvoiceTemplate } from '../../../shared/settings.ts';
import type { PrintCopy, PrintCopyLabels, PrintPageSize } from '../../../shared/types/print.ts';
import { PRINT_COPIES } from '../../../shared/types/print.ts';
import { Banner, Checkbox, Field, Inline, ScrollArea, SegmentedControl, Spinner } from '../../ui/index.ts';
import { PAGE_SIZE_LABELS, TEMPLATE_LABELS, toggleCopy } from './lib/layout.ts';
import { DOCUMENT_CSS, previewCss } from './lib/styles.ts';
import { PrintDocuments, type PrintItem } from './templates/PrintDocuments.tsx';

const TEMPLATE_OPTIONS: ReadonlyArray<{ value: InvoiceTemplate; label: string }> = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
  { value: 'compact', label: 'Compact 80 mm' },
];

const SIZE_OPTIONS: ReadonlyArray<{ value: PrintPageSize; label: string }> = [
  { value: 'A4', label: PAGE_SIZE_LABELS.A4 },
  { value: 'A5', label: PAGE_SIZE_LABELS.A5 },
  { value: '80mm', label: PAGE_SIZE_LABELS['80mm'] },
];

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
  return (
    <Inline gap={5} align="end">
      <Field label="Template" hint={TEMPLATE_LABELS[template]}>
        <SegmentedControl aria-label="Template" options={TEMPLATE_OPTIONS} value={template} onChange={onTemplate} size="sm" />
      </Field>
      <Field label="Paper">
        <SegmentedControl aria-label="Paper size" options={SIZE_OPTIONS} value={pageSize} onChange={onPageSize} size="sm" />
      </Field>
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

/** The documents drawn as sheets of paper. `rootRef` is the element that gets printed. */
export function PreviewPane({
  items,
  template,
  pageSize,
  rootRef,
  preparing,
  label = 'Print preview',
}: {
  items: readonly PrintItem[];
  template: InvoiceTemplate;
  pageSize: PrintPageSize;
  rootRef: Ref<HTMLDivElement>;
  preparing?: boolean;
  label?: string;
}) {
  return (
    <ScrollArea className="bp-preview" aria-label={label} shadows>
      <style>{DOCUMENT_CSS + previewCss(pageSize)}</style>
      {preparing ? (
        <Inline gap={2}>
          <Spinner size="sm" decorative />
          <span>Preparing QR codes…</span>
        </Inline>
      ) : null}
      <PrintDocuments items={items} template={template} pageSize={pageSize} rootRef={rootRef} />
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

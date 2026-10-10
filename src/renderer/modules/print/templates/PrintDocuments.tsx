/**
 * Root of everything that gets printed: one `.bp-docs` element holding every copy of every document.
 * The preview renders it on screen; printing serialises this exact element (WYSIWYG).
 */
import type { Ref } from 'react';
import type { InvoiceTemplate } from '../../../../shared/settings.ts';
import type { PrintCopy, PrintPageSize, PrintVoucherData } from '../../../../shared/types/print.ts';
import { copyLabel } from '../lib/layout.ts';
import type { DocumentQrs } from '../lib/qr.ts';
import { ClassicInvoice } from './ClassicInvoice.tsx';
import { CompactDoc } from './CompactDoc.tsx';
import { InventoryDoc } from './InventoryDoc.tsx';
import { ModernInvoice } from './ModernInvoice.tsx';
import type { DocProps } from './parts.tsx';
import { VoucherDoc } from './VoucherDoc.tsx';

export interface PrintItem {
  doc: PrintVoucherData;
  copies: readonly PrintCopy[];
  qrs: DocumentQrs;
}

export function DocumentView(props: DocProps) {
  if (props.template === 'compact') return <CompactDoc {...props} />;
  if (props.doc.layout === 'voucher') return <VoucherDoc {...props} />;
  if (props.doc.layout === 'inventory') return <InventoryDoc {...props} />;
  return props.template === 'classic' ? <ClassicInvoice {...props} /> : <ModernInvoice {...props} />;
}

export function PrintDocuments({
  items,
  template,
  pageSize,
  rootRef,
}: {
  items: readonly PrintItem[];
  template: InvoiceTemplate;
  pageSize: PrintPageSize;
  rootRef?: Ref<HTMLDivElement>;
}) {
  const size = pageSize.toLowerCase();
  return (
    <div ref={rootRef} className={`bp-docs bp-size-${size}`}>
      {items.flatMap((it) =>
        it.copies.map((copy) => (
          <DocumentView
            key={`${it.doc.id}-${copy}`}
            doc={it.doc}
            copyLabel={copyLabel(it.doc, copy, it.copies.length)}
            qrs={it.qrs}
            pageSize={pageSize}
            template={template}
          />
        )),
      )}
    </div>
  );
}

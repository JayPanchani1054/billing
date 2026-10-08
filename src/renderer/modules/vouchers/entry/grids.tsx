/**
 * Entry grids of the voucher screen: item lines and ledger lines.
 *
 * Performance: rows are React.memo'd and receive only their own data; everything shared (masters,
 * dispatch, callbacks) comes from GridEnvContext, whose value is stable while typing. A keystroke
 * re-renders one row (plus the totals panel), so 500-line vouchers stay fast.
 *
 * Keyboard (handled by the screen through the cell ids, see lib/gridNav.ts and lib/errorPaths.ts):
 * Enter / Shift+Enter move cell by cell; Enter on an empty row leaves the grid; ↑/↓ keep the column;
 * Ctrl+D deletes the row; Alt+N (or Ctrl+N) inserts a row above.
 */
import { createContext, memo, useContext } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type { VoucherBaseType } from '../../../../shared/constants.ts';
import { formatMoney, formatPercent } from '../../../../shared/format.ts';
import type { Paise } from '../../../../shared/money.ts';
import type { LedgerDetail, LedgerPickerRow } from '../../../../shared/types/accounts.ts';
import type { GodownDto, ItemPickerRow } from '../../../../shared/types/inventory.ts';
import type { CompanyFeatures } from '../../../../shared/settings.ts';
import { AmountInput, Badge, Icon, IconButton, NumberInput, PercentInput, TextInput, Tooltip } from '../../../ui/index.ts';
import { cellId } from '../lib/errorPaths.ts';
import { itemLineValue } from '../lib/formState.ts';
import type { FormAction, ItemRow, LedgerRow } from '../lib/formState.ts';
import type { LedgerSlot } from '../lib/masters.ts';
import type { LineFigures } from '../lib/totals.ts';
import { BatchCombo, GodownCombo, ItemCombo } from '../pickers/ItemCombo.tsx';
import { LedgerCombo } from '../pickers/LedgerCombo.tsx';

export type RowDialogKind = 'bills' | 'cost' | 'instrument';

/** Everything rows share. Keep it referentially stable while the user types. */
export interface GridEnv {
  baseType: VoucherBaseType;
  date: string;
  voucherId: number | null;
  features: CompanyFeatures;
  direction: 'outward' | 'inward';
  dispatch: Dispatch<FormAction>;
  ledgers: readonly LedgerPickerRow[];
  ledgerById: ReadonlyMap<number, LedgerPickerRow>;
  ledgerDetails: ReadonlyMap<number, LedgerDetail>;
  refetchLedgers: () => void;
  items: readonly ItemPickerRow[];
  itemById: ReadonlyMap<number, ItemPickerRow>;
  refetchItems: () => void;
  godowns: readonly GodownDto[];
  /** Ledgers not offered on invoice lines (the party itself). */
  excludeLedgerIds: readonly number[];
  /** Item chosen on a row: the screen fills rate / godown defaults. */
  onItemChosen: (rowKey: string, row: ItemPickerRow | null) => void;
  /** A picker cell committed with Enter: move on as if Enter was pressed (the row is now filled). */
  advanceFrom: (section: 'items' | 'ledgers', rowKey: string, column: string) => void;
  /** Quantity committed (Enter / leaving the cell): the screen may re-read the price-list slab. */
  onQtyCommitted: (rowKey: string, qty: number | null) => void;
  openRowDialog: (kind: RowDialogKind, rowKey: string) => void;
  deleteRow: (section: 'items' | 'ledgers', rowKey: string) => void;
}

export const GridEnvContext = createContext<GridEnv | null>(null);

function useGridEnv(): GridEnv {
  const env = useContext(GridEnvContext);
  if (!env) throw new Error('GridEnvContext missing');
  return env;
}

// ───────────────────────────── Item grid ─────────────────────────────

export type ItemColumn = 'item' | 'godown' | 'batch' | 'qty' | 'billedQty' | 'rate' | 'disc' | 'amount' | 'gst';

export const ITEM_COLUMN_LABEL: Readonly<Record<ItemColumn, string>> = {
  item: 'Name of item',
  godown: 'Godown',
  batch: 'Batch',
  qty: 'Quantity',
  billedQty: 'Billed qty',
  rate: 'Rate',
  disc: 'Disc %',
  amount: 'Amount',
  gst: 'GST %',
};

/** Columns of the item grid for a voucher (feature-aware). */
export function itemColumns(o: { baseType: VoucherBaseType; mode: 'item_invoice' | 'inventory'; features: CompanyFeatures; gstOn: boolean }): ItemColumn[] {
  const cols: ItemColumn[] = ['item'];
  if (o.features.multipleGodowns) cols.push('godown');
  if (o.features.batches) cols.push('batch');
  cols.push('qty');
  if (o.baseType === 'physical_stock') return cols;
  if (o.mode === 'item_invoice' && o.features.actualAndBilledQty) cols.push('billedQty');
  cols.push('rate');
  if (o.mode === 'item_invoice' && o.features.discountColumn) cols.push('disc');
  cols.push('amount');
  if (o.mode === 'item_invoice' && o.gstOn) cols.push('gst');
  return cols;
}

/** Columns Enter moves through (GST % is reachable with Tab / the mouse). */
export const navItemColumns = (cols: readonly ItemColumn[]): ItemColumn[] => cols.filter((c) => c !== 'gst');

export interface ItemGridProps {
  title?: ReactNode;
  caption: string;
  columns: readonly ItemColumn[];
  rows: readonly ItemRow[];
  figures: ReadonlyMap<string, LineFigures>;
  rowErrors: ReadonlyMap<string, Readonly<Record<string, string>>>;
  rowWarnings: ReadonlyMap<string, string>;
  qtyLabel: string;
  footer?: ReactNode;
}

export function ItemGrid({ title, caption, columns, rows, figures, rowErrors, rowWarnings, qtyLabel, footer }: ItemGridProps) {
  return (
    <div className="bx-vch-grid">
      {title ? <h2 className="bx-vch-grid__title">{title}</h2> : null}
      <table className="bx-vch-table" aria-label={caption}>
        <thead>
          <tr>
            <th scope="col" className="bx-vch-table__no">
              <span className="bx-sr-only">Line</span>#
            </th>
            {columns.map((c) => (
              <th key={c} scope="col" className={c === 'item' || c === 'godown' || c === 'batch' ? `bx-vch-col--${c}` : `bx-vch-col--${c} is-num`}>
                {c === 'qty' ? qtyLabel : ITEM_COLUMN_LABEL[c]}
              </th>
            ))}
            <th scope="col" className="bx-vch-table__act">
              <span className="bx-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <ItemRowView key={r.key} row={r} index={i} columns={columns} figures={figures.get(r.key)} errors={rowErrors.get(r.key)} warning={rowWarnings.get(r.key)} />
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

interface ItemRowViewProps {
  row: ItemRow;
  index: number;
  columns: readonly ItemColumn[];
  figures: LineFigures | undefined;
  errors: Readonly<Record<string, string>> | undefined;
  warning: string | undefined;
}

/** id of the visible error text under a cell (referenced by the input's aria-describedby). */
const errId = (cell: string): string => `${cell}-err`;

const ItemRowView = memo(function ItemRowView({ row, index, columns, figures, errors, warning }: ItemRowViewProps) {
  const env = useGridEnv();
  const k = row.key;
  const id = (c: string) => cellId('items', k, c);
  const err = (c: string) => errors?.[id(c)];
  const described = (c: string) => (err(c) ? errId(id(c)) : undefined);
  const blank = row.itemId === null;
  const item = row.itemId === null ? undefined : env.itemById.get(row.itemId);
  const decimals = item?.unitDecimals ?? 3;
  const patch = (p: Partial<Omit<ItemRow, 'key'>>) => env.dispatch({ type: 'item', key: k, patch: p });
  const value = itemLineValue(row);
  const cell = (c: ItemColumn): ReactNode => {
    switch (c) {
      case 'item':
        return (
          <div className="bx-vch-cell-item">
            <ItemCombo
              id={id('item')}
              aria-label={`Item, line ${index + 1}`}
              aria-describedby={described('item')}
              rows={env.items}
              value={row.itemId}
              invalid={!!err('item')}
              openOnFocus={!blank}
              onChange={(itemId, r) => {
                if (itemId === row.itemId) return;
                env.onItemChosen(k, r);
              }}
              onCommit={(itemId, r) => {
                if (itemId !== row.itemId) env.onItemChosen(k, r);
                if (itemId !== null) env.advanceFrom('items', k, 'item');
              }}
              onRefetch={env.refetchItems}
            />
            {row.trackingRef || row.orderRef ? (
              <span className="bx-vch-cell-item__ref">
                <Badge size="sm" tone="info">
                  {row.trackingRef ? `Note ${row.trackingRef}` : `Order ${row.orderRef}`}
                </Badge>
              </span>
            ) : null}
          </div>
        );
      case 'godown':
        return blank ? null : (
          <GodownCombo
            id={id('godown')}
            aria-label={`Godown, line ${index + 1}`}
            aria-describedby={described('godown')}
            rows={env.godowns}
            value={row.godownId}
            invalid={!!err('godown')}
            onChange={(g) => patch({ godownId: g })}
          />
        );
      case 'batch':
        // onCommit: Enter on a batch (or on a new batch name, which creates it) moves on in one keystroke.
        return blank || !item?.maintainBatches ? null : (
          <BatchCombo
            id={id('batch')}
            aria-label={`Batch, line ${index + 1}`}
            aria-describedby={described('batch')}
            itemId={row.itemId as number}
            godownId={row.godownId}
            asOf={env.date}
            excludeVoucherId={env.voucherId}
            value={row.batchName}
            invalid={!!err('batch')}
            onChange={(name, b) => patch({ batchName: name, mfgDate: b?.mfgDate ?? row.mfgDate, expiryDate: b?.expiryDate ?? row.expiryDate })}
            onCommit={() => env.advanceFrom('items', k, 'batch')}
          />
        );
      case 'qty':
        return blank ? null : (
          <NumberInput
            id={id('qty')}
            aria-label={`Quantity, line ${index + 1}`}
            aria-describedby={described('qty')}
            size="sm"
            value={row.qty}
            decimals={decimals}
            min={0}
            invalid={!!err('qty')}
            suffix={item?.unitSymbol ? <span className="bx-vch-unit">{item.unitSymbol}</span> : undefined}
            onChange={(q) => patch({ qty: q, amount: null })}
            onCommit={(q) => env.onQtyCommitted(k, q)}
          />
        );
      case 'billedQty':
        return blank ? null : (
          <NumberInput
            id={id('billedQty')}
            aria-label={`Billed quantity, line ${index + 1}`}
            aria-describedby={described('billedQty')}
            size="sm"
            value={row.billedQty}
            decimals={decimals}
            min={0}
            placeholder={row.qty === null ? '' : String(row.qty)}
            invalid={!!err('billedQty')}
            onChange={(q) => patch({ billedQty: q, amount: null })}
          />
        );
      case 'rate':
        return blank ? null : (
          <NumberInput id={id('rate')} aria-label={`Rate, line ${index + 1}`} aria-describedby={described('rate')} size="sm" value={row.rate} decimals={2} min={0} invalid={!!err('rate')} onChange={(r) => patch({ rate: r, amount: null })} />
        );
      case 'disc':
        return blank ? null : (
          <PercentInput id={id('disc')} aria-label={`Discount percent, line ${index + 1}`} aria-describedby={described('disc')} size="sm" value={row.discountPct} max={100} invalid={!!err('disc')} onChange={(d) => patch({ discountPct: d, amount: null })} />
        );
      case 'amount':
        return blank ? null : (
          <AmountInput
            id={id('amount')}
            aria-label={`Amount, line ${index + 1}`}
            aria-describedby={described('amount')}
            size="sm"
            value={value || null}
            invalid={!!err('amount')}
            onChange={(a) => {
              if (a === value) return;
              // Tally: typing the amount re-derives the rate from the quantity.
              const q = row.billedQty ?? row.qty ?? 0;
              const d = row.discountPct ?? 0;
              const rate = a !== null && q > 0 && d < 100 ? Math.round((a / 100 / q / (1 - d / 100)) * 10_000) / 10_000 : row.rate;
              patch({ amount: a, rate });
            }}
          />
        );
      case 'gst':
        return blank ? null : (
          <PercentInput
            id={id('gst')}
            aria-label={`GST rate, line ${index + 1}`}
            aria-describedby={described('gst')}
            size="sm"
            value={row.gstRateOverride}
            max={100}
            placeholder={figures ? (figures.taxability === 'taxable' ? formatPercent(figures.rate) : figures.taxability.replace('_', '-')) : ''}
            invalid={!!err('gst')}
            onChange={(g) => patch({ gstRateOverride: g })}
          />
        );
      default:
        return null;
    }
  };
  const firstError = errors ? Object.values(errors)[0] : undefined;
  return (
    <tr className={blank ? 'bx-vch-row is-blank' : 'bx-vch-row'} data-row={k}>
      <td className="bx-vch-table__no">
        {warning || firstError ? (
          <Tooltip content={firstError ?? warning}>
            <span className={firstError ? 'bx-vch-flag is-error' : 'bx-vch-flag'} tabIndex={-1} aria-label={firstError ?? warning}>
              <Icon name="alert" size="sm" />
            </span>
          </Tooltip>
        ) : blank ? (
          ''
        ) : (
          index + 1
        )}
      </td>
      {columns.map((c) => (
        <td key={c} className={`bx-vch-col--${c}`}>
          {cell(c)}
          {err(c) ? (
            <span id={errId(id(c))} className="bx-vch-cell-error">
              {err(c)}
            </span>
          ) : null}
        </td>
      ))}
      <td className="bx-vch-table__act">
        {blank ? null : <IconButton icon="trash" size="sm" variant="ghost" tabIndex={-1} aria-label={`Remove line ${index + 1}`} tooltip="Remove line (Ctrl+D)" onClick={() => env.deleteRow('items', k)} />}
      </td>
    </tr>
  );
});

// ───────────────────────────── Ledger grid ─────────────────────────────

export type LedgerColumn = 'ledger' | 'gst' | 'hsn' | 'amount' | 'narr';

export interface LedgerGridProps {
  title?: ReactNode;
  caption: string;
  slot: LedgerSlot;
  /** 'signed' = Dr/Cr chip (double entry); 'magnitude' = single entry particulars; 'invoice' = + adds / − deducts. */
  amountKind: 'signed' | 'magnitude' | 'invoice';
  columns: readonly LedgerColumn[];
  rows: readonly LedgerRow[];
  figures: ReadonlyMap<string, LineFigures>;
  rowErrors: ReadonlyMap<string, Readonly<Record<string, string>>>;
  rowWarnings: ReadonlyMap<string, string>;
  /** Bill-wise / cost centre / bank detail state for the row buttons. */
  footer?: ReactNode;
  amountLabel: string;
}

export function LedgerGrid({ title, caption, slot, amountKind, columns, rows, figures, rowErrors, rowWarnings, footer, amountLabel }: LedgerGridProps) {
  return (
    <div className="bx-vch-grid">
      {title ? <h2 className="bx-vch-grid__title">{title}</h2> : null}
      <table className="bx-vch-table" aria-label={caption}>
        <thead>
          <tr>
            <th scope="col" className="bx-vch-table__no">
              <span className="bx-sr-only">Line</span>#
            </th>
            {columns.map((c) => (
              <th key={c} scope="col" className={c === 'amount' || c === 'gst' ? `bx-vch-col--l${c} is-num` : `bx-vch-col--l${c}`}>
                {c === 'ledger' ? 'Particulars' : c === 'gst' ? 'GST %' : c === 'hsn' ? 'HSN/SAC' : c === 'narr' ? 'Line narration' : amountLabel}
              </th>
            ))}
            <th scope="col" className="bx-vch-table__act">
              <span className="bx-sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <LedgerRowView
              key={r.key}
              row={r}
              index={i}
              slot={slot}
              amountKind={amountKind}
              columns={columns}
              figures={figures.get(r.key)}
              errors={rowErrors.get(r.key)}
              warning={rowWarnings.get(r.key)}
            />
          ))}
        </tbody>
        {footer ? <tfoot>{footer}</tfoot> : null}
      </table>
    </div>
  );
}

interface LedgerRowViewProps {
  row: LedgerRow;
  index: number;
  slot: LedgerSlot;
  amountKind: 'signed' | 'magnitude' | 'invoice';
  columns: readonly LedgerColumn[];
  figures: LineFigures | undefined;
  errors: Readonly<Record<string, string>> | undefined;
  warning: string | undefined;
}

/** Bill-wise / cost centre / bank applicability of a ledger line. */
export function rowDetailNeeds(env: Pick<GridEnv, 'features' | 'ledgerById' | 'ledgerDetails'>, ledgerId: number | null): { bills: boolean; cost: boolean; bank: boolean } {
  if (ledgerId === null) return { bills: false, cost: false, bank: false };
  const r = env.ledgerById.get(ledgerId);
  const d = env.ledgerDetails.get(ledgerId);
  return {
    bills: env.features.billWise && (r?.billWise ?? d?.billWise ?? false),
    cost: env.features.costCentres && (d?.costCentresApplicable ?? false),
    bank: r?.classes.includes('bank') ?? d?.classes.includes('bank') ?? false,
  };
}

const LedgerRowView = memo(function LedgerRowView({ row, index, slot, amountKind, columns, figures, errors, warning }: LedgerRowViewProps) {
  const env = useGridEnv();
  const k = row.key;
  const id = (c: string) => cellId('ledgers', k, c);
  const err = (c: string) => errors?.[id(c)];
  const described = (c: string) => (err(c) ? errId(id(c)) : undefined);
  const blank = row.ledgerId === null;
  const patch = (p: Partial<Omit<LedgerRow, 'key'>>) => env.dispatch({ type: 'ledger', key: k, patch: p });
  const needs = rowDetailNeeds(env, row.ledgerId);
  const figureNote = (): string => {
    if (!figures || amountKind !== 'invoice') return '';
    if (figures.taxability === 'non_gst' && figures.tax === 0 && figures.taxable === 0) return 'Added after tax';
    if (figures.taxable === 0 && figures.total === 0) return 'Spread over items';
    return figures.taxability === 'taxable' ? `GST ${formatPercent(figures.rate)}: ₹ ${formatMoney(figures.tax)}` : figures.taxability.replace('_', '-');
  };
  const cell = (c: LedgerColumn): ReactNode => {
    switch (c) {
      case 'ledger':
        return (
          <LedgerCombo
            id={id('ledger')}
            aria-label={`Ledger, line ${index + 1}`}
            aria-describedby={described('ledger')}
            rows={env.ledgers}
            slot={slot}
            baseType={env.baseType}
            direction={env.direction}
            excludeIds={slot === 'invoiceLine' ? env.excludeLedgerIds : undefined}
            value={row.ledgerId}
            invalid={!!err('ledger')}
            openOnFocus={!blank}
            size="sm"
            onChange={(ledgerId) => {
              if (ledgerId !== row.ledgerId) patch({ ledgerId, bills: null, costs: null, instrument: null, gstExtra: null });
            }}
            onCommit={(ledgerId) => {
              if (ledgerId !== row.ledgerId) patch({ ledgerId, bills: null, costs: null, instrument: null, gstExtra: null });
              if (ledgerId !== null) env.advanceFrom('ledgers', k, 'ledger');
            }}
            onRefetch={env.refetchLedgers}
          />
        );
      case 'gst':
        return blank ? null : (
          <PercentInput
            id={id('gst')}
            aria-label={`GST rate, line ${index + 1}`}
            aria-describedby={described('gst')}
            size="sm"
            value={row.gstRate}
            max={100}
            placeholder={figures && figures.taxability === 'taxable' ? formatPercent(figures.rate) : ''}
            invalid={!!err('gst')}
            onChange={(g) => patch({ gstRate: g })}
          />
        );
      case 'hsn':
        return blank ? null : <TextInput id={id('hsn')} aria-label={`HSN or SAC, line ${index + 1}`} size="sm" mono maxLength={8} inputMode="numeric" value={row.hsnSac} onValueChange={(s) => patch({ hsnSac: s.replace(/\D/g, '') })} />;
      case 'amount':
        if (blank) return null;
        if (amountKind === 'signed')
          return (
            <AmountInput
              id={id('amount')}
              aria-label={`Amount, line ${index + 1}`}
              aria-describedby={described('amount')}
              size="sm"
              drcr
              value={row.amount}
              defaultSide={row.side}
              onSideChange={(side) => {
                if (row.amount === null || row.amount === 0) patch({ side });
              }}
              invalid={!!err('amount')}
              onChange={(a) => patch({ amount: a })}
            />
          );
        return (
          <div className="bx-vch-cell-amount">
            <AmountInput
              id={id('amount')}
              aria-label={`Amount, line ${index + 1}`}
              aria-describedby={described('amount')}
              size="sm"
              allowNegative={amountKind === 'invoice'}
              value={row.amount}
              invalid={!!err('amount')}
              onChange={(a) => patch({ amount: a })}
            />
            {figureNote() ? <span className="bx-vch-cell-note">{figureNote()}</span> : null}
          </div>
        );
      case 'narr':
        return blank ? null : <TextInput id={id('narr')} aria-label={`Narration, line ${index + 1}`} size="sm" maxLength={500} value={row.narration} onValueChange={(s) => patch({ narration: s })} />;
      default:
        return null;
    }
  };
  const firstError = errors ? Object.values(errors)[0] : undefined;
  return (
    <tr className={blank ? 'bx-vch-row is-blank' : 'bx-vch-row'} data-row={k}>
      <td className="bx-vch-table__no">
        {warning || firstError ? (
          <Tooltip content={firstError ?? warning}>
            <span className={firstError ? 'bx-vch-flag is-error' : 'bx-vch-flag'} tabIndex={-1} aria-label={firstError ?? warning}>
              <Icon name="alert" size="sm" />
            </span>
          </Tooltip>
        ) : blank ? (
          ''
        ) : (
          index + 1
        )}
      </td>
      {columns.map((c) => (
        <td key={c} className={`bx-vch-col--l${c}`}>
          {cell(c)}
          {err(c) ? (
            <span id={errId(id(c))} className="bx-vch-cell-error">
              {err(c)}
            </span>
          ) : null}
        </td>
      ))}
      <td className="bx-vch-table__act">
        {blank ? null : (
          <span className="bx-vch-rowtools">
            {needs.bills && amountKind !== 'invoice' ? (
              <IconButton
                icon="receipt"
                size="sm"
                variant={row.bills ? 'secondary' : 'ghost'}
                pressed={!!row.bills}
                tabIndex={-1}
                aria-label={`Bill-wise details, line ${index + 1}`}
                tooltip="Bill-wise details (Alt+B)"
                onClick={() => env.openRowDialog('bills', k)}
              />
            ) : null}
            {needs.cost ? (
              <IconButton
                icon="layers"
                size="sm"
                variant={row.costs ? 'secondary' : 'ghost'}
                pressed={!!row.costs}
                tabIndex={-1}
                aria-label={`Cost centres, line ${index + 1}`}
                tooltip="Cost centres (Alt+O)"
                onClick={() => env.openRowDialog('cost', k)}
              />
            ) : null}
            {needs.bank && amountKind !== 'invoice' ? (
              <IconButton
                icon="bank"
                size="sm"
                variant={row.instrument ? 'secondary' : 'ghost'}
                pressed={!!row.instrument}
                tabIndex={-1}
                aria-label={`Bank details, line ${index + 1}`}
                tooltip="Bank details (Alt+K)"
                onClick={() => env.openRowDialog('instrument', k)}
              />
            ) : null}
            <IconButton icon="trash" size="sm" variant="ghost" tabIndex={-1} aria-label={`Remove line ${index + 1}`} tooltip="Remove line (Ctrl+D)" onClick={() => env.deleteRow('ledgers', k)} />
          </span>
        )}
      </td>
    </tr>
  );
});

/** A footer row: label spanning the leading columns, then a value under the amount column. */
export function TotalRow({ label, value, span, trailing = 1, tone }: { label: ReactNode; value: Paise | ReactNode; span: number; trailing?: number; tone?: 'strong' | 'muted' }) {
  return (
    <tr className={tone ? `bx-vch-total is-${tone}` : 'bx-vch-total'}>
      <td colSpan={span}>{label}</td>
      <td className="is-num bx-num">{typeof value === 'number' ? formatMoney(value) : value}</td>
      {trailing > 0 ? <td colSpan={trailing} /> : null}
    </tr>
  );
}

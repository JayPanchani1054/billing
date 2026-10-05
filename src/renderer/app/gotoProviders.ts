/**
 * Built-in Go To providers for masters and vouchers. They call optional routes that feature
 * modules ship later ('accounts.ledger.picker', 'inventory.item.picker', 'vouchers.list'); until
 * a route exists the provider is silent. A feature module that registers a provider with the same
 * id ('ledgers' | 'items' | 'vouchers') replaces the built-in.
 *
 * Expected shapes (validated at runtime, extra fields ignored):
 *   accounts.ledger.picker  { search, limit } → Row[] | { rows: Row[] }, Row = { id, name, alias?, groupName? }
 *   inventory.item.picker   { search, limit } → Row[] | { rows: Row[] }, Row = { id, name, alias?, groupName?, unit? }
 *   vouchers.list           { search, limit } → { rows: V[] } | V[], V = { id, number|voucherNumber, typeName|voucherType, date, partyName? }
 */
import { formatDate } from '../../shared/dates.ts';
import { apiOptional, isMissingRoute } from './api.ts';
import { registerGotoProvider } from './lib/goto.ts';
import type { GotoItem } from './lib/goto.ts';

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

function rowsOf(out: unknown): Obj[] {
  const list = Array.isArray(out) ? out : isObj(out) && Array.isArray(out.rows) ? out.rows : [];
  return list.filter(isObj);
}

const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() !== '' ? x : undefined);
const idOf = (x: unknown): number | string | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x ? x : undefined);

/** Routes found missing in this session (skip until the app restarts). */
const missing = new Set<string>();

async function callOptional(route: string, input: unknown): Promise<unknown> {
  if (missing.has(route)) return [];
  try {
    return await apiOptional(route, input);
  } catch (err) {
    if (isMissingRoute(err)) missing.add(route);
    throw err;
  }
}

let installed = false;

/** Register the built-in providers once (idempotent). `screenExists` picks the best target screen. */
export function installBuiltinGotoProviders(screenExists: () => (id: string) => boolean): void {
  if (installed) return;
  installed = true;

  registerGotoProvider(
    {
      id: 'ledgers',
      label: 'Ledgers',
      search: async (query) => {
        const rows = rowsOf(await callOptional('accounts.ledger.picker', { search: query, limit: 8 }));
        const has = screenExists();
        const out: GotoItem[] = [];
        for (const r of rows) {
          const id = idOf(r.id);
          const name = str(r.name);
          if (id === undefined || !name) continue;
          const toReport = has('reports.ledger');
          out.push({
            id: `ledger:${id}`,
            label: name,
            group: 'Ledgers',
            description: str(r.groupName) ?? 'Ledger',
            keywords: [str(r.alias) ?? ''],
            screen: toReport ? 'reports.ledger' : 'accounts.ledger.form',
            params: toReport ? { ledgerId: id } : { id },
          });
        }
        return out;
      },
    },
    { builtin: true },
  );

  registerGotoProvider(
    {
      id: 'items',
      label: 'Stock Items',
      search: async (query) => {
        const rows = rowsOf(await callOptional('inventory.item.picker', { search: query, limit: 8 }));
        const out: GotoItem[] = [];
        for (const r of rows) {
          const id = idOf(r.id);
          const name = str(r.name);
          if (id === undefined || !name) continue;
          out.push({
            id: `item:${id}`,
            label: name,
            group: 'Stock Items',
            description: str(r.groupName) ?? 'Stock item',
            keywords: [str(r.alias) ?? ''],
            screen: 'inventory.item.form',
            params: { id },
          });
        }
        return out;
      },
    },
    { builtin: true },
  );

  registerGotoProvider(
    {
      id: 'vouchers',
      label: 'Vouchers',
      minQuery: 1,
      search: async (query) => {
        const rows = rowsOf(await callOptional('vouchers.list', { search: query, limit: 8 }));
        const out: GotoItem[] = [];
        for (const r of rows) {
          const id = idOf(r.id);
          const number = str(r.number) ?? str(r.voucherNumber);
          if (id === undefined || !number) continue;
          const type = str(r.typeName) ?? str(r.voucherType) ?? 'Voucher';
          const date = str(r.date);
          out.push({
            id: `voucher-doc:${id}`,
            label: `${type} ${number}`,
            group: 'Vouchers',
            description: [date ? formatDate(date) : '', str(r.partyName) ?? ''].filter(Boolean).join(' · '),
            keywords: [number, str(r.partyName) ?? ''],
            screen: 'vouchers.entry',
            params: { id },
          });
        }
        return out;
      },
    },
    { builtin: true },
  );
}

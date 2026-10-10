/**
 * Sharing a document (print group): who it goes to and what the message says, and the edit-log entry.
 *
 *   'print.share.context'  ShareSubjectInput → ShareContext   recipient (party e-mail / mobile), subject,
 *                                                             body and WhatsApp text from the F12 templates
 *   'print.share.log'      ShareLogInput     → { ok: true }   writes the 'export' edit-log entry
 *
 * The PDF itself is rendered and written by Electron main ('share.email' / 'share.whatsapp', into the
 * company's exports folder); the renderer calls 'print.share.log' first, exactly like printing calls
 * 'data.export.audit' — so sharing needs the data.export permission and is always on record.
 */
import type { Permission } from '../../../shared/constants.ts';
import { formatDate } from '../../../shared/dates.ts';
import { formatMoney } from '../../../shared/format.ts';
import { fillShareTemplate, oneLine, type ShareValues } from '../../../shared/shareText.ts';
import type { ShareContext, ShareLogInput, ShareSubjectInput } from '../../../shared/types/print.ts';
import { normalizeMobile, validateEmail } from '../../../shared/validators.ts';
import type { CompanyCtx } from '../../api/context.ts';
import { forbidden, notFound, validation } from '../../lib/errors.ts';
import { ledgerBalance } from '../accounts/books.ts';
import { getConfig } from '../company/service.ts';
import { buildPrintData, loadPrintEnv } from './data.ts';

const can = (ctx: CompanyCtx, p: Permission): boolean => ctx.session.isOwner || ctx.session.permissions.has(p);

interface PartyContact {
  id: number;
  name: string;
  email: string | null;
  mobile: string | null;
}

function contactOf(ctx: CompanyCtx, ledgerId: number | null): PartyContact | null {
  if (ledgerId === null) return null;
  const r = ctx.db.get<{ id: number; name: string; mailing_name: string | null; email: string | null; mobile: string | null; phone: string | null }>(
    'SELECT id, name, mailing_name, email, mobile, phone FROM ledgers WHERE id = :id',
    { id: ledgerId },
  );
  if (!r) return null;
  const email = r.email && !validateEmail(r.email) ? r.email.trim() : null;
  // A mobile number for WhatsApp: the Mobile field, else a Phone that is a mobile number.
  const mobile = normalizeMobile(r.mobile) || normalizeMobile(r.phone) || null;
  return { id: r.id, name: r.mailing_name?.trim() || r.name, email, mobile };
}

/**
 * First party-like ledger of a voucher without a party header (payment / receipt / journal): one with an
 * e-mail or phone that is not a cash or bank ledger (a bank's branch e-mail is not the recipient).
 */
function inferredParty(ctx: CompanyCtx, voucherId: number): number | null {
  return (
    ctx.db.value<number>(
      `WITH RECURSIVE cb(id) AS (SELECT id FROM groups WHERE reserved_code IN ('BANK_ACCOUNTS', 'BANK_OD', 'CASH_IN_HAND')
                                  UNION SELECT c.id FROM groups c JOIN cb ON c.parent_id = cb.id)
       SELECT le.ledger_id FROM ledger_entries le JOIN ledgers l ON l.id = le.ledger_id
        WHERE le.voucher_id = :id AND (l.email IS NOT NULL OR l.mobile IS NOT NULL OR l.phone IS NOT NULL)
          AND l.group_id NOT IN (SELECT id FROM cb)
        ORDER BY le.line_no LIMIT 1`,
      { id: voucherId },
    ) ?? null
  );
}

interface Subject {
  kind: 'voucher' | 'statement';
  label: string;
  entityType: 'voucher' | 'ledger';
  entityId: number;
  party: PartyContact | null;
  values: ShareValues;
  fileName: string;
}

function subjectOf(ctx: CompanyCtx, input: ShareSubjectInput): Subject {
  const company = ctx.db.value<string>("SELECT COALESCE(NULLIF(TRIM(mailing_name), ''), name) FROM company LIMIT 1") ?? ctx.company.name;
  if (input.voucherId !== undefined) {
    if (!can(ctx, 'vouchers.view')) throw forbidden('You do not have permission to view vouchers.');
    const env = loadPrintEnv(ctx);
    const doc = buildPrintData(env, input.voucherId);
    const partyId = ctx.db.value<number | null>('SELECT party_ledger_id FROM vouchers WHERE id = :id', { id: input.voucherId }) ?? null;
    const party = contactOf(ctx, partyId ?? inferredParty(ctx, input.voucherId));
    const label = [doc.title, doc.number].filter(Boolean).join(' ');
    return {
      kind: 'voucher',
      label,
      entityType: 'voucher',
      entityId: input.voucherId,
      party,
      values: {
        document: doc.title,
        number: doc.number,
        date: formatDate(doc.date),
        amount: formatMoney(Math.abs(doc.totals.grandTotal)),
        party: doc.party?.name ?? party?.name ?? null,
        company,
      },
      fileName: `${label}${doc.party?.name ? ` - ${doc.party.name}` : ''}`,
    };
  }
  if (input.statement) {
    if (!can(ctx, 'reports.view')) throw forbidden('You do not have permission to view reports.');
    const { ledgerId, from, to } = input.statement;
    if (from > to) throw validation([{ path: 'statement.to', message: 'The end date must be on or after the start date' }]);
    const party = contactOf(ctx, ledgerId);
    if (!party) throw notFound('Ledger', ledgerId);
    const bal = ledgerBalance(ctx.db, ledgerId, { from, to, today: ctx.clock.today() });
    const closing = bal.closing;
    return {
      kind: 'statement',
      label: `Statement of Account — ${party.name}`,
      entityType: 'ledger',
      entityId: ledgerId,
      party,
      values: {
        document: 'Statement of Account',
        number: '',
        date: formatDate(to),
        amount: `${formatMoney(Math.abs(closing))}${closing === 0 ? '' : closing > 0 ? ' Dr' : ' Cr'}`,
        party: party.name,
        company,
        period: `${formatDate(from)} to ${formatDate(to)}`,
      },
      fileName: `Statement ${party.name} ${from} to ${to}`,
    };
  }
  throw validation([{ path: 'voucherId', message: 'Choose the voucher or statement to share' }]);
}

export function shareContext(ctx: CompanyCtx, input: ShareSubjectInput): ShareContext {
  const s = subjectOf(ctx, input);
  const templates = getConfig(ctx.db).share;
  return {
    kind: s.kind,
    label: s.label,
    partyLedgerId: s.party?.id ?? null,
    partyName: s.party?.name ?? (s.values.party || null),
    email: s.party?.email ?? null,
    mobile: s.party?.mobile ?? null,
    subject: oneLine(fillShareTemplate(templates.emailSubject, s.values)),
    body: fillShareTemplate(templates.emailBody, s.values),
    whatsappText: fillShareTemplate(templates.whatsappText, s.values),
    fileName: s.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Document',
  };
}

/** Edit-log entry for a share (called by the renderer before main renders and sends the file). */
export function logShare(ctx: CompanyCtx, input: ShareLogInput): { ok: true } {
  const s = subjectOf(ctx, input);
  const how = input.channel === 'email' ? 'e-mail' : 'WhatsApp';
  ctx.audit({
    action: 'export',
    entityType: s.entityType,
    entityId: s.entityId,
    entityLabel: `${s.label} shared by ${how}`,
    after: { channel: input.channel, to: input.to?.trim() || null, file: input.fileName, format: 'pdf' },
  });
  return { ok: true };
}

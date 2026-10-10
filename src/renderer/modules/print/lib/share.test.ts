import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ShareContext } from '../../../../shared/types/print.ts';
import { initialDraft, normaliseMobile, recipients, shareDoneMessage, shareErrors } from './share.ts';

const ctx: ShareContext = {
  kind: 'voucher',
  label: 'Tax Invoice 12',
  partyLedgerId: 5,
  partyName: 'Sharma Traders',
  email: 'a@b.in',
  mobile: '9876543210',
  subject: 'Tax Invoice 12',
  body: 'Dear Sharma Traders',
  whatsappText: 'Hi',
  fileName: 'Tax Invoice 12',
};

describe('share dialog rules', () => {
  it('prefers e-mail when the party has an address, else WhatsApp with a mobile', () => {
    assert.equal(initialDraft(ctx).channel, 'email');
    assert.equal(initialDraft({ ...ctx, email: null }).channel, 'whatsapp');
    assert.equal(initialDraft({ ...ctx, email: null, mobile: null }).channel, 'email');
    assert.equal(initialDraft(ctx, 'whatsapp').channel, 'whatsapp');
    assert.equal(initialDraft(ctx).to, 'a@b.in');
  });

  it('validates recipients and texts per channel', () => {
    const d = initialDraft(ctx);
    assert.deepEqual(shareErrors(d), {});
    assert.deepEqual(shareErrors({ ...d, to: '' }), {}, 'no recipient: fill it in the mail program');
    assert.match(shareErrors({ ...d, to: 'a@b.in, nope' }).to ?? '', /“nope” is not a valid/);
    assert.match(shareErrors({ ...d, subject: 'a\nb' }).subject ?? '', /single line/);
    assert.match(shareErrors({ ...d, subject: ' ' }).subject ?? '', /Enter a subject/);
    const w = { ...d, channel: 'whatsapp' as const };
    assert.deepEqual(shareErrors(w), {});
    assert.deepEqual(shareErrors({ ...w, mobile: '' }), {});
    assert.match(shareErrors({ ...w, mobile: '022 2345 6789' }).mobile ?? '', /10-digit/);
    assert.match(shareErrors({ ...w, whatsappText: '' }).whatsappText ?? '', /short message/);
    assert.deepEqual(recipients('a@b.in; c@d.in,'), ['a@b.in', 'c@d.in']);
    assert.equal(normaliseMobile('+91 98765-43210'), '9876543210');
    assert.equal(normaliseMobile('98765abc10'), '');
  });

  it('explains what happened after sharing', () => {
    assert.equal(shareDoneMessage('email', 'draft').title, 'E-mail draft opened');
    assert.match(shareDoneMessage('email', 'mailto').message, /attach the PDF/);
    assert.equal(shareDoneMessage('whatsapp', true).title, 'WhatsApp opened');
    assert.equal(shareDoneMessage('whatsapp', false).title, 'PDF saved');
  });
});

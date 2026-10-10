import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from './settings.ts';
import { fillShareTemplate, oneLine, shareTemplateErrors } from './shareText.ts';

describe('fillShareTemplate', () => {
  const values = { document: 'Tax Invoice', number: 'INV/12', date: '09-Oct-2026', amount: '1,180.00', party: 'Sharma Traders', company: 'Acme Pvt Ltd' };

  it('fills the default templates', () => {
    assert.equal(fillShareTemplate(DEFAULT_CONFIG.share.emailSubject, values), 'Tax Invoice INV/12 dated 09-Oct-2026 — Acme Pvt Ltd');
    assert.equal(
      fillShareTemplate(DEFAULT_CONFIG.share.whatsappText, values),
      'Dear Sharma Traders, please find Tax Invoice INV/12 dated 09-Oct-2026 for ₹ 1,180.00 from Acme Pvt Ltd. The PDF is attached.',
    );
    const body = fillShareTemplate(DEFAULT_CONFIG.share.emailBody, values);
    assert.ok(body.startsWith('Dear Sharma Traders,\n\nPlease find attached Tax Invoice INV/12'));
    assert.ok(body.endsWith('Regards,\nAcme Pvt Ltd'));
  });

  it('is case-insensitive, keeps unknown placeholders and tidies missing values', () => {
    assert.equal(fillShareTemplate('{Document} {NUMBER} {nope}', values), 'Tax Invoice INV/12 {nope}');
    assert.equal(fillShareTemplate('Dear {party} , statement for {period}.', { party: null, period: '' }), 'Dear, statement for.');
  });

  it('subjects are one line; template errors are explained', () => {
    assert.equal(oneLine(' a\r\nb\tc  d '), 'a b c d');
    assert.deepEqual(shareTemplateErrors(DEFAULT_CONFIG.share), {});
    assert.match(shareTemplateErrors({ ...DEFAULT_CONFIG.share, emailSubject: 'a\nb' }).emailSubject ?? '', /single line/);
    assert.match(shareTemplateErrors({ ...DEFAULT_CONFIG.share, whatsappText: 'x'.repeat(1001) }).whatsappText ?? '', /1,000/);
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  base64Lines,
  buildDraftEml,
  encodeHeader,
  freeFileName,
  indianMobileForWhatsapp,
  mailtoUrl,
  parseRecipients,
  rfc5322Date,
  sharedExportsDir,
  validEmailAddress,
  whatsappUrl,
} from './share.ts';
import { parseExternalUrl } from './policy.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahi-share-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sharedExportsDir', () => {
  it('is <data>/companies/<id>/exports/shared and refuses unsafe ids', () => {
    assert.equal(sharedExportsDir(dir, 'acme-traders-ab12cd'), path.join(dir, 'companies', 'acme-traders-ab12cd', 'exports', 'shared'));
    assert.equal(sharedExportsDir(dir, '../evil'), null);
    assert.equal(sharedExportsDir(dir, 'a/b'), null);
    assert.equal(sharedExportsDir(dir, ''), null);
    assert.equal(sharedExportsDir('', 'acme'), null);
    assert.equal(sharedExportsDir('relative', 'acme'), null);
  });
});

describe('freeFileName', () => {
  it('sanitises and never overwrites', async () => {
    assert.equal(await freeFileName(dir, 'Tax Invoice 12/2026: Acme.pdf', '.pdf'), 'Tax Invoice 12 2026 Acme.pdf');
    fs.writeFileSync(path.join(dir, 'Invoice 1.pdf'), 'x');
    assert.equal(await freeFileName(dir, 'Invoice 1', '.pdf'), 'Invoice 1 (2).pdf');
    fs.writeFileSync(path.join(dir, 'Invoice 1 (2).pdf'), 'x');
    assert.equal(await freeFileName(dir, 'Invoice 1.pdf', '.pdf'), 'Invoice 1 (3).pdf');
    assert.equal(await freeFileName(dir, '..', '.eml'), 'document.eml');
  });
});

describe('addresses and numbers', () => {
  it('validates e-mail addresses and refuses header injection', () => {
    assert.equal(validEmailAddress('accounts@sharma-traders.co.in'), true);
    assert.equal(validEmailAddress('a.b+c@x.in'), true);
    assert.equal(validEmailAddress('no-at-sign'), false);
    assert.equal(validEmailAddress('x@y.in\r\nBcc: evil@z.com'), false);
    assert.equal(validEmailAddress('Name <x@y.in>'), false);
    assert.deepEqual(parseRecipients('a@b.in; c@d.com, '), ['a@b.in', 'c@d.com']);
    assert.deepEqual(parseRecipients(''), []);
    assert.equal(parseRecipients('a@b.in, bad'), null);
  });

  it('normalises Indian mobiles for wa.me', () => {
    assert.equal(indianMobileForWhatsapp('9876543210'), '919876543210');
    assert.equal(indianMobileForWhatsapp('+91 98765 43210'), '919876543210');
    assert.equal(indianMobileForWhatsapp('098765-43210'), '919876543210');
    assert.equal(indianMobileForWhatsapp('919876543210'), '919876543210');
    assert.equal(indianMobileForWhatsapp('022 2345 6789'), null, 'landline');
    assert.equal(indianMobileForWhatsapp('5876543210'), null, 'mobiles start 6-9');
    assert.equal(indianMobileForWhatsapp('98765abc10'), null);
    assert.equal(indianMobileForWhatsapp(undefined), null);
  });

  it('builds wa.me links that pass the external-link policy', () => {
    const url = whatsappUrl('919876543210', 'Invoice 12 for ₹1,180.00 & thanks');
    assert.equal(url, 'https://wa.me/919876543210?text=Invoice%2012%20for%20%E2%82%B91%2C180.00%20%26%20thanks');
    assert.ok(parseExternalUrl(url));
    assert.equal(whatsappUrl(null, 'Hi'), 'https://wa.me/?text=Hi');
  });

  it('builds a mailto: fallback', () => {
    const u = mailtoUrl(['a@b.in'], 'Invoice 12', 'Dear Sir,\nPlease find…');
    assert.equal(u, 'mailto:a@b.in?subject=Invoice%2012&body=Dear%20Sir%2C%0APlease%20find%E2%80%A6');
    assert.ok(parseExternalUrl(u));
    const long = mailtoUrl(['a@b.in'], 'Statement', 'हिसाब '.repeat(500));
    assert.ok(long.length <= 2000 && long.includes('%E2%80%A6'), 'shortened with an ellipsis');
    assert.ok(parseExternalUrl(long));
  });
});

describe('buildDraftEml', () => {
  const pdf = new Uint8Array(Buffer.from('%PDF-1.7 test'));

  it('is a MIME draft with X-Unsent, a base64 body and the PDF attached', () => {
    const eml = buildDraftEml({
      to: ['accounts@sharma.in'],
      subject: 'Tax Invoice 12 dated 09-Oct-2026',
      body: 'Dear Sharma & Sons,\nPlease find the invoice attached.',
      attachment: { fileName: 'Tax Invoice 12.pdf', contentType: 'application/pdf', bytes: pdf },
      date: new Date(2026, 9, 9, 10, 15, 0),
      boundary: 'B0UND',
    });
    const lines = eml.split('\r\n');
    assert.equal(lines[0], 'X-Unsent: 1');
    assert.ok(lines.includes('To: accounts@sharma.in'));
    assert.ok(lines.includes('Subject: Tax Invoice 12 dated 09-Oct-2026'));
    assert.ok(lines.includes('MIME-Version: 1.0'));
    assert.ok(lines.includes('Content-Type: multipart/mixed; boundary="B0UND"'));
    assert.ok(lines.includes('Content-Disposition: attachment; filename="Tax Invoice 12.pdf"'));
    assert.ok(lines.includes(Buffer.from(pdf).toString('base64')));
    assert.ok(lines.includes(Buffer.from('Dear Sharma & Sons,\r\nPlease find the invoice attached.').toString('base64')));
    assert.ok(eml.endsWith('--B0UND--\r\n'));
    assert.ok(!/\n(?<!\r\n)/.test(eml.replace(/\r\n/g, '')), 'only CRLF line ends');
    assert.equal(lines.some((l) => l.startsWith('From:')), false, 'the mail program fills in From');
  });

  it('encodes non-ASCII subjects and file names; refuses line breaks in headers', () => {
    const eml = buildDraftEml({
      to: [],
      subject: 'बिल 12 – ₹1,180',
      body: 'x',
      attachment: { fileName: 'बिल 12.pdf', contentType: 'application/pdf', bytes: pdf },
      date: new Date(2026, 0, 1),
    });
    assert.match(eml, /Subject: =\?UTF-8\?B\?/);
    assert.match(eml, /filename\*=UTF-8''%E0%A4%AC/);
    assert.ok(!/^To:/m.test(eml));
    assert.throws(() => encodeHeader('a\r\nBcc: x@y.z'), /line breaks/);
    assert.throws(() =>
      buildDraftEml({ to: ['bad'], subject: 's', body: 'b', attachment: { fileName: 'a.pdf', contentType: 'application/pdf', bytes: pdf }, date: new Date() }),
    );
  });

  it('keeps encoded words and base64 lines short', () => {
    const subject = 'हिसाब '.repeat(30);
    for (const line of encodeHeader(subject).split('\r\n')) assert.ok(line.length <= 76, line);
    for (const line of base64Lines(new Uint8Array(1000)).split('\r\n')) assert.ok(line.length <= 76);
    assert.equal(Buffer.from(encodeHeader('₹ 100').replace(/=\?UTF-8\?B\?|\?=/g, ''), 'base64').toString('utf8'), '₹ 100');
  });

  it('formats RFC 5322 dates', () => {
    assert.match(rfc5322Date(new Date(2026, 9, 9, 7, 5, 3)), /^Fri, 09 Oct 2026 07:05:03 [+-]\d{4}$/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG } from '../../../../shared/settings.ts';
import { assertPrintableMarkup, buildPrintHtml } from './document.ts';
import { DOCUMENT_CSS, pageCss, previewCss } from './styles.ts';
import { normaliseOptions, previewOverrides, sameOptions, settingsErrors, cycle, orderedSelection, toggleAll, toggleId, batchKind } from './screenState.ts';

describe('printable HTML document', () => {
  it('is self-contained: doctype, charset, escaped title, inline CSS, page rules', () => {
    const html = buildPrintHtml({ title: 'Tax Invoice <1> & "Co"', body: '<div class="bp-docs"><p>A &amp; B &lt;x&gt;</p></div>', pageSize: 'A4', documents: 1 });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<title>Tax Invoice &lt;1&gt; &amp; &quot;Co&quot;<\/title>/);
    assert.match(html, /@page \{ size: A4 portrait;/);
    assert.match(html, /counter\(page\) " of " counter\(pages\)/);
    assert.match(html, /<body><div class="bp-docs"><p>A &amp; B &lt;x&gt;<\/p><\/div><\/body>/);
    assert.doesNotMatch(html, /<script|<link|https?:\/\//i);
  });

  it('page numbers: "of" for one document, plain for several, none on 80 mm rolls', () => {
    assert.doesNotMatch(buildPrintHtml({ title: 't', body: '<div></div>', pageSize: 'A5', documents: 3 }), /counter\(pages\)/);
    assert.match(buildPrintHtml({ title: 't', body: '<div></div>', pageSize: 'A5', documents: 3 }), /size: A5 portrait/);
    assert.doesNotMatch(pageCss('80mm', { pageNumbers: 'of' }), /counter/);
    assert.match(pageCss('80mm', { pageNumbers: 'of' }), /size: 80mm 297mm/);
    // The receipt keeps its 72 mm printable width on any sheet (thermal roll or an A4 PDF page).
    assert.match(pageCss('80mm', { pageNumbers: 'none' }), /\.bp-docs\.bp-size-80mm \.bp-doc \{ width: 72mm; max-width: 100%; margin: 0 auto; \}/);
    assert.doesNotMatch(pageCss('A4', { pageNumbers: 'of' }), /72mm/);
  });

  it('rejects scripts, handlers, frames and external resources — but not harmless text', () => {
    const bad = [
      '<div><script>alert(1)</script></div>',
      '<img src="x" onerror="alert(1)">',
      '<iframe src="data:text/html,x"></iframe>',
      '<img src="https://evil.example/x.png">',
      '<a href="javascript:alert(1)">x</a>',
      '<div style="background:url(https://evil.example/a)"></div>',
      '<link rel="stylesheet" href="x.css">',
    ];
    for (const b of bad) assert.throws(() => assertPrintableMarkup(b), /could not be printed/, b);
    // Text content is escaped by the serialiser, so these are plain words on the page.
    assert.doesNotThrow(() => assertPrintableMarkup('<p>Pay online= see https://example.com &lt;script&gt; url(https://x)</p>'));
    assert.doesNotThrow(() => assertPrintableMarkup('<img class="bp-qr" src="data:image/png;base64,iVBORw0KGgo=" alt="UPI QR code">'));
    assert.throws(() => buildPrintHtml({ title: 'x', body: '<script></script>', pageSize: 'A4', documents: 1 }));
  });

  it('stylesheets use no raw colours and cannot close the style element', () => {
    for (const css of [DOCUMENT_CSS, previewCss('A4'), pageCss('A4', { pageNumbers: 'of' })]) {
      assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no hex colours');
      assert.doesNotMatch(css, /\b(rgb|rgba|hsl|hsla)\(/i, 'no rgb()/hsl() colours');
      assert.doesNotMatch(css, /<\/style/i);
    }
    assert.match(DOCUMENT_CSS, /color-scheme: light/);
    assert.match(DOCUMENT_CSS, /thead \{ display: table-header-group; \}/, 'table headers repeat on every page');
    assert.match(DOCUMENT_CSS, /tr, \.bp-avoid \{ break-inside: avoid; \}/, 'rows never split across pages');
    assert.match(DOCUMENT_CSS, /\.bp-doc \+ \.bp-doc \{ break-before: page; \}/, 'each copy starts a new page');
  });
});

describe('screen state helpers', () => {
  it('cycle wraps', () => {
    assert.equal(cycle(['a', 'b', 'c'], 'c'), 'a');
    assert.equal(cycle(['a', 'b', 'c'], 'a'), 'b');
  });
  it('batch selection keeps list order', () => {
    let s = toggleId(new Set(), 5);
    s = toggleId(s, 2);
    assert.deepEqual(orderedSelection(s, [1, 2, 3, 5]), [2, 5]);
    s = toggleId(s, 2);
    assert.deepEqual([...s], [5]);
    assert.deepEqual([...toggleAll(new Set([1]), [1, 2])], [1, 2]);
    assert.deepEqual([...toggleAll(new Set([1, 2]), [1, 2])], []);
    assert.equal(batchKind('nope').value, 'sales');
    assert.deepEqual(batchKind('notes').baseTypes, ['credit_note', 'debit_note']);
  });
  it('settings validation', () => {
    const base = DEFAULT_CONFIG.invoice;
    assert.deepEqual(settingsErrors(base), {});
    assert.equal(settingsErrors({ ...base, copies: [] }).copies, 'Choose at least one copy to print.');
    assert.match(settingsErrors({ ...base, showUpiQr: true, upiId: '' }).upiId ?? '', /Enter the UPI ID/);
    assert.match(settingsErrors({ ...base, upiId: 'shop' }).upiId ?? '', /UPI ID is invalid/);
    assert.deepEqual(settingsErrors({ ...base, showUpiQr: true, upiId: 'shop@okhdfcbank' }), {});
  });
  it('dirty check and preview overrides', () => {
    const base = DEFAULT_CONFIG.invoice;
    assert.equal(sameOptions(normaliseOptions({ ...base, copies: ['duplicate', 'original'] }), normaliseOptions({ ...base, copies: ['original', 'duplicate'] })), true);
    assert.equal(sameOptions(base, { ...base, terms: 'x' }), false);
    const o = previewOverrides({ ...base, showUpiQr: true, upiId: 'sho', copies: [] });
    assert.equal(o.upiId, '', 'an incomplete UPI id is not sent to the preview');
    assert.equal(o.showUpiQr, false);
    assert.equal(o.copies, undefined);
    assert.equal(previewOverrides({ ...base, upiId: ' ab@okaxis ' }).upiId, 'ab@okaxis');
  });
});

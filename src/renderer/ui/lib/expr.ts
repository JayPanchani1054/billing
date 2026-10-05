/**
 * Safe arithmetic for numeric/amount inputs — a hand-written recursive-descent parser (no eval,
 * no Function constructor). Accountants type things like `1200*3`, `(450+50)/2`, `1,20,000 - 5%`.
 *
 * Grammar (whitespace ignored):
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | 'x' | '×' | '/' | '÷') unary)*
 *   unary   := ('+' | '-') unary | postfix
 *   postfix := primary '%'?
 *   primary := number | '(' expr ')'
 *   number  := digits with optional Indian/Western grouping commas and one decimal point
 *
 * Percent semantics follow desk calculators:
 *   `a * b%`  → a × b / 100           (`1000*18%` = 180)
 *   `a + b%`  → a + a × b / 100       (`1000+18%` = 1180)   — also for `-`
 *   `b%` alone → b / 100
 */

export type ExprResult = { ok: true; value: number } | { ok: false; error: string };

const MAX_LENGTH = 256;
const MAX_DEPTH = 32;

type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '(' | ')'; pos: number };

function tokenize(src: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === ' ') {
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const start = i;
      let sawDot = false;
      let digits = '';
      while (i < src.length) {
        const c = src[i];
        if (c >= '0' && c <= '9') {
          digits += c;
        } else if (c === ',' && !sawDot && i + 1 < src.length && src[i + 1] >= '0' && src[i + 1] <= '9') {
          // grouping comma — ignored
        } else if (c === '.' && !sawDot) {
          sawDot = true;
          digits += c;
        } else {
          break;
        }
        i++;
      }
      if (digits === '.' || digits === '') return `Unexpected '.' at ${start + 1}`;
      const v = Number(digits);
      if (!Number.isFinite(v)) return 'Number too large';
      out.push({ t: 'num', v, pos: start });
      continue;
    }
    switch (ch) {
      case '+':
      case '-':
      case '*':
      case '/':
      case '%':
      case '(':
      case ')':
        out.push({ t: 'op', v: ch, pos: i });
        break;
      case 'x':
      case 'X':
      case '×':
        out.push({ t: 'op', v: '*', pos: i });
        break;
      case '÷':
        out.push({ t: 'op', v: '/', pos: i });
        break;
      case '−': // unicode minus
        out.push({ t: 'op', v: '-', pos: i });
        break;
      default:
        return `Unexpected '${ch}'`;
    }
    i++;
  }
  return out;
}

interface Term {
  value: number;
  /** True when the term is exactly one percentage factor (`18%`) — enables `a + b%` semantics. */
  bareIsPercent: boolean;
}

class Parser {
  private i = 0;
  private depth = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private isOp(v: string): boolean {
    const tok = this.tokens[this.i];
    return tok !== undefined && tok.t === 'op' && tok.v === v;
  }

  parse(): number {
    const v = this.expr().value;
    const rest = this.peek();
    if (rest) throw new SyntaxError(rest.t === 'op' && rest.v === ')' ? "Unmatched ')'" : 'Unexpected input');
    return v;
  }

  private expr(): Term {
    let left = this.term();
    let single = true;
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.i++] as { v: string }).v;
      const right = this.term();
      const rhs = right.bareIsPercent ? (left.value * right.value) : right.value;
      left = { value: op === '+' ? left.value + rhs : left.value - rhs, bareIsPercent: false };
      single = false;
    }
    return single ? left : { value: left.value, bareIsPercent: false };
  }

  private term(): Term {
    let left = this.unary();
    let single = true;
    while (this.isOp('*') || this.isOp('/')) {
      const op = (this.tokens[this.i++] as { v: string }).v;
      const right = this.unary();
      if (op === '/') {
        if (right.value === 0) throw new RangeError('Cannot divide by zero');
        left = { value: left.value / right.value, bareIsPercent: false };
      } else {
        left = { value: left.value * right.value, bareIsPercent: false };
      }
      single = false;
    }
    return single ? left : { value: left.value, bareIsPercent: false };
  }

  private unary(): Term {
    if (this.isOp('-') || this.isOp('+')) {
      const neg = this.isOp('-');
      this.i++;
      const inner = this.unary();
      return { value: neg ? -inner.value : inner.value, bareIsPercent: inner.bareIsPercent };
    }
    return this.postfix();
  }

  private postfix(): Term {
    const v = this.primary();
    if (this.isOp('%')) {
      this.i++;
      return { value: v / 100, bareIsPercent: true };
    }
    return { value: v, bareIsPercent: false };
  }

  private primary(): number {
    const tok = this.peek();
    if (!tok) throw new SyntaxError('Incomplete expression');
    if (tok.t === 'num') {
      this.i++;
      return tok.v;
    }
    if (tok.v === '(') {
      if (++this.depth > MAX_DEPTH) throw new RangeError('Too many brackets');
      this.i++;
      const v = this.expr().value;
      if (!this.isOp(')')) throw new SyntaxError("Missing ')'");
      this.i++;
      this.depth--;
      return v;
    }
    throw new SyntaxError(`Unexpected '${tok.v}'`);
  }
}

/** Evaluate an arithmetic expression. Never throws. */
export function evaluateExpression(input: string): ExprResult {
  const src = input.trim();
  if (src === '') return { ok: false, error: 'Empty' };
  if (src.length > MAX_LENGTH) return { ok: false, error: 'Expression is too long' };
  const tokens = tokenize(src);
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  try {
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) return { ok: false, error: 'Result is not a finite number' };
    return { ok: true, value: value === 0 ? 0 : value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid expression' };
  }
}

/**
 * True when the text contains an operator beyond a single leading sign — i.e. it should be
 * evaluated as an expression rather than parsed as a plain number.
 */
export function looksLikeExpression(input: string): boolean {
  const s = input.trim().replace(/^[+\-−]/, '');
  return /[+\-−*/x×÷%()]/i.test(s);
}

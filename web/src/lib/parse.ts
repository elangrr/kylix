// Parsing what the chain returns and quoting what we send to it.
//
// vm/qeval answers with one "(value type)" group per returned value, for
// example:
//
//   (1 uint64)
//   ("g1hq2j..." .uverse.address)
//   ("{\"height\":1}" string)
//   (struct{(4 uint64),("g1..." .uverse.address)} gno.land/r/x.Offer)
//   (undefined)
//
// Strings are Go-quoted (strconv.Quote).

/** One value from a qeval result. `fields` is set for structs. */
export interface GnoValue {
  type: string;
  /** The literal: a decoded string for strings, the raw text otherwise ("" for an empty address). */
  value: string;
  fields?: GnoValue[];
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Parses every top-level "(value type)" group in a qeval result. */
export function parseQeval(text: string): GnoValue[] {
  const p = new Parser(text);
  const out: GnoValue[] = [];
  for (;;) {
    p.skipSpace();
    if (p.done()) break;
    out.push(p.group());
  }
  return out;
}

/** The i-th value, which must be a string. */
export function qevalString(text: string, i = 0): string {
  const v = nth(text, i);
  if (v.type !== 'string') throw new ParseError(`expected a string, got ${v.type}`);
  return v.value;
}

/** The i-th value, which must be an integer of any width. */
export function qevalInt(text: string, i = 0): bigint {
  const v = nth(text, i);
  if (!/^-?\d+$/.test(v.value)) throw new ParseError(`expected an integer, got ${v.type} ${v.value}`);
  return BigInt(v.value);
}

/** The i-th value, which must be a bool. */
export function qevalBool(text: string, i = 0): boolean {
  const v = nth(text, i);
  if (v.type !== 'bool') throw new ParseError(`expected a bool, got ${v.type}`);
  return v.value === 'true';
}

/** The i-th value, which must be an address; "" for the empty address. */
export function qevalAddress(text: string, i = 0): string {
  const v = nth(text, i);
  if (v.type !== '.uverse.address' && v.type !== 'address') {
    throw new ParseError(`expected an address, got ${v.type}`);
  }
  return v.value;
}

/** Whether the i-th value is the "(undefined)" a missing map entry gives. */
export function qevalIsUndefined(text: string, i = 0): boolean {
  return nth(text, i).type === 'undefined';
}

function nth(text: string, i: number): GnoValue {
  const all = parseQeval(text);
  const v = all[i];
  if (!v) throw new ParseError(`qeval result has ${all.length} values, wanted index ${i}`);
  return v;
}

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  done(): boolean {
    return this.i >= this.s.length;
  }

  skipSpace(): void {
    while (!this.done() && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private expect(c: string): void {
    if (this.s[this.i] !== c) {
      throw new ParseError(`expected '${c}' at ${this.i}, got '${this.s[this.i] ?? 'end'}'`);
    }
    this.i++;
  }

  group(): GnoValue {
    this.expect('(');
    if (this.s.startsWith('undefined)', this.i)) {
      this.i += 'undefined)'.length;
      return { type: 'undefined', value: '' };
    }
    let value = '';
    let fields: GnoValue[] | undefined;
    const c = this.s[this.i];
    if (c === '"') {
      value = this.quoted();
    } else if (this.s.startsWith('struct{', this.i)) {
      this.i += 'struct{'.length;
      fields = [];
      for (;;) {
        if (this.s[this.i] === '}') {
          this.i++;
          break;
        }
        fields.push(this.group());
        if (this.s[this.i] === ',') this.i++;
      }
    } else {
      const start = this.i;
      while (!this.done() && this.s[this.i] !== ' ' && this.s[this.i] !== ')') this.i++;
      value = this.s.slice(start, this.i);
    }
    // The type runs to the matching ')'. Types we read have no parentheses,
    // but count them anyway.
    if (this.s[this.i] === ')') {
      this.i++;
      return { type: value, value: '' }; // "(nil)" and similar: a bare word
    }
    this.expect(' ');
    const start = this.i;
    let depth = 0;
    while (!this.done()) {
      const ch = this.s[this.i]!;
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        if (depth === 0) break;
        depth--;
      }
      this.i++;
    }
    const type = this.s.slice(start, this.i);
    this.expect(')');
    return fields ? { type, value: '', fields } : { type, value };
  }

  private quoted(): string {
    const start = this.i;
    this.i++; // opening quote
    while (!this.done()) {
      const ch = this.s[this.i]!;
      if (ch === '\\') {
        this.i += 2;
        continue;
      }
      if (ch === '"') {
        this.i++;
        return unquoteGo(this.s.slice(start, this.i));
      }
      this.i++;
    }
    throw new ParseError('unterminated string');
  }
}

/** Decodes a Go interpreted string literal, quotes included. */
export function unquoteGo(lit: string): string {
  if (lit.length < 2 || lit[0] !== '"' || lit[lit.length - 1] !== '"') {
    throw new ParseError('not a quoted string');
  }
  const body = lit.slice(1, -1);
  const bytes: number[] = [];
  const enc = new TextEncoder();
  const pushText = (t: string) => {
    for (const b of enc.encode(t)) bytes.push(b);
  };
  for (let i = 0; i < body.length; ) {
    const ch = body[i]!;
    if (ch !== '\\') {
      // Copy a run of plain characters at once (keeps surrogate pairs whole).
      let j = i;
      while (j < body.length && body[j] !== '\\') j++;
      pushText(body.slice(i, j));
      i = j;
      continue;
    }
    const e = body[i + 1];
    i += 2;
    switch (e) {
      case 'a': bytes.push(7); break;
      case 'b': bytes.push(8); break;
      case 'f': bytes.push(12); break;
      case 'n': bytes.push(10); break;
      case 'r': bytes.push(13); break;
      case 't': bytes.push(9); break;
      case 'v': bytes.push(11); break;
      case '\\': bytes.push(92); break;
      case '"': bytes.push(34); break;
      case "'": bytes.push(39); break;
      case 'x': bytes.push(hex(body, i, 2)); i += 2; break;
      case 'u': pushText(String.fromCodePoint(hex(body, i, 4))); i += 4; break;
      case 'U': pushText(String.fromCodePoint(hex(body, i, 8))); i += 8; break;
      default:
        if (e !== undefined && e >= '0' && e <= '7') {
          const oct = body.slice(i - 1, i + 2);
          if (!/^[0-7]{3}$/.test(oct)) throw new ParseError('bad octal escape');
          bytes.push(parseInt(oct, 8));
          i += 2;
          break;
        }
        throw new ParseError(`bad escape \\${e ?? ''}`);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function hex(s: string, at: number, n: number): number {
  const h = s.slice(at, at + n);
  if (h.length !== n || !/^[0-9a-fA-F]+$/.test(h)) throw new ParseError('bad hex escape');
  return parseInt(h, 16);
}

// --- Quoting values into qeval expressions ------------------------------------
//
// A qeval expression is Gno source. Every value from outside goes in through
// these functions, never by string concatenation of raw input.

/** A Go string literal for s. JSON escapes are all valid Go escapes. */
export function goString(s: string): string {
  // With the u flag this matches only unpaired surrogates.
  if (/[\uD800-\uDFFF]/u.test(s)) {
    throw new ParseError('string has a lone surrogate');
  }
  return JSON.stringify(s);
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const ADDRESS_RE = new RegExp(`^g1[${BECH32}]{38}$`);

/** Whether s looks like a Gno account or realm address (g1 + 38 bech32 characters). */
export function isAddress(s: string): boolean {
  return ADDRESS_RE.test(s);
}

export function assertAddress(s: string, what = 'address'): string {
  if (!isAddress(s)) throw new ParseError(`invalid ${what}: ${JSON.stringify(s)}`);
  return s;
}

/** A positive offer id that fits in a JS number. */
export function assertOfferId(id: number): number {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ParseError(`invalid offer id ${id}`);
  return id;
}

// --- Base64 (browser and Node both have atob/btoa) -----------------------------

export function base64FromText(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function textFromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** "34668423ugnot" or "1ugnot,5foo" -> the ugnot amount (0 when absent). */
export function ugnotFromCoins(coins: string): bigint {
  for (const part of coins.split(',')) {
    const m = /^\s*(\d+)ugnot\s*$/.exec(part);
    if (m) return BigInt(m[1]!);
  }
  return 0n;
}

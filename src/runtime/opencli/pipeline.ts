/**
 * Browser-safe shim of @jackwener/opencli/pipeline.
 *
 * opencli adapters can declare a `pipeline` (declarative fetch + transform
 * spec) instead of a `func` — e.g. hackernews/*, coingecko/*, weather/*,
 * wikipedia/*. The extension dispatcher runs that pipeline through here.
 *
 * Why this isn't a verbatim copy of opencli/src/pipeline:
 *
 *   1. MV3 CSP forbids `eval` / `new Function` in the service worker, but
 *      opencli's expr.ts evaluates `${{ ... }}` via `new Function`. So this
 *      file ships a small SAFE expression evaluator (a recursive-descent
 *      interpreter over an AST — no eval) covering the JS subset the adapter
 *      corpus actually uses: member/index access, calls (Math.min, Number(),
 *      .toFixed, .toUpperCase, .length, …), ternaries, arithmetic/logical/
 *      comparison ops, string concat, array/object literals.
 *
 *   2. opencli's vendored executor.ts runs each `fetch` step exactly once and
 *      wraps primitive array elements as `{value: d}`. That's an early version:
 *      the shipped adapters need (a) PER-ROW fetch — `fetch item/${{item.id}}`
 *      after a list fetch must run once per row, replacing each row with its
 *      result — and (b) `${{ item }}` to yield the raw primitive (top.js)
 *      while `${{ item.value }}` ALSO yields it (jobs.js). We satisfy both by
 *      keeping primitives raw and making `.value` on a primitive return the
 *      primitive. Verified against the real HN API.
 *
 * Resolved via the Vite/vitest alias `@jackwener/opencli/pipeline` -> here.
 */

/* ───────────────────────── expression evaluator ───────────────────────── */

type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'undef' }
  | { t: 'id'; name: string }
  | { t: 'arr'; items: Node[] }
  | { t: 'obj'; props: { key: string; val: Node }[] }
  | { t: 'member'; obj: Node; prop: string; computed?: Node; optional?: boolean }
  | { t: 'call'; callee: Node; args: Node[]; optional?: boolean }
  | { t: 'new'; callee: Node; args: Node[] }
  | { t: 'unary'; op: string; arg: Node }
  | { t: 'binary'; op: string; left: Node; right: Node }
  | { t: 'logical'; op: '&&' | '||' | '??'; left: Node; right: Node }
  | { t: 'ternary'; test: Node; cons: Node; alt: Node };

interface Tok {
  type: 'num' | 'str' | 'id' | 'punc';
  value: string;
}

const PUNCT3 = ['===', '!=='];
// `?.` and `??` must be matched before the single-char `?` / `.`.
const PUNCT2 = ['??', '?.', '==', '!=', '<=', '>=', '&&', '||'];
const PUNCT1 = ['.', ',', '(', ')', '[', ']', '{', '}', ':', '?', '!', '+', '-', '*', '/', '%', '<', '>'];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    // string
    if (c === '"' || c === "'") {
      const quote = c;
      let s = '';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 2;
        } else {
          s += src[i++];
        }
      }
      i++; // closing quote
      toks.push({ type: 'str', value: s });
      continue;
    }
    // number
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let num = '';
      while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) num += src[i++];
      toks.push({ type: 'num', value: num });
      continue;
    }
    // identifier
    if (/[A-Za-z_$]/.test(c)) {
      let id = '';
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) id += src[i++];
      toks.push({ type: 'id', value: id });
      continue;
    }
    // punctuators (longest match first)
    const three = src.slice(i, i + 3);
    if (PUNCT3.includes(three)) {
      toks.push({ type: 'punc', value: three });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      toks.push({ type: 'punc', value: two });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(c)) {
      toks.push({ type: 'punc', value: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in expression`);
  }
  return toks;
}

const KEYWORDS: Record<string, Node> = {
  true: { t: 'bool', v: true },
  false: { t: 'bool', v: false },
  null: { t: 'null' },
  undefined: { t: 'undef' },
};

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}

  parse(): Node {
    const node = this.ternary();
    if (this.p < this.toks.length) {
      throw new Error(`Unexpected token '${this.toks[this.p].value}'`);
    }
    return node;
  }

  private peek(): Tok | undefined {
    return this.toks[this.p];
  }
  private eat(value?: string): Tok {
    const t = this.toks[this.p];
    if (!t) throw new Error('Unexpected end of expression');
    if (value !== undefined && t.value !== value) {
      throw new Error(`Expected '${value}' but got '${t.value}'`);
    }
    this.p++;
    return t;
  }
  private isPunc(v: string): boolean {
    const t = this.peek();
    return !!t && t.type === 'punc' && t.value === v;
  }

  private ternary(): Node {
    const test = this.logicalOr();
    if (this.isPunc('?')) {
      this.eat('?');
      const cons = this.ternary();
      this.eat(':');
      const alt = this.ternary();
      return { t: 'ternary', test, cons, alt };
    }
    return test;
  }
  private logicalOr(): Node {
    let left = this.logicalAnd();
    // `||` and `??` share this level. JS forbids mixing them without parens;
    // the adapter corpus always parenthesizes or uses one kind, so a flat
    // left-assoc loop matches every real expression.
    while (this.isPunc('||') || this.isPunc('??')) {
      const op = this.eat().value as '||' | '??';
      left = { t: 'logical', op, left, right: this.logicalAnd() };
    }
    return left;
  }
  private logicalAnd(): Node {
    let left = this.equality();
    while (this.isPunc('&&')) {
      this.eat();
      left = { t: 'logical', op: '&&', left, right: this.equality() };
    }
    return left;
  }
  private equality(): Node {
    let left = this.relational();
    while (this.isPunc('==') || this.isPunc('!=') || this.isPunc('===') || this.isPunc('!==')) {
      const op = this.eat().value;
      left = { t: 'binary', op, left, right: this.relational() };
    }
    return left;
  }
  private relational(): Node {
    let left = this.additive();
    while (this.isPunc('<') || this.isPunc('>') || this.isPunc('<=') || this.isPunc('>=')) {
      const op = this.eat().value;
      left = { t: 'binary', op, left, right: this.additive() };
    }
    return left;
  }
  private additive(): Node {
    let left = this.multiplicative();
    while (this.isPunc('+') || this.isPunc('-')) {
      const op = this.eat().value;
      left = { t: 'binary', op, left, right: this.multiplicative() };
    }
    return left;
  }
  private multiplicative(): Node {
    let left = this.unary();
    while (this.isPunc('*') || this.isPunc('/') || this.isPunc('%')) {
      const op = this.eat().value;
      left = { t: 'binary', op, left, right: this.unary() };
    }
    return left;
  }
  private unary(): Node {
    if (this.isPunc('!') || this.isPunc('-') || this.isPunc('+')) {
      const op = this.eat().value;
      return { t: 'unary', op, arg: this.unary() };
    }
    const t = this.peek();
    if (t && t.type === 'id' && t.value === 'typeof') {
      this.eat();
      return { t: 'unary', op: 'typeof', arg: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Node {
    let node = this.primary();
    for (;;) {
      if (this.isPunc('.')) {
        this.eat('.');
        const name = this.eat();
        // Allow numeric props after a dot (`item.0`), which the corpus uses.
        if (name.type !== 'id' && name.type !== 'num') {
          throw new Error(`Expected property name after '.'`);
        }
        node = { t: 'member', obj: node, prop: String(name.value) };
      } else if (this.isPunc('?.')) {
        // Optional chaining: a?.b / a?.[i] / a?.(…). In the corpus the optional
        // link is always terminal (followed by ||/??/end), so per-link nullish
        // short-circuit is sufficient — no whole-chain propagation needed.
        this.eat('?.');
        if (this.isPunc('[')) {
          this.eat('[');
          const computed = this.ternary();
          this.eat(']');
          node = { t: 'member', obj: node, prop: '', computed, optional: true };
        } else if (this.isPunc('(')) {
          node = { t: 'call', callee: node, args: this.parseArgs(), optional: true };
        } else {
          const name = this.eat();
          if (name.type !== 'id' && name.type !== 'num') {
            throw new Error(`Expected property name after '?.'`);
          }
          node = { t: 'member', obj: node, prop: String(name.value), optional: true };
        }
      } else if (this.isPunc('[')) {
        this.eat('[');
        const computed = this.ternary();
        this.eat(']');
        node = { t: 'member', obj: node, prop: '', computed };
      } else if (this.isPunc('(')) {
        node = { t: 'call', callee: node, args: this.parseArgs() };
      } else {
        break;
      }
    }
    return node;
  }

  private parseArgs(): Node[] {
    this.eat('(');
    const args: Node[] = [];
    if (!this.isPunc(')')) {
      args.push(this.ternary());
      while (this.isPunc(',')) {
        this.eat(',');
        args.push(this.ternary());
      }
    }
    this.eat(')');
    return args;
  }
  private primary(): Node {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') {
      this.eat();
      return { t: 'num', v: Number(t.value) };
    }
    if (t.type === 'str') {
      this.eat();
      return { t: 'str', v: t.value };
    }
    if (t.type === 'id') {
      // `new X(...)` — only constructors in SAFE_GLOBALS are reachable (Date,
      // Array, Object, …) since identifiers are whitelisted in resolveId.
      if (t.value === 'new') {
        this.eat();
        let callee: Node = this.primary();
        while (this.isPunc('.')) {
          this.eat('.');
          const nm = this.eat();
          callee = { t: 'member', obj: callee, prop: String(nm.value) };
        }
        return { t: 'new', callee, args: this.parseArgs() };
      }
      this.eat();
      if (t.value in KEYWORDS) return KEYWORDS[t.value];
      return { t: 'id', name: t.value };
    }
    if (this.isPunc('(')) {
      this.eat('(');
      const node = this.ternary();
      this.eat(')');
      return node;
    }
    if (this.isPunc('[')) {
      this.eat('[');
      const items: Node[] = [];
      if (!this.isPunc(']')) {
        items.push(this.ternary());
        while (this.isPunc(',')) {
          this.eat(',');
          items.push(this.ternary());
        }
      }
      this.eat(']');
      return { t: 'arr', items };
    }
    if (this.isPunc('{')) {
      this.eat('{');
      const props: { key: string; val: Node }[] = [];
      if (!this.isPunc('}')) {
        do {
          const k = this.eat();
          const key = k.type === 'str' || k.type === 'id' || k.type === 'num' ? k.value : '';
          this.eat(':');
          props.push({ key, val: this.ternary() });
        } while (this.isPunc(',') && (this.eat(','), true));
      }
      this.eat('}');
      return { t: 'obj', props };
    }
    throw new Error(`Unexpected token '${t.value}'`);
  }
}

const astCache = new Map<string, Node>();
function parseExpr(code: string): Node {
  let ast = astCache.get(code);
  if (!ast) {
    ast = new Parser(tokenize(code)).parse();
    astCache.set(code, ast);
  }
  return ast;
}

/** Curated, side-effect-free globals an expression may reference. No `fetch`,
 * `Function`, `eval`, `globalThis`, etc. */
const SAFE_GLOBALS: Record<string, unknown> = {
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Date,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
};

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getMember(obj: unknown, key: string): unknown {
  if (BLOCKED_KEYS.has(key)) {
    throw new Error(`Access to '${key}' is not allowed`);
  }
  if (obj == null) {
    throw new TypeError(`Cannot read properties of ${obj} (reading '${key}')`);
  }
  // Compat shim: `${{ item.value }}` on a primitive row yields the primitive
  // (opencli's old {value:d} wrapping, without actually wrapping).
  const ty = typeof obj;
  if (key === 'value' && (ty === 'number' || ty === 'string' || ty === 'boolean')) {
    return obj;
  }
  return (obj as Record<string, unknown>)[key];
}

interface Scope {
  row?: unknown;
  index?: number;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
  rows?: unknown[];
  count?: number;
  root?: unknown;
  data?: unknown;
}

function resolveId(name: string, scope: Scope): unknown {
  switch (name) {
    case 'row':
    case 'item':
      return scope.row;
    case 'index':
      return scope.index;
    case 'args':
      return scope.args;
    case 'vars':
      return scope.vars;
    case 'rows':
      return scope.rows;
    case 'count':
      return scope.count;
    case 'root':
      return scope.root;
    case 'data':
      return scope.data;
    default:
      if (name in SAFE_GLOBALS) return SAFE_GLOBALS[name];
      throw new Error(`Unknown identifier '${name}'`);
  }
}

function evalNode(node: Node, scope: Scope): unknown {
  switch (node.t) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v;
    case 'null':
      return null;
    case 'undef':
      return undefined;
    case 'id':
      return resolveId(node.name, scope);
    case 'arr':
      return node.items.map((it) => evalNode(it, scope));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const { key, val } of node.props) out[key] = evalNode(val, scope);
      return out;
    }
    case 'member': {
      const obj = evalNode(node.obj, scope);
      if (node.optional && (obj === null || obj === undefined)) return undefined;
      const key = node.computed ? String(evalNode(node.computed, scope)) : node.prop;
      return getMember(obj, key);
    }
    case 'new': {
      const ctor = evalNode(node.callee, scope);
      if (typeof ctor !== 'function') throw new Error('Not a constructor');
      const args = node.args.map((a) => evalNode(a, scope));
      return new (ctor as new (...a: unknown[]) => unknown)(...args);
    }
    case 'call': {
      const args = node.args.map((a) => evalNode(a, scope));
      if (node.callee.t === 'member') {
        const self = evalNode(node.callee.obj, scope);
        if (node.callee.optional && (self === null || self === undefined)) return undefined;
        const key = node.callee.computed
          ? String(evalNode(node.callee.computed, scope))
          : node.callee.prop;
        const fn = getMember(self, key);
        if (node.optional && (fn === null || fn === undefined)) return undefined;
        if (typeof fn !== 'function') throw new Error(`'${key}' is not a function`);
        return (fn as (...a: unknown[]) => unknown).apply(self, args);
      }
      const fn = evalNode(node.callee, scope);
      if (node.optional && (fn === null || fn === undefined)) return undefined;
      if (typeof fn !== 'function') throw new Error(`Not a function`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    }
    case 'unary': {
      const v = evalNode(node.arg, scope);
      switch (node.op) {
        case '!':
          return !v;
        case '-':
          return -(v as number);
        case '+':
          return +(v as number);
        case 'typeof':
          return typeof v;
      }
      throw new Error(`Unknown unary op ${node.op}`);
    }
    case 'logical': {
      const l = evalNode(node.left, scope);
      if (node.op === '&&') return l ? evalNode(node.right, scope) : l;
      if (node.op === '??') return l === null || l === undefined ? evalNode(node.right, scope) : l;
      return l ? l : evalNode(node.right, scope);
    }
    case 'binary': {
      const l = evalNode(node.left, scope) as never;
      const r = evalNode(node.right, scope) as never;
      switch (node.op) {
        case '+':
          // JS `+`: numeric add or string concat depending on operands. `l`/`r`
          // are `never`-typed (evaluated dynamically), so this compiles cleanly.
          return (l as string) + (r as string);
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '%':
          return l % r;
        case '<':
          return l < r;
        case '>':
          return l > r;
        case '<=':
          return l <= r;
        case '>=':
          return l >= r;
        case '==':
          return l == r;
        case '!=':
          return l != r;
        case '===':
          return l === r;
        case '!==':
          return l !== r;
      }
      throw new Error(`Unknown binary op ${node.op}`);
    }
    case 'ternary':
      return evalNode(node.test, scope) ? evalNode(node.cons, scope) : evalNode(node.alt, scope);
  }
}

/**
 * opencli pipe filters: `expr | filter1(arg) | filter2`. Faithful port of
 * applyFilter() from opencli/src/pipeline/template.ts. Used by adapters like
 * `${{ args.limit | json }}`, `${{ args.query | urlencode }}`,
 * `${{ args.type | default('mentions') }}`, `${{ item.tags | join(', ') }}`.
 */
function applyFilter(filterExpr: string, value: unknown): unknown {
  const match = filterExpr.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return value;
  const name = match[1];
  const rawArgs = match[2];
  const filterArg = rawArgs?.replace(/^['"]|['"]$/g, '') ?? '';
  switch (name) {
    case 'default': {
      if (value === null || value === undefined || value === '') {
        const intVal = parseInt(filterArg, 10);
        if (!Number.isNaN(intVal) && String(intVal) === filterArg.trim()) return intVal;
        return filterArg;
      }
      return value;
    }
    case 'join':
      return Array.isArray(value) ? value.join(filterArg || ', ') : value;
    case 'upper':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lower':
      return typeof value === 'string' ? value.toLowerCase() : value;
    case 'trim':
      return typeof value === 'string' ? value.trim() : value;
    case 'truncate': {
      const n = parseInt(filterArg, 10) || 50;
      return typeof value === 'string' && value.length > n ? `${value.slice(0, n)}...` : value;
    }
    case 'replace': {
      if (typeof value !== 'string') return value;
      const parts = rawArgs?.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) ?? [];
      return parts.length >= 2 ? value.replaceAll(parts[0], parts[1]) : value;
    }
    case 'keys':
      return value && typeof value === 'object' ? Object.keys(value) : value;
    case 'length':
      return Array.isArray(value) || typeof value === 'string' ? value.length : value;
    case 'first':
      return Array.isArray(value) ? value[0] : value;
    case 'last':
      return Array.isArray(value) ? value[value.length - 1] : value;
    case 'json':
      return JSON.stringify(value ?? null);
    case 'urlencode':
      return typeof value === 'string' ? encodeURIComponent(value) : value;
    case 'urldecode':
      return typeof value === 'string' ? decodeURIComponent(value) : value;
    default:
      return value;
  }
}

/** Evaluate one JS expression (already unwrapped from `${{ }}`), then apply any
 * trailing `| filter` pipes. Splits on single `|` (not `||`). */
function evalExpression(code: string, scope: Scope): unknown {
  try {
    const segments = code.split(/(?<!\|)\|(?!\|)/).map((s) => s.trim());
    let result = evalNode(parseExpr(segments[0]), scope);
    for (let i = 1; i < segments.length; i++) result = applyFilter(segments[i], result);
    return result;
  } catch (err) {
    throw new Error(
      `Expression evaluation failed: ${code}\n${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/* ───────────────────────────── types ──────────────────────────────────── */

export type Expr = string;

export interface PipelineContext {
  row?: unknown;
  index?: number;
  args: Record<string, unknown>;
  vars: Record<string, unknown>;
  rows?: unknown[];
  count?: number;
  /** The most recent single (object) fetch result — opencli's `root`/`data`,
   * used by a few adapters to reference the whole payload while mapping rows. */
  root?: unknown;
  data?: unknown;
}

export interface FetchStepDef {
  url: Expr;
  method?: string;
  headers?: Record<string, Expr>;
  body?: Expr | Record<string, unknown>;
  as?: string;
  jsonPath?: string;
  asRows?: boolean;
}
export interface FetchStep {
  fetch: FetchStepDef;
}
export interface MapStep {
  // Object form is a field projection; an optional `select` key picks the array
  // to iterate from the last fetch payload (root). String form maps each row
  // through one expression.
  map: ({ select?: string } & Record<string, Expr>) | Expr;
}
export interface FilterStep {
  filter: Expr;
}
export interface LimitStep {
  limit: Expr | number;
}
export interface SortStep {
  sort: { by: Expr; order?: 'asc' | 'desc' };
}
export interface TransformStep {
  transform: { op: string; field?: string };
}
export interface PaginateStep {
  paginate: { fetch: FetchStepDef; maxPages?: number; until?: Expr; merge?: 'append' | 'replace' };
}

export type PipelineStep =
  | FetchStep
  | MapStep
  | FilterStep
  | LimitStep
  | SortStep
  | TransformStep
  | PaginateStep;
export type Pipeline = PipelineStep[];

export interface PipelineResult {
  rows: Record<string, unknown>[];
  vars: Record<string, unknown>;
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface ExecutorOptions {
  fetchImpl?: FetchImpl;
  debug?: boolean;
  /** Max concurrent requests for per-row fetch. Default 6. */
  concurrency?: number;
}

const MAX_PIPELINE_ROWS = 10000;

/**
 * `${{ }}` interpolation — single full match returns the raw typed value;
 * mixed text interpolates to a string; no `${{ }}` returns the literal.
 */
export function evaluateExpr(expr: string, context: PipelineContext): unknown {
  if (typeof expr !== 'string') return expr;
  const scope: Scope = {
    row: context.row,
    index: context.index,
    args: context.args ?? {},
    vars: context.vars ?? {},
    rows: context.rows,
    count: context.count,
    root: context.root,
    data: context.data,
  };
  const fullMatch = expr.match(/^\$\{\{([\s\S]+?)\}\}$/);
  if (fullMatch) return evalExpression(fullMatch[1].trim(), scope);
  if (expr.includes('${{')) {
    return expr.replace(/\$\{\{([\s\S]+?)\}\}/g, (_, code) => {
      const val = evalExpression(String(code).trim(), scope);
      return val == null ? '' : String(val);
    });
  }
  return expr;
}

/** Predicate eval for filter: accepts a `${{ }}`-wrapped OR bare expression
 * (the corpus has both: `${{ item.title }}` and `item.title && !item.dead`). */
function evaluatePredicate(expr: string, context: PipelineContext): boolean {
  const scope: Scope = {
    row: context.row,
    index: context.index,
    args: context.args ?? {},
    vars: context.vars ?? {},
    rows: context.rows,
    count: context.count,
    root: context.root,
    data: context.data,
  };
  const full = expr.match(/^\$\{\{([\s\S]+?)\}\}$/);
  const code = full ? full[1].trim() : expr.trim();
  return Boolean(evalExpression(code, scope));
}

/* ─────────────────────────── executor ─────────────────────────────────── */

function resolveJsonPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function asRow(v: unknown): Record<string, unknown> {
  return (typeof v === 'object' && v !== null ? v : { value: v }) as Record<string, unknown>;
}

/** Does a fetch step reference the current row (→ run per-row)? */
function fetchReferencesRow(f: FetchStepDef): boolean {
  const probe = (s: unknown): boolean => typeof s === 'string' && /\b(item|row|index)\b/.test(s);
  if (probe(f.url)) return true;
  if (f.headers && Object.values(f.headers).some(probe)) return true;
  if (probe(f.body)) return true;
  return false;
}

async function doFetch(
  f: FetchStepDef,
  ctx: PipelineContext,
  fetchImpl: FetchImpl,
  debug?: boolean,
): Promise<unknown> {
  const url = String(evaluateExpr(f.url, ctx));
  const method = f.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (f.headers) {
    for (const [k, v] of Object.entries(f.headers)) headers[k] = String(evaluateExpr(v, ctx));
  }
  let body: string | undefined;
  if (f.body !== undefined) {
    const evaluated = typeof f.body === 'string' ? evaluateExpr(f.body, ctx) : f.body;
    body = typeof evaluated === 'string' ? evaluated : JSON.stringify(evaluated);
  }
  if (debug) console.log(`[pipeline] fetch ${method} ${url}`);
  const res = await fetchImpl(url, { method, headers, body });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return f.jsonPath ? resolveJsonPath(data, f.jsonPath) : data;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

async function executeFetch(
  step: FetchStep,
  rows: unknown[],
  ctx: PipelineContext,
  options: ExecutorOptions,
): Promise<unknown[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchImpl);
  if (!fetchImpl) throw new Error('No fetch implementation available');
  const f = step.fetch;

  // PER-ROW: a fetch that references item/row/index, with rows to iterate,
  // runs once per row and replaces each row with its (jsonPath-resolved)
  // result. This is the list→detail pattern (e.g. fetch item/${{item.id}}).
  if (rows.length > 0 && fetchReferencesRow(f)) {
    const conc = options.concurrency ?? 6;
    const fetched = await mapConcurrent(rows, conc, (row, index) =>
      doFetch(f, { ...ctx, row, index }, fetchImpl, options.debug),
    );
    return fetched;
  }

  // SINGLE: run once. Array result becomes the rows (primitives kept raw).
  const data = await doFetch(f, ctx, fetchImpl, options.debug);
  // Expose the raw payload as root/data so adapters can reference the whole
  // object while mapping (opencli's `root`/`data`).
  ctx.root = data;
  ctx.data = data;
  if (f.as) ctx.vars[f.as] = data;
  if (f.asRows || Array.isArray(data)) {
    return Array.isArray(data) ? data : [];
  }
  if (!f.as) ctx.vars['_last'] = data;
  return rows;
}

function executeMap(step: MapStep, rows: unknown[], ctx: PipelineContext): unknown[] {
  const mapDef = step.map;
  if (typeof mapDef === 'string') {
    return rows.map((row, index) => evaluateExpr(mapDef, { ...ctx, row, index }));
  }

  // Inline `select` (opencli stepMap semantics): pick the source array from the
  // last fetch payload (root) by dotted path, overriding the current rows. The
  // `root` available to field expressions stays the WHOLE payload (so binance's
  // `root.asks[index]` works while iterating `root.bids`). If the selected
  // source is an object with a `.data` array, iterate that; a non-array source
  // is wrapped to a single row.
  const { select, ...fields } = mapDef as { select?: string } & Record<string, string>;
  let source: unknown[];
  if (typeof select === 'string') {
    const picked = resolveJsonPath(ctx.root, select);
    if (Array.isArray(picked)) source = picked;
    else if (picked && typeof picked === 'object' && Array.isArray((picked as { data?: unknown }).data)) {
      source = (picked as { data: unknown[] }).data;
    } else if (picked == null) source = [];
    else source = [picked];
  } else {
    source = rows;
  }

  return source.map((row, index) => {
    const rowCtx = { ...ctx, row, index };
    const out: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(fields)) out[key] = evaluateExpr(expr, rowCtx);
    return out;
  });
}

function executeFilter(step: FilterStep, rows: unknown[], ctx: PipelineContext): unknown[] {
  return rows.filter((row, index) => evaluatePredicate(step.filter, { ...ctx, row, index }));
}

function executeLimit(step: LimitStep, rows: unknown[], ctx: PipelineContext): unknown[] {
  const n = Number(evaluateExpr(String(step.limit), ctx));
  return Number.isFinite(n) ? rows.slice(0, n) : rows;
}

function executeSort(step: SortStep, rows: unknown[], ctx: PipelineContext): unknown[] {
  const { by, order = 'asc' } = step.sort;
  return [...rows].sort((a, b) => {
    const av = evaluateExpr(by, { ...ctx, row: a }) as number | string;
    const bv = evaluateExpr(by, { ...ctx, row: b }) as number | string;
    if (av < bv) return order === 'asc' ? -1 : 1;
    if (av > bv) return order === 'asc' ? 1 : -1;
    return 0;
  });
}

function executeTransform(step: TransformStep, rows: unknown[]): unknown[] {
  const { op, field } = step.transform;
  switch (op) {
    case 'flatten':
      return rows.flatMap((r) => {
        const v = field ? (r as Record<string, unknown>)[field] : r;
        return Array.isArray(v) ? v : [v];
      });
    case 'unique': {
      const seen = new Set<string>();
      return rows.filter((r) => {
        const key = field ? JSON.stringify((r as Record<string, unknown>)[field]) : JSON.stringify(r);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    case 'reverse':
      return [...rows].reverse();
    case 'compact':
      return rows.filter((r) => r != null);
    default:
      throw new Error(`Unknown transform op: ${op}`);
  }
}

async function executePaginate(
  step: PaginateStep,
  rows: unknown[],
  ctx: PipelineContext,
  options: ExecutorOptions,
): Promise<unknown[]> {
  const { fetch: fetchDef, maxPages = 10, until, merge = 'append' } = step.paginate;
  let allRows: unknown[] = merge === 'append' ? [...rows] : [];
  let page = 0;
  while (page < maxPages) {
    ctx.vars['page'] = page;
    const pageRows = await executeFetch({ fetch: fetchDef }, rows, ctx, options);
    allRows = merge === 'append' ? allRows.concat(pageRows) : pageRows;
    if (until && evaluateExpr(until, { ...ctx, rows: allRows, count: allRows.length })) break;
    if (pageRows.length === 0) break;
    page++;
  }
  return allRows;
}

async function executeStep(
  step: PipelineStep,
  rows: unknown[],
  ctx: PipelineContext,
  options: ExecutorOptions,
): Promise<unknown[]> {
  if ('fetch' in step) return executeFetch(step, rows, ctx, options);
  if ('map' in step) return executeMap(step, rows, ctx);
  if ('filter' in step) return executeFilter(step, rows, ctx);
  if ('limit' in step) return executeLimit(step, rows, ctx);
  if ('sort' in step) return executeSort(step, rows, ctx);
  if ('transform' in step) return executeTransform(step, rows);
  if ('paginate' in step) return executePaginate(step, rows, ctx, options);
  throw new Error(`Unknown pipeline step: ${JSON.stringify(step)}`);
}

export async function executePipeline(
  pipeline: Pipeline,
  initialContext: Partial<PipelineContext>,
  options: ExecutorOptions = {},
): Promise<PipelineResult> {
  const ctx: PipelineContext = {
    args: initialContext.args ?? {},
    vars: initialContext.vars ?? {},
    rows: initialContext.rows ?? [],
  };
  let rows: unknown[] = ctx.rows ?? [];
  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i];
    if (options.debug) {
      console.log(`[pipeline] step ${i + 1}/${pipeline.length}: ${Object.keys(step)[0]} (${rows.length} rows)`);
    }
    rows = await executeStep(step, rows, ctx, options);
    if (rows.length > MAX_PIPELINE_ROWS) {
      throw new Error(`Pipeline exceeded ${MAX_PIPELINE_ROWS} rows (runaway?)`);
    }
    ctx.rows = rows;
    ctx.count = rows.length;
  }
  // Normalize to objects for table/JSON output (primitives → {value: x}).
  return { rows: rows.map(asRow), vars: ctx.vars };
}

export async function runPipeline(
  pipeline: Pipeline,
  context: Partial<PipelineContext> = {},
  options: ExecutorOptions = {},
): Promise<PipelineResult> {
  return executePipeline(pipeline, context, options);
}

export function validatePipeline(pipeline: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(pipeline)) return ['Pipeline must be an array of steps'];
  const known = ['fetch', 'map', 'filter', 'limit', 'sort', 'paginate', 'transform'];
  pipeline.forEach((step, i) => {
    if (typeof step !== 'object' || step === null) {
      errors.push(`Step ${i} must be an object`);
      return;
    }
    const keys = Object.keys(step);
    if (keys.length === 0) errors.push(`Step ${i} has no operation`);
    else if (!known.includes(keys[0])) errors.push(`Step ${i} has unknown operation: ${keys[0]}`);
  });
  return errors;
}

export function createFetchImpl(fn: FetchImpl): FetchImpl {
  return fn;
}

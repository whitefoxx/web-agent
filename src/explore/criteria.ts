/**
 * Quantitative success criteria from a verify result (browseract-comparison ⑨).
 *
 * The verify oracle already eyeballs row count + per-column non-empty rate to
 * emit "0 rows" / "column empty" warnings, then throws those signals away. This
 * turns the SAME signals into a positive, reusable BAR — `rows>=N`, per-column
 * non-empty rate — that (a) gives the agent an honest quantitative wrap-up
 * instead of "passed", and (b) is the seed for replay self-check / E1 health
 * checks. Pure; unit-tested. See docs/browseract-comparison.md §2 ⑨.
 */

export interface ResultCriteria {
  /** Row count of the verify result. */
  rows: number;
  /** Per declared column: fraction (0..1) of sampled rows where it's non-empty. */
  columns: Array<{ name: string; nonEmptyRate: number }>;
  /** Columns empty in EVERY sampled row (the ones the oracle warns about). */
  emptyColumns: string[];
}

const isRow = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

const isEmpty = (v: unknown): boolean =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** Compute quantitative criteria from a verify result + the adapter's declared
 * columns. Returns null when the result isn't an array (not a list adapter).
 * Samples the first `sampleN` object rows for the non-empty rates. */
export function computeResultCriteria(
  result: unknown,
  columns: string[],
  sampleN = 20,
): ResultCriteria | null {
  if (!Array.isArray(result)) return null;
  const sample = result.slice(0, sampleN).filter(isRow);
  const cols = columns.map((name) => {
    if (!sample.length) return { name, nonEmptyRate: 0 };
    const nonEmpty = sample.filter((row) => !isEmpty(row[name])).length;
    return { name, nonEmptyRate: Math.round((nonEmpty / sample.length) * 100) / 100 };
  });
  return {
    rows: result.length,
    columns: cols,
    emptyColumns: cols.filter((c) => c.nonEmptyRate === 0).map((c) => c.name),
  };
}

/** One-line, quantitative-only criteria string for the agent + adapter notes.
 * "Descriptive" wording is deliberately avoided (⑨: quantitative only). */
export function formatCriteria(c: ResultCriteria): string {
  const parts = [`≥${c.rows} rows`];
  const full = c.columns.filter((x) => x.nonEmptyRate === 1).map((x) => x.name);
  const partial = c.columns
    .filter((x) => x.nonEmptyRate > 0 && x.nonEmptyRate < 1)
    .map((x) => `${x.name}(${Math.round(x.nonEmptyRate * 100)}%)`);
  if (full.length) parts.push(`columns ${full.join('/')} 100% non-empty`);
  if (partial.length) parts.push(`partially non-empty ${partial.join('/')}`);
  return parts.join('; ');
}

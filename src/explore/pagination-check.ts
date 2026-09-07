/**
 * Runtime pagination oracle (browseract-comparison ⑦). A common synthesis miss
 * is a `page`/`offset` arg that isn't actually wired into the request — so every
 * "page" returns page 1. After a list adapter verifies, we run it once more for
 * page 2 and check the rows really CHANGED. These pure helpers decide whether/how
 * to probe page 2; the double-run + comparison lives in verifyExploreAdapter.
 */

export interface PageArg {
  name: string;
  kind: 'page' | 'offset';
}

/** Detect a pagination arg from an adapter's declared args. Page-type
 * (page / p / pageNo / pageIndex) or offset-type (offset / start / skip). Cursor
 * args are opaque (can't synthesize the next value) → skipped. Pure. */
export function pickPaginationArg(args: Array<{ name?: string }> | undefined): PageArg | null {
  for (const a of args ?? []) {
    const n = (a.name ?? '').trim();
    if (!n) continue;
    const low = n.toLowerCase();
    if (low === 'page' || /^p(age)?(no|num|index|_?no)?$/.test(low))
      return { name: n, kind: 'page' };
    if (low === 'offset' || low === 'start' || low === 'skip') return { name: n, kind: 'offset' };
  }
  return null;
}

/** The value to request "the next page" with. page-type → +1 (default 1→2);
 * offset-type → advance by the page size (rows page 1 returned, min 1). Pure. */
export function nextPageValue(
  arg: PageArg,
  testArgs: Record<string, unknown>,
  page1Rows: number,
): number {
  const cur = Number(testArgs[arg.name]);
  if (arg.kind === 'page') return (Number.isFinite(cur) ? cur : 1) + 1;
  return (Number.isFinite(cur) ? cur : 0) + Math.max(1, page1Rows);
}

/** Fraction of page-2's row signatures that also appear on page 1 (0..1). A high
 * value means pagination didn't take effect (page 2 ≈ page 1). Pure. */
export function duplicateFraction(page1Sigs: string[], page2Sigs: string[]): number {
  const set = new Set(page1Sigs.filter(Boolean));
  const p2 = page2Sigs.filter(Boolean);
  if (!p2.length) return 0;
  const dup = p2.filter((s) => set.has(s)).length;
  return dup / p2.length;
}

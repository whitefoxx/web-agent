/**
 * computeResultCriteria / formatCriteria — quantitative success criteria from a
 * verify result (browseract-comparison ⑨). Pure, node. Reuses the same signals
 * the oracle eyeballs (rows + per-column non-empty rate) as a positive bar.
 */

import { describe, it, expect } from 'vitest';
import { computeResultCriteria, formatCriteria } from '../src/explore/criteria';

describe('computeResultCriteria', () => {
  it('non-array result → null (not a list adapter)', () => {
    expect(computeResultCriteria({ a: 1 }, ['a'])).toBeNull();
    expect(computeResultCriteria('x', [])).toBeNull();
    expect(computeResultCriteria(null, ['a'])).toBeNull();
  });

  it('rows + per-column non-empty rate', () => {
    const rows = [
      { title: 'a', url: 'u1' },
      { title: 'b', url: '' },
      { title: 'c', url: 'u3' },
    ];
    const c = computeResultCriteria(rows, ['title', 'url'])!;
    expect(c.rows).toBe(3);
    expect(c.columns.find((x) => x.name === 'title')!.nonEmptyRate).toBe(1);
    expect(c.columns.find((x) => x.name === 'url')!.nonEmptyRate).toBeCloseTo(0.67, 2);
    expect(c.emptyColumns).toEqual([]);
  });

  it('a column empty in every row → emptyColumns', () => {
    const rows = [
      { title: 'a', extra: '' },
      { title: 'b', extra: null },
    ];
    const c = computeResultCriteria(rows, ['title', 'extra'])!;
    expect(c.emptyColumns).toEqual(['extra']);
  });

  it('treats null / "" / [] as empty, but 0 as a real value', () => {
    const c = computeResultCriteria([{ a: [], b: 0 }], ['a', 'b'])!;
    expect(c.columns.find((x) => x.name === 'a')!.nonEmptyRate).toBe(0);
    expect(c.columns.find((x) => x.name === 'b')!.nonEmptyRate).toBe(1);
  });

  it('empty array → 0 rows, all columns rate 0', () => {
    const c = computeResultCriteria([], ['a'])!;
    expect(c.rows).toBe(0);
    expect(c.columns[0].nonEmptyRate).toBe(0);
  });
});

describe('formatCriteria', () => {
  it('quantitative one-liner: rows + 100% cols + partial %', () => {
    const s = formatCriteria({
      rows: 17,
      columns: [
        { name: 'title', nonEmptyRate: 1 },
        { name: 'url', nonEmptyRate: 1 },
        { name: 'author', nonEmptyRate: 0.5 },
      ],
      emptyColumns: [],
    });
    expect(s).toMatch(/≥17 rows/);
    expect(s).toMatch(/title\/url 100% non-empty/);
    expect(s).toMatch(/author\(50%\)/);
  });

  it('no full columns → just the row count', () => {
    const s = formatCriteria({
      rows: 3,
      columns: [{ name: 'x', nonEmptyRate: 0 }],
      emptyColumns: ['x'],
    });
    expect(s).toMatch(/≥3 rows/);
    expect(s).not.toMatch(/100% non-empty/);
  });
});

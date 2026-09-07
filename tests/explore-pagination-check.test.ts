/**
 * Pagination oracle helpers (⑦): detect a page/offset arg, compute the "next
 * page" value, and score page-2/page-1 duplication. The runtime double-run lives
 * in verifyExploreAdapter; these decide/score it. Pure; node.
 */

import { describe, it, expect } from 'vitest';
import {
  pickPaginationArg,
  nextPageValue,
  duplicateFraction,
} from '../src/explore/pagination-check';

describe('pickPaginationArg (⑦)', () => {
  it('detects page-type args', () => {
    expect(pickPaginationArg([{ name: 'page' }])).toEqual({ name: 'page', kind: 'page' });
    expect(pickPaginationArg([{ name: 'p' }])).toEqual({ name: 'p', kind: 'page' });
    expect(pickPaginationArg([{ name: 'pageNo' }])?.kind).toBe('page');
  });
  it('detects offset-type args', () => {
    expect(pickPaginationArg([{ name: 'offset' }])).toEqual({ name: 'offset', kind: 'offset' });
    expect(pickPaginationArg([{ name: 'start' }])?.kind).toBe('offset');
  });
  it('ignores cursor / non-pagination args', () => {
    expect(pickPaginationArg([{ name: 'cursor' }, { name: 'limit' }, { name: 'q' }])).toBeNull();
    expect(pickPaginationArg([])).toBeNull();
    expect(pickPaginationArg(undefined)).toBeNull();
  });
});

describe('nextPageValue', () => {
  it('page: current + 1 (default 1 → 2)', () => {
    expect(nextPageValue({ name: 'page', kind: 'page' }, {}, 20)).toBe(2);
    expect(nextPageValue({ name: 'page', kind: 'page' }, { page: 3 }, 20)).toBe(4);
  });
  it('offset: advance by the page size', () => {
    expect(nextPageValue({ name: 'offset', kind: 'offset' }, {}, 25)).toBe(25);
    expect(nextPageValue({ name: 'offset', kind: 'offset' }, { offset: 50 }, 25)).toBe(75);
  });
});

describe('duplicateFraction', () => {
  it('page 2 == page 1 → 1 (pagination broken)', () => {
    expect(duplicateFraction(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });
  it('fully fresh page 2 → 0', () => {
    expect(duplicateFraction(['a', 'b'], ['x', 'y'])).toBe(0);
  });
  it('partial overlap', () => {
    expect(duplicateFraction(['a', 'b', 'c', 'd'], ['c', 'd', 'e', 'f'])).toBe(0.5);
  });
  it('empty page 2 → 0', () => {
    expect(duplicateFraction(['a'], [])).toBe(0);
  });
});

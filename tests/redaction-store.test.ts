import { describe, it, expect } from 'vitest';
import {
  compilePattern,
  applyRedactPatterns,
  isValidRegex,
  type RedactPattern,
} from '../src/config/redaction-store';

const mk = (o: Partial<RedactPattern>): RedactPattern => ({
  id: o.id ?? 'x',
  pattern: o.pattern ?? '',
  flags: o.flags ?? 'gi',
  label: o.label ?? 'redacted',
  enabled: o.enabled ?? true,
});

describe('compilePattern', () => {
  it('compiles a valid source and forces the global flag', () => {
    const re = compilePattern(mk({ pattern: 'a', flags: 'i' }));
    expect(re).not.toBeNull();
    expect(re!.global).toBe(true);
    expect(re!.ignoreCase).toBe(true);
  });
  it('returns null for an invalid regex (never throws)', () => {
    expect(compilePattern(mk({ pattern: '(' }))).toBeNull();
    expect(compilePattern(mk({ pattern: '' }))).toBeNull();
  });
});

describe('isValidRegex', () => {
  it('validates without throwing', () => {
    expect(isValidRegex('[\\w]+@[\\w.]+', 'gi')).toBe(true);
    expect(isValidRegex('(', '')).toBe(false);
  });
});

describe('applyRedactPatterns', () => {
  const email = mk({ id: 'e', pattern: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', label: 'email' });

  it('replaces all matches deep, with «label»', () => {
    const out = applyRedactPatterns(
      { msg: 'ping a@b.com and c@d.org', list: [{ to: 'x@y.io' }, 'no-match'] },
      [email],
    );
    expect(out).toEqual({
      msg: 'ping «email» and «email»',
      list: [{ to: '«email»' }, 'no-match'],
    });
  });

  it('applies multiple patterns; skips disabled and invalid ones', () => {
    const phone = mk({ id: 'p', pattern: '\\d{3}-\\d{4}', label: 'phone' });
    const disabled = mk({ id: 'd', pattern: 'secret', label: 'X', enabled: false });
    const bad = mk({ id: 'b', pattern: '(', label: 'BAD' });
    expect(applyRedactPatterns('call 555-1234, secret kept', [phone, disabled, bad])).toBe(
      'call «phone», secret kept',
    );
  });

  it('returns the input unchanged when there are no usable patterns', () => {
    const v = { a: 'untouched', n: 1 };
    expect(applyRedactPatterns(v, [])).toEqual(v);
    expect(applyRedactPatterns(v, [mk({ pattern: '(', label: 'bad' })])).toEqual(v);
  });
});

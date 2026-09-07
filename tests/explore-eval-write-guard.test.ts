/**
 * detectWriteIntent — high-precision static scan for an obvious network write in
 * an eval_js snippet (F-29). Must flag the concrete write shapes (POST/PUT/…
 * options, XHR open, form submit, beacon) but NOT nag read-only exploration that
 * merely mentions "POST" as data. Pure, node.
 */

import { describe, it, expect } from 'vitest';
import { detectWriteIntent } from '../src/tools/explore/eval-js';

describe('detectWriteIntent — flags obvious writes', () => {
  it('fetch with method:POST/PUT/DELETE/PATCH (any quote, spacing, case)', () => {
    expect(detectWriteIntent(`fetch('/star', { method: 'POST' })`)).toMatch(/POST/);
    expect(detectWriteIntent(`fetch(u, {method:"put"})`)).toBeTruthy();
    expect(detectWriteIntent('fetch(u, { method: `DELETE` })')).toBeTruthy();
    expect(detectWriteIntent(`fetch(u, {  method :  'patch' })`)).toBeTruthy();
  });

  it('XMLHttpRequest.open with a write verb', () => {
    expect(detectWriteIntent(`const x=new XMLHttpRequest(); x.open('POST', '/star')`)).toBeTruthy();
  });

  it('form submit / requestSubmit', () => {
    expect(detectWriteIntent(`document.querySelector('form.js-star').requestSubmit()`)).toMatch(
      /submit/i,
    );
    expect(detectWriteIntent(`form.submit()`)).toBeTruthy();
  });

  it('navigator.sendBeacon', () => {
    expect(detectWriteIntent(`navigator.sendBeacon('/log', data)`)).toBeTruthy();
  });

  it('the actual GitHub-star snippet from the F-29 trace', () => {
    const code = `
      const forms = Array.from(document.querySelectorAll('form'));
      const starForm = forms.find(f => f.action.includes('/star'));
      const token = starForm.querySelector('input[name=authenticity_token]').value;
      await fetch(starForm.action, { method: 'POST', body: new FormData(starForm), credentials: 'include' });
    `;
    expect(detectWriteIntent(code)).toBeTruthy();
  });
});

describe('detectWriteIntent — does NOT flag read-only exploration', () => {
  it('plain GET fetch / no options', () => {
    expect(detectWriteIntent(`fetch('/api/list').then(r => r.json())`)).toBeNull();
    expect(detectWriteIntent(`fetch(url, { credentials: 'include' })`)).toBeNull();
  });

  it('reading/printing a form method (the string "POST" as DATA, not an options key)', () => {
    expect(detectWriteIntent(`const m = form.method; return { method: m }`)).toBeNull();
    expect(
      detectWriteIntent(`return document.querySelector('form').getAttribute('method')`),
    ).toBeNull();
    // Inspecting the form action + method for synthesis — must stay allowed.
    expect(
      detectWriteIntent(
        `Array.from(document.querySelectorAll('form')).map(f => ({action: f.action, method: f.method}))`,
      ),
    ).toBeNull();
  });

  it('DOM extraction with querySelectorAll / map / textContent', () => {
    const code = `Array.from(document.querySelectorAll('article.Box-row')).map(a => ({
      name: a.querySelector('h2 a')?.textContent?.trim(),
    }))`;
    expect(detectWriteIntent(code)).toBeNull();
  });

  it('the word "post" inside unrelated identifiers/text', () => {
    expect(detectWriteIntent(`const posts = document.querySelectorAll('.post-item')`)).toBeNull();
    expect(detectWriteIntent(`return { postCount: items.length }`)).toBeNull();
  });
});

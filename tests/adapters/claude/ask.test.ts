/**
 * Port of opencli's clis/claude/ask.test.js.
 *
 * Opencli mocks `./utils.js` to swap the high-level helpers (ensureOnClaude,
 * ensureClaudeComposer, selectModel, setAdaptiveThinking, sendMessage,
 * sendWithFile, getBubbleCount, waitForResponse). The marketplace bundle inlines
 * all of those, so we instead drive their behavior through the lowest seam each
 * inlined helper actually crosses — `page.evaluate(<script>)`, routed by the
 * shared `makeFakeClaudePage` helper. The substantive opencli assertions (what
 * the command returns, which path it takes, which error it throws, and that the
 * prompt/baseline/timeout flow through correctly) are preserved; only the mock
 * mechanism changes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAdapter } from '@base/runtime/registry.js';
import { ArgumentError, EmptyResultError } from '@base/runtime/errors.js';
import { makeFakeClaudePage, type FakeClaudePage } from '../_helpers/claude-page.js';

import '../../../marketplace/claude/ask.js';

const command = findAdapter('claude', 'ask');

describe('claude ask basic flow', () => {
  let page: FakeClaudePage;

  beforeEach(() => {
    page = makeFakeClaudePage();
    // Fresh /new chat, logged in, composer present (opencli: ensureOnClaude→false,
    // ensureClaudeComposer→{isLoggedIn,hasComposer}, selectModel/think ok).
    page.setCurrentUrl('https://claude.ai/new');
    page.setAssistantResponse('hello there');
  });

  it('returns the assistant response on a fresh chat', async () => {
    const rows = await command!.func!(page, {
      prompt: 'hi',
      timeout: 120,
      new: false,
      model: 'sonnet',
      think: false,
    });

    expect(rows).toEqual([{ response: 'hello there' }]);
    // opencli: mockSendMessage called with (page, 'hi'). The inlined sendMessage
    // types the prompt via execCommand('insertText', <JSON.stringify(prompt)>);
    // assert the prompt 'hi' reached the composer and the send fired.
    const insertCalls = page.evalInsertText.mock.calls.map((c) => String(c[0]));
    expect(insertCalls.some((s) => s.includes('"hi"'))).toBe(true);
    expect(page.evalSend).toHaveBeenCalled();
    // opencli: waitForResponse(page, 0, 'hi', 120000) — baseline came from
    // getBubbleCount (0 here) before any send.
    expect(page.evalBubbleCount).toHaveBeenCalledTimes(1);
  });

  it('navigates to /new when --new is set', async () => {
    await command!.func!(page, {
      prompt: 'hi',
      timeout: 120,
      new: true,
      model: 'sonnet',
      think: false,
    });

    expect(page.goto).toHaveBeenCalledWith('https://claude.ai/new');
    // opencli: ensureOnClaude NOT called → the inlined adapter skips the
    // ensure-branch's navigated-link click ( a[href*="/chat/"] ).
    expect(page.evalNavLink).not.toHaveBeenCalled();
  });

  it('throws EmptyResultError when waitForResponse yields nothing', async () => {
    page.setAssistantResponse(null);

    await expect(
      command!.func!(page, {
        prompt: 'hi',
        timeout: 60,
        new: false,
        model: 'sonnet',
        think: false,
      }),
    ).rejects.toThrow(EmptyResultError);
  });

  it('throws CommandExecutionError when send fails', async () => {
    // opencli: mockSendMessage → { ok:false, reason:'composer not found' }.
    // The inlined sendMessage returns that exact reason when the composer-clear
    // step reports the box is missing.
    page.evalComposerClear.mockResolvedValue(false);

    await expect(
      command!.func!(page, {
        prompt: 'hi',
        timeout: 120,
        new: false,
        model: 'sonnet',
        think: false,
      }),
    ).rejects.toThrow(/composer not found/);
  });
});

describe('claude ask --model handling', () => {
  let page: FakeClaudePage;

  beforeEach(() => {
    page = makeFakeClaudePage();
    page.setAssistantResponse('reply');
  });

  it('rejects --model opus on free tier with usage-error guidance', async () => {
    page.setCurrentUrl('https://claude.ai/new');
    // opencli: mockSelectModel → { ok:false, upgrade:true }. The inlined
    // selectModel returns that from the menuitemradio pick step.
    page.evalSelectModelPick.mockResolvedValue({ ok: false, upgrade: true });

    await expect(
      command!.func!(page, {
        prompt: 'hi',
        timeout: 120,
        new: false,
        model: 'opus',
        think: false,
      }),
    ).rejects.toMatchObject(
      new ArgumentError(
        'opus model requires a paid Claude plan.',
        'Pick --model sonnet or --model haiku, or upgrade your account.',
      ),
    );
  });

  it('skips model selection inside an existing conversation', async () => {
    page.setCurrentUrl('https://claude.ai/chat/abc-123');

    const rows = await command!.func!(page, {
      prompt: 'continue',
      timeout: 120,
      new: false,
      model: 'sonnet',
      think: false,
    });

    expect(rows).toEqual([{ response: 'reply' }]);
    // opencli: mockSelectModel NOT called. The inlined selectModel's dropdown
    // open/pick scripts must never run inside a /chat/ conversation.
    expect(page.evalSelectModelOpen).not.toHaveBeenCalled();
    expect(page.evalSelectModelPick).not.toHaveBeenCalled();
  });

  it('fails fast when --model is explicit inside an existing conversation', async () => {
    page.setCurrentUrl('https://claude.ai/chat/abc-123');

    await expect(
      command!.func!(page, {
        prompt: 'continue',
        timeout: 120,
        new: false,
        model: 'opus',
        think: false,
        __opencliOptionSources: { model: 'cli' },
      }),
    ).rejects.toMatchObject(
      new ArgumentError(
        'Cannot switch to opus model inside an existing conversation.',
        'Re-run with --new to start a fresh chat before selecting a model.',
      ),
    );

    expect(page.evalSelectModelOpen).not.toHaveBeenCalled();
    expect(page.evalSelectModelPick).not.toHaveBeenCalled();
  });
});

describe('claude ask --think', () => {
  let page: FakeClaudePage;

  beforeEach(() => {
    page = makeFakeClaudePage();
    page.setCurrentUrl('https://claude.ai/new');
    page.setAssistantResponse('reply');
  });

  it('toggles Adaptive thinking when --think is set', async () => {
    page.evalThinkPick.mockResolvedValue({ ok: true, toggled: true });

    await command!.func!(page, {
      prompt: 'reason carefully',
      timeout: 120,
      new: false,
      model: 'sonnet',
      think: true,
    });

    // opencli: mockSetAdaptiveThinking called with (page, true). The inlined
    // setAdaptiveThinking opens the dropdown then toggles the 'Adaptive thinking'
    // menuitem — assert both seam scripts ran.
    expect(page.evalThinkOpen).toHaveBeenCalled();
    expect(page.evalThinkPick).toHaveBeenCalled();
  });

  it('throws when --think requested but toggle fails', async () => {
    page.evalThinkOpen.mockResolvedValue({ ok: false });

    await expect(
      command!.func!(page, {
        prompt: 'reason carefully',
        timeout: 120,
        new: false,
        model: 'sonnet',
        think: true,
      }),
    ).rejects.toThrow(/Adaptive thinking/);
  });

  it('does not throw when --think is false and toggle returns ok=false', async () => {
    page.evalThinkOpen.mockResolvedValue({ ok: false });

    await expect(
      command!.func!(page, {
        prompt: 'hi',
        timeout: 120,
        new: false,
        model: 'sonnet',
        think: false,
      }),
    ).resolves.toEqual([{ response: 'reply' }]);
  });

  it('fails fast when prompt validation rejects an empty prompt', async () => {
    await expect(
      command!.func!(page, {
        prompt: '',
        timeout: 120,
        new: false,
        model: 'sonnet',
        think: false,
      }),
    ).rejects.toThrow(ArgumentError);
  });

  it('fails fast when timeout validation rejects a non-positive value', async () => {
    await expect(
      command!.func!(page, {
        prompt: 'hi',
        timeout: 0,
        new: false,
        model: 'sonnet',
        think: false,
      }),
    ).rejects.toThrow(ArgumentError);
  });
});

describe('claude ask --file', () => {
  let page: FakeClaudePage;
  // The bundled sendWithFile is INLINED and reads the file off disk
  // (fs.existsSync / statSync / readFileSync) before touching the page —
  // opencli's module-level mock skipped fs entirely. So we back the --file flow
  // with a real (tiny) temp file; the path is what flows into setFileInput.
  let filePath: string;

  beforeAll(() => {
    filePath = join(tmpdir(), `claude-ask-cat-${process.pid}.png`);
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  afterAll(() => {
    rmSync(filePath, { force: true });
  });

  beforeEach(() => {
    page = makeFakeClaudePage();
    page.setCurrentUrl('https://claude.ai/new');
    // opencli: getBubbleCount → 3 baseline, waitForResponse → 'the image shows a cat'.
    page.evalBubbleCount.mockResolvedValue(3);
    page.setAssistantResponse('the image shows a cat');
  });

  it('routes through sendWithFile and captures baseline before sending', async () => {
    const rows = await command!.func!(page, {
      prompt: 'describe this',
      timeout: 120,
      new: false,
      model: 'sonnet',
      think: false,
      file: filePath,
    });

    expect(rows).toEqual([{ response: 'the image shows a cat' }]);
    // opencli: getBubbleCount called once (baseline captured before send).
    expect(page.evalBubbleCount).toHaveBeenCalledTimes(1);
    // opencli: sendWithFile(page, file, 'describe this'). The inlined
    // sendWithFile sets the file input then uploads — assert the resolved file
    // path was handed to the input setter and the prompt 'describe this' typed.
    expect(page.setFileInput).toHaveBeenCalled();
    const setFilePaths = page.setFileInput.mock.calls[0]?.[0] as string[];
    expect(setFilePaths.some((p) => p.endsWith('.png'))).toBe(true);
    const insertCalls = page.evalInsertText.mock.calls.map((c) => String(c[0]));
    expect(insertCalls.some((s) => s.includes('describe this'))).toBe(true);
  });

  it('surfaces file upload failure as CommandExecutionError', async () => {
    // opencli: mockSendWithFile → { ok:false, reason:'file preview did not appear' }.
    // The inlined sendWithFile returns that exact reason when waitForFilePreview
    // never sees the thumbnail.
    page.evalFilePreview.mockResolvedValue(false);

    await expect(
      command!.func!(page, {
        prompt: 'describe this',
        timeout: 120,
        new: false,
        model: 'sonnet',
        think: false,
        file: filePath,
      }),
    ).rejects.toThrow(/file preview did not appear/);
  });

  it('absorbs "Promise was collected" SPA navigation error after send', async () => {
    // opencli: mockSendWithFile.mockRejectedValue(new Error('Promise was collected')).
    // The inlined sendWithFile rejects when the file-input setter throws; the func
    // swallows 'Promise was collected' and proceeds to waitForResponse.
    page.setFileInput.mockRejectedValue(new Error('Promise was collected'));

    const rows = await command!.func!(page, {
      prompt: 'describe this',
      timeout: 120,
      new: false,
      model: 'sonnet',
      think: false,
      file: filePath,
    });

    expect(rows).toEqual([{ response: 'the image shows a cat' }]);
  });
});

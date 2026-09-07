/**
 * specialist — vision describe + image generation sub-calls. fetchImpl injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  visionDescribe,
  generateImage,
  dashscopeImageEndpoint,
  imageUrlForProvider,
  providerAcceptsHttpImageUrl,
} from '../src/agent/specialist';
import type { LlmProfile } from '../src/config/llm-config';

const VIS: LlmProfile = {
  id: 'v',
  label: 'vis',
  provider: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: 'sk-v',
  model: 'glm-4.6v',
};
const IMG: LlmProfile = { ...VIS, id: 'i', model: 'cogview-4' };

function okResp(json: unknown): Response {
  const body = JSON.stringify(json);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response;
}

/** ≥12 bytes so magic sniffing works (JPEG: FF D8 FF …). */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const JPEG_B64 = btoa(String.fromCharCode(...JPEG_BYTES));

function imgResp(bytes: Uint8Array, contentType = 'image/jpeg'): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

/** POST-only data URL, so image prep is local and fetchImpl sees just the API. */
const DATA_IMG = 'data:image/png;base64,AAAA';

describe('visionDescribe', () => {
  it('inlines an http image before POSTing; GLM gets the RAW base64 payload (§10.24 补 — bigmodel 官方示例无 data: 前缀)', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://h/a.jpg'
        ? imgResp(JPEG_BYTES)
        : okResp({ choices: [{ message: { content: '图里是一只猫' } }] }),
    );
    const out = await visionDescribe(VIS, ['https://h/a.jpg'], '这是什么', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('图里是一只猫');
    // First call fetches the image bytes (no Referer), second is the API POST.
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('https://h/a.jpg');
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('glm-4.6v');
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: JPEG_B64 } }, // raw, no data: prefix
    ]);
  });

  it('non-GLM providers (Aliyun/OpenAI-compatible) get the FULL data URL', async () => {
    const QWEN = {
      ...VIS,
      provider: 'custom',
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus',
    } as typeof VIS;
    const fetchImpl = vi.fn(async (url: string) =>
      url === 'https://h/a.jpg'
        ? imgResp(JPEG_BYTES)
        : okResp({ choices: [{ message: { content: 'ok' } }] }),
    );
    await visionDescribe(QWEN, ['https://h/a.jpg'], 'x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.messages[0].content[1].image_url.url).toBe(`data:image/jpeg;base64,${JPEG_B64}`);
  });

  it('throws a clear next-step error when EVERY image is unfetchable (no API call made)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, statusText: 'F', text: async () => '' }) as unknown as Response);
    await expect(
      visionDescribe(VIS, ['https://h/blocked.jpg'], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/None of the images could be read/);
    // Only the image fetch happened — never the chat/completions POST.
    expect(fetchImpl.mock.calls.every(([u]) => u === 'https://h/blocked.jpg')).toBe(true);
  });

  it('drops unfetchable images but keeps going, noting the drop in the answer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://h/ok.jpg') return imgResp(JPEG_BYTES);
      if (url === 'https://h/dead.jpg') {
        return { ok: false, status: 403, statusText: 'F', text: async () => '' } as unknown as Response;
      }
      return okResp({ choices: [{ message: { content: '一只猫' } }] });
    });
    const out = await visionDescribe(VIS, ['https://h/ok.jpg', 'https://h/dead.jpg'], 'x', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toContain('一只猫');
    expect(out).toContain('1 more image(s) could not be read and were skipped');
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad', text: async () => 'nope' }) as unknown as Response);
    await expect(
      visionDescribe(VIS, [DATA_IMG], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/400/);
  });

  it('throws when the model returns no content', async () => {
    const fetchImpl = vi.fn(async () => okResp({ choices: [{ message: {} }] }));
    await expect(
      visionDescribe(VIS, [DATA_IMG], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no content/);
  });

  it('throws a clear error on a 200-but-non-JSON body (gateway/HTML page)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html>blocked</html>',
    }) as unknown as Response);
    await expect(
      visionDescribe(VIS, [DATA_IMG], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/non-JSON/);
  });
});

describe('imageUrlForProvider (§10.24 补 — provider-specific base64 shape)', () => {
  const DU = 'data:image/png;base64,AAAA';
  it('GLM (provider or bigmodel baseUrl) → raw payload; others → untouched data URL', () => {
    expect(imageUrlForProvider({ provider: 'glm', baseUrl: 'https://x' }, DU)).toBe('AAAA');
    expect(
      imageUrlForProvider({ provider: 'custom', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, DU),
    ).toBe('AAAA');
    expect(
      imageUrlForProvider({ provider: 'custom', baseUrl: 'https://a.aliyuncs.com/v1' }, DU),
    ).toBe(DU);
  });
  it('http(s) refs pass through for every provider', () => {
    expect(imageUrlForProvider({ provider: 'glm', baseUrl: 'https://open.bigmodel.cn' }, 'https://h/a.jpg')).toBe(
      'https://h/a.jpg',
    );
  });

  it('OpenAI / Kimi / MiniMax keep the FULL data URL (all three officially take data URLs)', () => {
    for (const p of [
      { provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' },
      { provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1' },
    ])
      expect(imageUrlForProvider(p, DU)).toBe(DU);
  });
});

describe('providerAcceptsHttpImageUrl (§10.24 补 — Kimi 明确不收 URL 图片，仅 base64)', () => {
  it('kimi provider / moonshot / kimi.com baseUrl → false (raw-URL fallback would 400 the request)', () => {
    expect(providerAcceptsHttpImageUrl({ provider: 'kimi', baseUrl: 'https://api.moonshot.cn/v1' })).toBe(false);
    expect(providerAcceptsHttpImageUrl({ provider: 'custom', baseUrl: 'https://api.moonshot.ai/v1' })).toBe(false);
    expect(providerAcceptsHttpImageUrl({ provider: 'custom', baseUrl: 'https://api.kimi.com/v1' })).toBe(false);
  });
  it('OpenAI / MiniMax / GLM / Aliyun servers download URLs themselves → true', () => {
    expect(providerAcceptsHttpImageUrl({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(true);
    expect(providerAcceptsHttpImageUrl({ provider: 'minimax', baseUrl: 'https://api.minimaxi.com/v1' })).toBe(true);
    expect(providerAcceptsHttpImageUrl({ provider: 'glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })).toBe(true);
    expect(
      providerAcceptsHttpImageUrl({ provider: 'custom', baseUrl: 'https://x.maas.aliyuncs.com/compatible-mode/v1' }),
    ).toBe(true);
  });
});

describe('generateImage', () => {
  it('POSTs /images/generations and returns urls', async () => {
    const fetchImpl = vi.fn(async () => okResp({ data: [{ url: 'https://img/1.png' }, { url: 'https://img/2.png' }] }));
    const out = await generateImage(IMG, '一只柴犬', { size: '1024x1024', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.urls).toEqual(['https://img/1.png', 'https://img/2.png']);
    expect(out.dataUrls).toEqual([]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/images/generations');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'cogview-4', prompt: '一只柴犬', size: '1024x1024' });
  });

  it('handles b64_json responses as data URLs', async () => {
    const fetchImpl = vi.fn(async () => okResp({ data: [{ b64_json: 'AAAA' }] }));
    const out = await generateImage(IMG, 'x', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.urls).toEqual([]);
    expect(out.dataUrls).toEqual(['data:image/png;base64,AAAA']);
  });

  it('throws when no images come back', async () => {
    const fetchImpl = vi.fn(async () => okResp({ data: [] }));
    await expect(
      generateImage(IMG, 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no images/);
  });
});

describe('generateImage — Dashscope (qwen-image / wanx)', () => {
  const QWEN: LlmProfile = {
    id: 'q',
    label: 'qwen-img',
    provider: 'custom',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-q',
    model: 'qwen-image-2.0',
  };

  it('derives the native multimodal-generation endpoint from a compatible-mode baseUrl', () => {
    expect(dashscopeImageEndpoint('https://x.maas.aliyuncs.com/compatible-mode/v1')).toBe(
      'https://x.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(dashscopeImageEndpoint('https://dashscope.aliyuncs.com/api/v1')).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
  });

  it('uses the Dashscope request shape + parses output.choices[].message.content[].image', async () => {
    const fetchImpl = vi.fn(async () =>
      okResp({
        output: { choices: [{ message: { content: [{ image: 'https://oss/result.png' }] } }] },
      }),
    );
    const out = await generateImage(QWEN, '一只柴犬', {
      size: '1024x1024',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.urls).toEqual(['https://oss/result.png']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('qwen-image-2.0');
    expect(body.input.messages[0].content).toEqual([{ text: '一只柴犬' }]);
    expect(body.parameters.size).toBe('1024*1024'); // x → *
  });
});

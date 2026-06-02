/**
 * specialist — vision describe + image generation sub-calls. fetchImpl injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { visionDescribe, generateImage, dashscopeImageEndpoint } from '../src/agent/specialist';
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

describe('visionDescribe', () => {
  it('POSTs an image_url chat message and returns the model text', async () => {
    const fetchImpl = vi.fn(async () =>
      okResp({ choices: [{ message: { content: '图里是一只猫' } }] }),
    );
    const out = await visionDescribe(VIS, ['https://h/a.jpg'], '这是什么', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('图里是一只猫');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('glm-4.6v');
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'https://h/a.jpg' } },
    ]);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad', text: async () => 'nope' }) as unknown as Response);
    await expect(
      visionDescribe(VIS, ['https://h/a.jpg'], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/400/);
  });

  it('throws when the model returns no content', async () => {
    const fetchImpl = vi.fn(async () => okResp({ choices: [{ message: {} }] }));
    await expect(
      visionDescribe(VIS, ['https://h/a.jpg'], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
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
      visionDescribe(VIS, ['https://h/a.jpg'], 'x', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/non-JSON/);
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

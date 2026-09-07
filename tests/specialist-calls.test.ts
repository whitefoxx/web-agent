import { describe, it, expect } from 'vitest';
import { isViewableImageUrl, handleSpecialistCall } from '../src/agent/specialist-calls';

describe('isViewableImageUrl (view_image input filter)', () => {
  it('accepts http(s) URLs', () => {
    expect(isViewableImageUrl('https://pbs.twimg.com/media/abc.jpg')).toBe(true);
    expect(isViewableImageUrl('http://example.com/x.png')).toBe(true);
    expect(isViewableImageUrl('HTTPS://EXAMPLE.com/x')).toBe(true);
  });

  it('accepts data:image/… base64 URLs (e.g. a screenshot result)', () => {
    expect(isViewableImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(isViewableImageUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
    expect(isViewableImageUrl('  data:image/webp;base64,xyz  ')).toBe(true); // trims
  });

  it('rejects non-image data URLs and non-fetchable schemes', () => {
    expect(isViewableImageUrl('data:application/pdf;base64,xxx')).toBe(false);
    expect(isViewableImageUrl('data:text/plain,hello')).toBe(false);
    expect(isViewableImageUrl('ftp://host/x.png')).toBe(false);
    expect(isViewableImageUrl('/relative/x.png')).toBe(false);
    expect(isViewableImageUrl('')).toBe(false);
  });
});

describe('handleSpecialistCall view_image — [img_N] registry references (§10.25)', () => {
  const VIS = {
    id: 'v',
    label: 'v',
    provider: 'glm',
    baseUrl: 'https://h/v4',
    apiKey: 'k',
    model: 'glm-4.6v',
  } as unknown as import('../src/config/llm-config').LlmProfile;

  it('resolves img_N via ctx.resolveImageRef before validation (inline path returns the real ref)', async () => {
    const sr = await handleSpecialistCall(
      'view_image',
      { images: ['img_3'] },
      {
        visionProfile: VIS,
        visionInline: true,
        imageProfile: null,
        resolveImageRef: (t) => (t === 'img_3' ? 'data:image/png;base64,AAAA' : null),
        availableImageIds: () => ['img_3'],
      },
    );
    expect(sr.ok).toBe(true);
    expect(sr.inlineImages).toEqual(['data:image/png;base64,AAAA']);
  });

  it('echoed redaction placeholder → clear error listing the usable img ids', async () => {
    const sr = await handleSpecialistCall(
      'view_image',
      { images: ['data:image/png;base64,[image omitted]'] },
      {
        visionProfile: VIS,
        visionInline: true,
        imageProfile: null,
        resolveImageRef: () => null,
        availableImageIds: () => ['img_1', 'img_2'],
      },
    );
    expect(sr.ok).toBe(false);
    expect(sr.toolContent).toContain('redaction placeholder');
    expect(sr.toolContent).toContain('img_2');
  });

  it('no usable image AND empty registry → steer to screenshot-first', async () => {
    const sr = await handleSpecialistCall(
      'view_image',
      { images: ['[图片已省略]'] },
      {
        visionProfile: VIS,
        visionInline: true,
        imageProfile: null,
        resolveImageRef: () => null,
        availableImageIds: () => [],
      },
    );
    expect(sr.ok).toBe(false);
    expect(sr.toolContent).toContain('screenshot');
  });
});

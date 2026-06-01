import { describe, expect, it } from 'vitest';
import { collectImageRefs, isDataUrl, stripDataUrls, DEFAULT_IMAGE_CAP } from '../src/agent/tool-images';

describe('collectImageRefs', () => {
  it('extracts http image URLs from a nested array (weibo pics shape)', () => {
    const result = [
      { field: 'author', value: '圈内容嬷嬷' },
      {
        field: 'pics',
        value: [
          'https://wx4.sinaimg.cn/large/a.jpg',
          'https://wx2.sinaimg.cn/orj1080/b.jpg',
        ],
      },
      { field: 'url', value: 'https://weibo.com/6624782994/R20eQjl5m' }, // not an image
    ];
    expect(collectImageRefs(result)).toEqual([
      'https://wx4.sinaimg.cn/large/a.jpg',
      'https://wx2.sinaimg.cn/orj1080/b.jpg',
    ]);
  });

  it('extracts a data: URL (screenshot shape)', () => {
    const result = { dataUrl: 'data:image/png;base64,AAAABBBB', bytes: 8, url: 'https://x.com' };
    expect(collectImageRefs(result)).toEqual(['data:image/png;base64,AAAABBBB']);
  });

  it('tolerates query/hash after the extension and matches common raster formats', () => {
    const v = [
      'https://h/a.jpg?KID=imgbed&Expires=1',
      'https://h/b.PNG',
      'https://h/c.webp#frag',
    ];
    expect(collectImageRefs(v)).toEqual(v);
  });

  it('rejects SVG (vector — vision endpoints 400 on image/svg+xml)', () => {
    expect(collectImageRefs(['https://h/icon.svg', 'data:image/svg+xml;base64,PHN2Zz4='])).toEqual([]);
  });

  it('matches extension-less image-CDN hosts (xiaohongshu / xhscdn)', () => {
    const v = [
      'https://ci.xiaohongshu.com/1040g0083abc',
      'https://sns-img-qc.xhscdn.com/202401/xyz',
      'https://wx4.sinaimg.cn/large/007.jpg',
    ];
    expect(collectImageRefs(v)).toEqual(v);
    // but a non-CDN xiaohongshu.com API URL is NOT treated as an image
    expect(collectImageRefs(['https://www.xiaohongshu.com/api/sns/v1/note'])).toEqual([]);
  });

  it('ignores non-image URLs and non-URL strings', () => {
    expect(collectImageRefs(['hello', 'https://example.com/page', 'ftp://h/x.jpg', '/local/x.jpg'])).toEqual([]);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(
      collectImageRefs(['https://h/a.jpg', 'https://h/b.jpg', 'https://h/a.jpg']),
    ).toEqual(['https://h/a.jpg', 'https://h/b.jpg']);
  });

  it('caps the number of images', () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://h/${i}.jpg`);
    expect(collectImageRefs(many)).toHaveLength(DEFAULT_IMAGE_CAP);
    expect(collectImageRefs(many, 2)).toEqual(['https://h/0.jpg', 'https://h/1.jpg']);
  });

  it('walks deep objects but stops at the depth guard', () => {
    expect(collectImageRefs({ a: { b: { c: ['https://h/deep.jpg'] } } })).toEqual([
      'https://h/deep.jpg',
    ]);
  });

  it('returns [] for primitives / null', () => {
    expect(collectImageRefs(null)).toEqual([]);
    expect(collectImageRefs(42)).toEqual([]);
    expect(collectImageRefs('https://h/x.jpg')).toEqual(['https://h/x.jpg']);
  });
});

describe('isDataUrl', () => {
  it('distinguishes data URLs from http image URLs', () => {
    expect(isDataUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isDataUrl('https://h/a.jpg')).toBe(false);
  });
});

describe('stripDataUrls', () => {
  it('replaces base64 image blobs with a placeholder, leaving other text intact', () => {
    const text = '{"dataUrl":"data:image/png;base64,AAAABBBBCCCC==","bytes":12}';
    expect(stripDataUrls(text)).toBe('{"dataUrl":"[图片已省略]","bytes":12}');
  });
  it('strips every data URL in the text', () => {
    const text = 'a data:image/png;base64,AAAA b data:image/jpeg;base64,BBBB c';
    expect(stripDataUrls(text)).toBe('a [图片已省略] b [图片已省略] c');
  });
});

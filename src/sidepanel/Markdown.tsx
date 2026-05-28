/**
 * Render markdown safely. Chatbot output is treated as untrusted: parse with
 * `marked` (GFM) and sanitize with DOMPurify before insertion. All links
 * open in a new tab so a misclick can't replace the side panel.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: false,
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const raw = marked.parse(text, { async: false }) as string;
  const html = DOMPurify.sanitize(raw);
  return (
    <div
      class={className ? `markdown ${className}` : 'markdown'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

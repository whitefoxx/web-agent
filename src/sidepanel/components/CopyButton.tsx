/**
 * Small copy-to-clipboard button (icon + state). Reused for code/result.
 */
import { useState } from 'preact/hooks';
import { IconCopy } from '../Icons';

export function CopyButton({ text, label }: { text: string; label?: string }): preact.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      title="Copy"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {});
      }}
      style="display:inline-flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;opacity:.7;font-size:12px;padding:2px 4px;color:inherit;"
    >
      <IconCopy size={13} />
      <span>{done ? 'Copied' : (label ?? 'Copy')}</span>
    </button>
  );
}

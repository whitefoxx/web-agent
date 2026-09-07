/**
 * A scrollable code/result box with a copy button in its header.
 */
import { CopyButton } from './CopyButton';

export function CopyableBlock({
  text,
  title,
  maxHeight = 320,
}: {
  text: string;
  title: string;
  maxHeight?: number;
}): preact.JSX.Element {
  return (
    <div style="margin-top:6px;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 6px;background:var(--surface-hover);font-size:11px;opacity:.8;">
        <span>{title}</span>
        <CopyButton text={text} />
      </div>
      <pre
        style={`max-height:${maxHeight}px;overflow:auto;background:var(--bg-inset);padding:8px;margin:0;font-size:11px;white-space:pre-wrap;`}
      >
        {text}
      </pre>
    </div>
  );
}

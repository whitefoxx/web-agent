/**
 * Reusable contenteditable editor with a `/` command palette — shared by the
 * main composer and the workflow recipe field. Free text mixes with atomic,
 * styled, clickable command chips (adapters/tools); workflows expand to their recipe
 * text (which may itself embed ⟦tool:..⟧ tokens → chips). The serialized value
 * uses ⟦tool:NAME⟧ / ⟦cmd:NAME⟧ tokens.
 *
 * The parent drives content imperatively via `apiRef` (insertCommand / clear /
 * focus / insertTextWithTokens) and observes changes via `onChange`.
 */

import { useRef, useState } from 'preact/hooks';
import { filterCommands, toolToken, cmdToken, type CommandItem, type ChipKind } from './commands';
import type { Shortcut, ShortcutMode } from '../shortcuts/store';

export interface CommandEditorHandle {
  insertCommand(kind: ChipKind, name: string, label: string): void;
  insertTextWithTokens(text: string): void;
  clear(): void;
  focus(): void;
  getValue(): string;
}

interface Groups {
  builtins?: CommandItem[];
  shortcuts: CommandItem[];
  skills?: CommandItem[];
  tools: CommandItem[];
}

/** Viewport-fixed placement for the `/` palette (see computePos). */
interface PickerPos {
  left: number;
  width: number;
  up: boolean;
  edge: number;
  maxH: number;
}

export function CommandEditor(props: {
  apiRef?: { current: CommandEditorHandle | null };
  placeholder?: string;
  disabled?: boolean;
  /** Categories offered by `/` (omit shortcuts to forbid recursion). */
  getCommands: () => Groups;
  /** Fires with the serialized value on every edit. */
  onChange?: (serialized: string) => void;
  /** Present → Enter sends (calls this); absent → Enter inserts a newline. */
  onEnter?: () => void;
  /** Notified when a shortcut is picked (parent may e.g. set the run mode). */
  onPickShortcut?: (s: Shortcut) => void;
  /** A built-in /command requested a mode switch (/plan, /explore). */
  onSetMode?: (mode: ShortcutMode) => void;
}): preact.JSX.Element {
  const editorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // Drives the placeholder (.is-empty) from REAL content (text + chips), so a
  // leftover <br> from type-then-delete doesn't keep the placeholder hidden the
  // way :empty would. Recomputed on every edit / clear / blur.
  const [empty, setEmpty] = useState(true);
  const [picker, setPicker] = useState<{
    mode: 'slash' | 'swap';
    q: string;
    sel: number;
    chip: HTMLElement | null;
    /** Viewport-fixed position, anchored to the CARET (slash) or the CHIP (swap)
     * so it hugs the cursor and — being position:fixed — is never clipped by a
     * scrolling ancestor (the bug in the workflow / scheduled-task form fields). */
    pos: PickerPos;
  } | null>(null);

  /** Fixed-position box for the palette, computed from the anchor rect. Opens
   * BELOW the caret by default — that never covers the text already typed above
   * it (a mid-form field like the scheduled-task prompt would otherwise flip up over it);
   * flips above only when there isn't enough room below (e.g. the bottom
   * composer). `maxH` caps it to the available space so it never runs off-screen.
   * `edge` is the px offset for `top` (down) or `bottom` (up). */
  function computePos(target: DOMRect): PickerPos {
    const er = editorRef.current?.getBoundingClientRect();
    // Match the field's horizontal box (readable full width in the narrow panel),
    // but anchor VERTICALLY to the caret line.
    const left = er ? er.left : target.left;
    const width = er ? er.width : 320;
    const above = target.top;
    const below = window.innerHeight - target.bottom;
    const gap = 6;
    // Default down; go up only when below is cramped and above has more room.
    const up = below < 220 && above > below;
    const maxH = Math.max(140, Math.min(320, (up ? above : below) - gap - 8));
    const edge = up ? window.innerHeight - target.top + gap : target.bottom + gap;
    return { left, width, up, edge, maxH };
  }

  /** Bounding rect of the collapsed caret, with fallbacks (a caret in an empty
   * spot can return a 0-rect). Ultimately falls back to the editor box. */
  function caretRect(): DOMRect | null {
    const sel = window.getSelection();
    const editorBox = editorRef.current?.getBoundingClientRect() ?? null;
    if (!sel || !sel.rangeCount) return editorBox;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = range.getBoundingClientRect();
    if (rect && (rect.top || rect.bottom || rect.left)) return rect;
    const rects = range.getClientRects();
    if (rects.length) return rects[0];
    return editorBox;
  }

  function serialize(el: HTMLElement): string {
    let out = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue ?? '';
      else if (node instanceof HTMLElement) {
        if (node.dataset.cmdKind)
          out +=
            node.dataset.cmdKind === 'cmd'
              ? cmdToken(node.dataset.cmdName ?? '')
              : toolToken(node.dataset.cmdName ?? '');
        else if (node.tagName === 'BR') out += '\n';
        else out += serialize(node);
      }
    });
    return out;
  }
  function refreshEmpty(): void {
    const el = editorRef.current;
    if (el) setEmpty(!el.textContent && !el.querySelector('.cmd-chip'));
  }
  function sync(): void {
    if (editorRef.current) props.onChange?.(serialize(editorRef.current));
    refreshEmpty();
  }
  function makeChipEl(kind: ChipKind, name: string, label: string): HTMLSpanElement {
    const chip = document.createElement('span');
    chip.className = 'cmd-chip';
    chip.contentEditable = 'false';
    chip.dataset.cmdKind = kind;
    chip.dataset.cmdName = name;
    chip.title = 'Click to swap · ✕ to remove';
    const icon = document.createElement('span');
    icon.textContent = kind === 'cmd' ? '⚡ ' : '🔧 ';
    const text = document.createElement('span');
    text.textContent = label;
    const x = document.createElement('span');
    x.className = 'cmd-chip-x';
    x.textContent = '✕';
    x.dataset.cmdX = '1';
    chip.append(icon, text, x);
    return chip;
  }
  function insertNodeAtCaret(node: Node): void {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(node);
    range.setStartAfter(space);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    sync();
  }
  function insertTextWithTokens(text: string): void {
    const frag = document.createDocumentFragment();
    const re = /⟦(tool|cmd):([^⟧]+)⟧/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(makeChipEl(m[1] as ChipKind, m[2], m[2]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    insertNodeAtCaret(frag);
  }
  function insertCommand(kind: ChipKind, name: string, label: string): void {
    const el = editorRef.current;
    if (!el) return;
    el.appendChild(makeChipEl(kind, name, label));
    el.appendChild(document.createTextNode(' '));
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    sync();
  }
  function clear(): void {
    if (editorRef.current) editorRef.current.innerHTML = '';
    props.onChange?.('');
    setEmpty(true);
    setPicker(null);
  }

  // expose the imperative handle
  if (props.apiRef)
    props.apiRef.current = {
      insertCommand,
      insertTextWithTokens,
      clear,
      focus: () => editorRef.current?.focus(),
      getValue: () => (editorRef.current ? serialize(editorRef.current) : ''),
    };

  const groups = picker
    ? (() => {
        const all = props.getCommands();
        return [
          { key: 'builtin', title: 'Commands', items: filterCommands(all.builtins ?? [], picker.q) },
          { key: 'shortcut', title: 'Workflows', items: filterCommands(all.shortcuts, picker.q) },
          { key: 'skill', title: 'Skills', items: filterCommands(all.skills ?? [], picker.q) },
          { key: 'tool', title: 'Tools', items: filterCommands(all.tools, picker.q) },
        ];
      })()
    : [];
  const flat: CommandItem[] = groups.flatMap((g) => g.items);

  function pick(item: CommandItem): void {
    const el = editorRef.current;
    if (!el || !picker) return;
    if (picker.mode === 'swap' && picker.chip) {
      if (item.kind === 'builtin') {
        // mode builtins (/plan, /explore) just switch mode (drop the chip);
        // prompt builtins swap into a ⟦cmd:..⟧ chip.
        if (item.builtin?.mode) {
          picker.chip.remove();
          props.onSetMode?.(item.builtin.mode);
        } else {
          picker.chip.replaceWith(makeChipEl('cmd', item.name, item.name));
        }
      } else if (item.kind === 'shortcut') {
        const t = item.shortcut?.kind === 'prompt' ? (item.shortcut.text ?? '') : '';
        picker.chip.replaceWith(document.createTextNode(t));
      } else if (item.kind === 'skill') {
        picker.chip.replaceWith(document.createTextNode(item.skill?.body ?? ''));
      } else {
        picker.chip.replaceWith(makeChipEl('tool', item.name, item.label));
      }
      setPicker(null);
      el.focus();
      sync();
      return;
    }
    // slash mode: delete the "/query" before the caret, then insert.
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        const off = r.startOffset;
        const from = Math.max(0, off - (picker.q.length + 1));
        const dr = document.createRange();
        dr.setStart(node, from);
        dr.setEnd(node, off);
        dr.deleteContents();
        sel.removeAllRanges();
        sel.addRange(dr);
      }
    }
    if (item.kind === 'builtin') {
      if (item.builtin?.mode) {
        props.onSetMode?.(item.builtin.mode);
        el.focus();
        sync();
      } else {
        // prompt builtins drop a ⟦cmd:..⟧ chip (expanded to the canned prompt
        // on send) instead of dumping the raw instruction text.
        insertNodeAtCaret(makeChipEl('cmd', item.name, item.name));
      }
    } else if (item.kind === 'shortcut') {
      if (item.shortcut?.kind === 'tool' && item.shortcut.tool)
        insertNodeAtCaret(makeChipEl('tool', item.shortcut.tool, item.shortcut.tool));
      else insertTextWithTokens(item.shortcut?.text ?? '');
      if (item.shortcut) props.onPickShortcut?.(item.shortcut);
    } else if (item.kind === 'skill') {
      // Skills insert their markdown body (⟦tool:..⟧ tokens → chips), like a workflow.
      insertTextWithTokens(item.skill?.body ?? '');
    } else {
      insertNodeAtCaret(makeChipEl('tool', item.name, item.label));
    }
    setPicker(null);
  }

  function onInput(): void {
    sync();
    const el = editorRef.current;
    if (el && !el.textContent && !el.querySelector('.cmd-chip')) el.innerHTML = '';
    if (composingRef.current) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editorRef.current?.contains(sel.anchorNode)) {
      setPicker((p) => (p?.mode === 'slash' ? null : p));
      return;
    }
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      setPicker((p) => (p?.mode === 'slash' ? null : p));
      return;
    }
    const before = (node.nodeValue ?? '').slice(0, r.startOffset);
    const mm = before.match(/(?:^|\s)\/([^\s/]*)$/);
    if (mm) {
      const rect = caretRect();
      setPicker((p) => ({
        mode: 'slash',
        q: mm[1],
        sel: 0,
        chip: null,
        // Recompute placement as the query grows (caret moves); keep the prior
        // box if the caret rect is momentarily unavailable.
        pos: rect ? computePos(rect) : (p?.pos ?? computePos(new DOMRect())),
      }));
    } else setPicker((p) => (p?.mode === 'slash' ? null : p));
  }

  function onClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement;
    if (t.dataset?.cmdX) {
      ev.preventDefault();
      t.closest('.cmd-chip')?.remove();
      sync();
      return;
    }
    const chip = t.closest('.cmd-chip') as HTMLElement | null;
    if (chip) {
      ev.preventDefault();
      setPicker({
        mode: 'swap',
        q: '',
        sel: 0,
        chip,
        pos: computePos(chip.getBoundingClientRect()),
      });
    }
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (picker && flat.length) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setPicker({ ...picker, sel: (picker.sel + 1) % flat.length });
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setPicker({ ...picker, sel: (picker.sel - 1 + flat.length) % flat.length });
        return;
      }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.isComposing) {
        ev.preventDefault();
        pick(flat[picker.sel] ?? flat[0]);
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setPicker(null);
        return;
      }
    }
    if (picker && ev.key === 'Escape') {
      setPicker(null);
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && props.onEnter) {
      ev.preventDefault();
      props.onEnter();
    } else if (ev.key === 'Enter' && (ev.shiftKey || !props.onEnter)) {
      ev.preventDefault();
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        const nl = document.createTextNode('\n');
        r.insertNode(nl);
        r.setStartAfter(nl);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
        sync();
      }
    }
  }

  return (
    <div class="composer-wrap">
      {picker && (
        <>
          <div class="cmd-picker-backdrop" onMouseDown={() => setPicker(null)} />
          <div
            class="cmd-picker"
            style={{
              position: 'fixed',
              left: picker.pos.left,
              width: picker.pos.width,
              maxHeight: picker.pos.maxH,
              ...(picker.pos.up ? { bottom: picker.pos.edge } : { top: picker.pos.edge }),
            }}
          >
            {flat.length === 0 ? (
              <div class="cmd-picker-empty">No matching commands</div>
            ) : (
              groups.map((g) =>
                g.items.length ? (
                  <div key={g.key} class="cmd-picker-group">
                    <div class="cmd-picker-title">{g.title}</div>
                    {g.items.map((it) => {
                      const idx = flat.indexOf(it);
                      return (
                        <button
                          key={`${it.kind}:${it.id}`}
                          class={`cmd-picker-item ${idx === picker.sel ? 'on' : ''}`}
                          onMouseEnter={() => setPicker((p) => (p ? { ...p, sel: idx } : p))}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pick(it);
                          }}
                        >
                          <span class="cmd-picker-name">
                            {g.key === 'shortcut'
                              ? '⛓ '
                              : g.key === 'skill'
                                ? '📄 '
                                : g.key === 'tool'
                                  ? '🔧 '
                                  : g.key === 'builtin'
                                    ? '⚡ '
                                    : '⤷ '}
                            {it.label}
                          </span>
                          {it.desc && <span class="cmd-picker-desc">{it.desc}</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : null,
              )
            )}
          </div>
        </>
      )}
      <div
        ref={editorRef}
        class={`composer-input ${empty ? 'is-empty' : ''}`}
        contentEditable={props.disabled ? 'false' : 'true'}
        role="textbox"
        aria-multiline="true"
        data-placeholder={props.placeholder ?? ''}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onBlur={refreshEmpty}
        onCompositionStart={() => (composingRef.current = true)}
        onCompositionEnd={() => {
          composingRef.current = false;
          onInput();
        }}
        onPaste={(e) => {
          e.preventDefault();
          const t = e.clipboardData?.getData('text/plain') ?? '';
          document.execCommand('insertText', false, t);
        }}
      />
    </div>
  );
}

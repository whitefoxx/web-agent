/**
 * Desktop notifications for finished runs — the "auto mode on + panel closed →
 * ping me when it's done" path. The extension ships no icon file, so the badge
 * PNG is generated once via OffscreenCanvas. The notifications.onClicked
 * listener that reopens the panel is registered from the SW entry.
 */

import { warn } from '@base/runtime/log';
import type { SessionState } from '../agent/session';
import { keepaliveConnections } from '@base/background/runtime-state';

const SCOPE = 'sw';

/** A 128px PNG data URL for notifications, generated once via OffscreenCanvas
 * (the extension ships no icon file). Falls back to a 1×1 if canvas is missing. */
let cachedNotifIcon: string | null = null;
async function notifIcon(): Promise<string> {
  if (cachedNotifIcon) return cachedNotifIcon;
  try {
    const c = new OffscreenCanvas(128, 128);
    const x = c.getContext('2d');
    if (!x) throw new Error('no 2d context');
    x.fillStyle = '#f5a623';
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = '#1a1a1a';
    x.font = 'bold 84px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText('✓', 64, 72);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    cachedNotifIcon = `data:image/png;base64,${btoa(s)}`;
  } catch {
    cachedNotifIcon =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
  return cachedNotifIcon;
}

/** When a run finishes and NO panel is open (no keepalive port connected), fire a
 * desktop notification so the user can come back — the point of auto mode + a
 * closed panel. Panel open → they already see the result, so skip. */
export async function notifyTaskDoneIfClosed(
  session: SessionState,
  runError: string | null,
): Promise<void> {
  if (keepaliveConnections.size > 0) return;
  try {
    let body = runError ? `Failed: ${runError}` : 'Task complete';
    if (!runError) {
      for (let i = session.history.length - 1; i >= 0; i--) {
        const t = session.history[i];
        if (t.role === 'assistant') {
          if (t.cleanedText) body = t.cleanedText;
          break;
        }
      }
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 140) || 'Click to see the result';
    await chrome.notifications.create(`done_${session.id}`, {
      type: 'basic',
      iconUrl: await notifIcon(),
      title: runError ? 'Web Agent · Task failed' : 'Web Agent · Task complete',
      message: body,
      priority: 1,
    });
  } catch (e) {
    warn(SCOPE, 'notify failed', e);
  }
}

/** A scheduled-task run finished (H3). Panel open → skip (the in-panel top
 * banner shows it live); panel closed → desktop ping. `done_<sessionId>` reuses
 * the existing onClicked handler that reopens the panel. */
export async function notifyScheduleDone(
  label: string,
  ok: boolean,
  sessionId: string,
): Promise<void> {
  if (keepaliveConnections.size > 0) return;
  try {
    await chrome.notifications.create(`done_${sessionId}`, {
      type: 'basic',
      iconUrl: await notifIcon(),
      title: ok ? 'Web Agent · Scheduled task complete' : 'Web Agent · Scheduled task failed',
      message: `⏰ ${label} — the result has been saved to History; click to open the side panel and view it.`,
      priority: 1,
    });
  } catch (e) {
    warn(SCOPE, 'notify schedule failed', e);
  }
}

/** ③a bridge takeover: an EXTERNAL agent (over the bridge) asked for a human step
 * (login / captcha / a judgment call). The user is likely not watching the panel
 * — fire a desktop ping with the ask so they come act on it. Unlike the done
 * notification, this fires even with the panel open (the whole point is they're
 * away). Best-effort; never throws. */
export async function notifyHumanTakeover(objective: string): Promise<void> {
  try {
    const body = objective.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Needs you to help with a step in the browser';
    await chrome.notifications.create(`takeover_${Date.now().toString(36)}`, {
      type: 'basic',
      iconUrl: await notifIcon(),
      title: 'Web Agent · Needs your help with a step',
      message: body,
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    warn(SCOPE, 'takeover notify failed', e);
  }
}

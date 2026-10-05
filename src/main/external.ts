/**
 * Opening things outside the app. Only https: (after the user confirms) and mailto: are ever handed
 * to the OS; every other scheme (file:, javascript:, smb:, ms-*, custom protocol handlers…) is refused.
 */
import { dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { describeError, log } from './log.ts';
import { parseExternalUrl } from './policy.ts';

export { parseExternalUrl } from './policy.ts';

let confirmOpen = false;

/**
 * Open a validated URL in the OS. https: asks first (showing the host) so a compromised or buggy
 * renderer cannot silently launch the browser; mailto: opens directly. Returns whether it was opened.
 */
export async function openExternalUrl(url: URL, parent: BrowserWindow | null, options: { confirm: boolean }): Promise<boolean> {
  if (url.protocol === 'https:' && options.confirm) {
    if (confirmOpen) return false; // one prompt at a time; ignore floods
    confirmOpen = true;
    try {
      const box = {
        type: 'question' as const,
        title: 'Open link',
        message: `Open ${url.hostname} in your web browser?`,
        detail: url.href,
        buttons: ['Open in browser', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
      if (response !== 0) return false;
    } finally {
      confirmOpen = false;
    }
  }
  try {
    await shell.openExternal(url.href);
    log('info', 'Opened external link', { scheme: url.protocol, host: url.hostname });
    return true;
  } catch (err) {
    log('warn', 'Could not open external link', describeError(err));
    return false;
  }
}

/** Fire-and-forget variant for navigation/window-open interception. */
export function handleExternalNavigation(raw: string, parent: BrowserWindow | null): void {
  const url = parseExternalUrl(raw);
  if (!url) {
    log('warn', 'Blocked navigation to a non-allowed URL', { scheme: safeScheme(raw) });
    return;
  }
  void openExternalUrl(url, parent, { confirm: true });
}

function safeScheme(raw: string): string {
  const m = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(raw);
  return m ? m[1].toLowerCase() : 'invalid';
}

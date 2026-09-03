import { browser } from 'wxt/browser';
import { countUnread } from '../db';

export async function updateBadge(): Promise<void> {
  try {
    const unread = await countUnread();
    const text = unread <= 0 ? '' : unread > 999 ? '999+' : String(unread);
    await browser.action.setBadgeText({ text });
    await browser.action.setBadgeBackgroundColor({ color: '#cc1414' });
  } catch {
    // badge is cosmetic; ignore failures
  }
}

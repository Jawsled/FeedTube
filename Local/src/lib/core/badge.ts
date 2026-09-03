import { countUnread } from '../db';

// In the local web app there is no extension action badge. We surface the
// unread count in the document title instead, which is visible even when the
// tab is not focused.
export async function updateBadge(): Promise<void> {
  try {
    const unread = await countUnread();
    if (typeof document !== 'undefined') {
      const text = unread <= 0 ? '' : unread > 999 ? '999+' : String(unread);
      document.title = text ? `${text} unseen — FeedTube` : 'FeedTube';
    }
  } catch {
    // badge is cosmetic; ignore failures
  }
}

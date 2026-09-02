// Startup + background behavior for the local web app. Replaces what the
// extension's background service worker did: resume interrupted refreshes,
// auto-refresh on load (per settings), and periodic refresh alarms. In a
// browser tab there are no alarms — a setInterval while the page is open
// plays that role.

import { listChannels } from './lib/db';
import { loadSettings } from './lib/settings';
import { refreshAll, resumePendingRefresh } from './lib/core/feed-engine';
import { updateBadge } from './lib/core/badge';
import { browser } from './lib/platform';

let timer: number | null = null;

async function schedule(): Promise<void> {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  const settings = await loadSettings();
  if (!settings.refreshPeriodMin || settings.refreshPeriodMin <= 0) return;
  timer = window.setInterval(() => {
    void refreshAll().catch((e) => console.error('[FeedTube] periodic refresh failed:', e));
  }, settings.refreshPeriodMin * 60_000);
}

export async function startRuntime(): Promise<void> {
  try {
    const [settings, channels] = await Promise.all([loadSettings(), listChannels()]);

    if (channels.length > 0) {
      // Resume a refresh that was interrupted by closing the page. If there
      // is nothing pending and auto-refresh is enabled, start one now.
      const resumed = await resumePendingRefresh();
      if (!resumed && settings.autoRefreshOnLoad) {
        void refreshAll().catch((e) => console.error('[FeedTube] startup refresh failed:', e));
      }
    }

    // Keep the unread counter in the tab title current.
    void updateBadge();

    // Reschedule the periodic timer whenever settings change (the extension
    // did this via `cmd/reschedule-alarm` from SettingsView).
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'settings' in changes) void schedule();
    });

    await schedule();
  } catch (e) {
    console.error('[FeedTube] runtime startup failed:', e);
  }
}

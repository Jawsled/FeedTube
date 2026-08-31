import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { appendLog, refreshAll, cancelRefresh, readStoredStatus, resumePendingRefresh, clearStoredLog } from '../lib/core/feed-engine';
import { updateBadge } from '../lib/core/badge';
import { pruneOldVideos, listChannels, upsertChannels, listTags, setChannelTags } from '../lib/db';
import { loadSettings } from '../lib/settings';
import { autoCategorizeChannel } from '../lib/api/categorize';
import type { ChannelRecord } from '../lib/types';

const ALARM_NAME = 'feedtube-refresh';
// The 25-30s keep-alive alarm. Chrome's minimum alarm period is 30s
// (Chrome 120+), which is exactly the SW idle window — every alarm fire
// counts as activity and resets the idle timer, so the SW stays alive
// during long refreshes. It also wakes up a fresh SW instance if the
// previous one was killed, which is how we recover from mid-refresh SW
// terminations.
const KEEP_ALIVE_ALARM = 'feedtube-keepalive';
const DNR_RULE_IDS = [1, 2, 3, 4, 5];

async function ensureDnrRules(): Promise<void> {
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: DNR_RULE_IDS,
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
              { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
            ],
          },
          condition: {
            urlFilter: '||youtube.com/youtubei/',
            resourceTypes: ['xmlhttprequest'],
          },
        },
        {
          id: 2,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://m.soundcloud.com' },
              { header: 'Referer', operation: 'set', value: 'https://m.soundcloud.com/' },
              { header: 'Accept', operation: 'set', value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            ],
          },
          condition: {
            urlFilter: '||m.soundcloud.com',
            resourceTypes: ['xmlhttprequest'],
          },
        },
        {
          id: 3,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://soundcloud.com' },
              { header: 'Referer', operation: 'set', value: 'https://soundcloud.com/' },
              { header: 'Accept', operation: 'set', value: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
            ],
          },
          condition: {
            urlFilter: '||soundcloud.com',
            resourceTypes: ['xmlhttprequest'],
          },
        },
        {
          id: 4,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://soundcloud.com' },
              { header: 'Referer', operation: 'set', value: 'https://soundcloud.com/' },
            ],
          },
          condition: {
            urlFilter: '||a-v2.sndcdn.com',
            resourceTypes: ['xmlhttprequest'],
          },
        },
        {
          id: 5,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'set', value: 'https://soundcloud.com' },
              { header: 'Referer', operation: 'set', value: 'https://soundcloud.com/' },
              { header: 'Accept', operation: 'set', value: 'application/json' },
            ],
          },
          condition: {
            urlFilter: '||api-v2.soundcloud.com',
            resourceTypes: ['xmlhttprequest'],
          },
        },
      ],
    });
  } catch {
    // DNR unavailable or unsupported; native API calls will fail and the engine
    // falls back to Invidious/RSS.
  }
}

async function handleSubscribe(channelId: string, channelName: string, tags: string[]): Promise<void> {
  const existing = await listChannels();
  const already = existing.find((c) => c.id === channelId);
  if (already) {
    if (tags.length > 0) {
      const merged = [...new Set([...already.tags, ...tags])];
      await setChannelTags(channelId, merged);
    }
    return;
  }
  const record: ChannelRecord = {
    id: channelId,
    source: 'youtube',
    name: channelName,
    avatarUrl: null,
    tags,
    addedAt: Date.now(),
    lastFetchedAt: null,
    lastVideosFetchedAt: null,
    lastShortsFetchedAt: null,
    lastLiveFetchedAt: null,
    lastError: null,
    urlSlug: null,
  };
  await upsertChannels([record]);
  autoCategorizeChannel({ id: channelId, source: 'youtube' }, tags.map((t) => ({ name: t }))).catch(() => undefined);
  void browser.runtime.sendMessage({ type: 'cmd/start-refresh' });
}

export default defineBackground(() => {
  // The MV3 service worker can be terminated after 30s of idle. We use
  // two strategies to survive long refreshes:
  //   1. The keep-alive alarm below (every 30s) resets the SW idle
  //      timer. Each alarm fire is "activity" in Chrome's eyes.
  //   2. The feed engine persists `enginePending` to storage and the
  //      `runRefresh` loop yields to the event loop between batches, so
  //      even if the SW is killed, a fresh instance can resume from
  //      the exact same pending list.
  void appendLog({
    ts: Date.now(),
    level: 'info',
    channelId: null,
    channelName: null,
    source: null,
    message: 'Background service worker started',
  });

  // chrome.runtime.onSuspend is called just before the SW is terminated.
  // This is the last chance to flush state. Logging here is purely
  // diagnostic — it helps the user see in the log whether the SW was
  // being killed mid-refresh.
  browser.runtime.onSuspend.addListener(() => {
    void appendLog({
      ts: Date.now(),
      level: 'warn',
      channelId: null,
      channelName: null,
      source: null,
      message: 'Service worker suspending (will be terminated). Pending refresh will resume on next startup if needed.',
    });
    void flushLogSafely();
  });

  async function ensureKeepAliveAlarm(): Promise<void> {
    try {
      const existing = await browser.alarms.get(KEEP_ALIVE_ALARM);
      if (!existing) {
        await browser.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
      }
    } catch {
      // alarms API unavailable — accept the risk of mid-refresh SW termination
    }
  }

  async function flushLogSafely(): Promise<void> {
    try {
      const { flushLog } = await import('../lib/core/feed-engine');
      await flushLog();
    } catch {
      /* best-effort */
    }
  }

  async function ensureAlarm(): Promise<void> {
    const settings = await loadSettings();
    const period = settings.refreshPeriodMin;
    await browser.alarms.clear(ALARM_NAME);
    if (period > 0) {
      void browser.alarms.create(ALARM_NAME, { periodInMinutes: period });
    }
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      void refreshAll().then(() => updateBadge());
    } else if (alarm.name === KEEP_ALIVE_ALARM) {
      // Just touching storage counts as activity and keeps the SW alive.
      // Also serves as a heartbeat in the log.
      void appendLog({
        ts: Date.now(),
        level: 'info',
        channelId: null,
        channelName: null,
        source: null,
        message: 'Service worker keep-alive tick',
      });
      void flushLogSafely();
    }
  });

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const type = (msg as { type?: string } | null)?.type;
    void appendLog({
      ts: Date.now(),
      level: 'info',
      channelId: null,
      channelName: null,
      source: null,
      message: `Message received: ${type ?? '(no type)'}`,
    });
    switch (type) {
      case 'cmd/start-refresh': {
        const tags = (msg as { tags?: string[] } | null)?.tags;
        const channelIds = (msg as { channelIds?: string[] } | null)?.channelIds;
        const force = (msg as { force?: boolean } | null)?.force ?? false;
        void refreshAll({ tags, channelIds, force })
          .catch(() => undefined)
          .then(async () => {
            const settings = await loadSettings();
            await pruneOldVideos(settings.pruneDays);
          })
          .then(() => updateBadge());
        break;
      }
      case 'cmd/cancel-refresh':
        void cancelRefresh();
        break;
      case 'cmd/update-badge':
        void updateBadge();
        break;
      case 'cmd/clear-log':
        void clearStoredLog();
        break;
      case 'cmd/reschedule-alarm':
        void ensureAlarm();
        break;
      case 'yt/get-tags': {
        void listTags().then((tags) => sendResponse(tags));
        return true;
      }
      case 'yt/get-settings': {
        void loadSettings().then((s) =>
          sendResponse({ replaceSubscribeButton: s.replaceSubscribeButton }),
        );
        return true;
      }
      case 'yt/subscribe': {
        const { channelId, channelName, tags } = msg as {
          channelId: string;
          channelName: string;
          tags: string[];
        };
        void handleSubscribe(channelId, channelName, tags).then(() => sendResponse({ ok: true }));
        return true;
      }
      case 'cmd/probe-odysee': {
        void (async () => {
          try {
            const res = await fetch('https://lbry.tv/$/rss/@Odysee:9', { method: 'GET', redirect: 'follow' });
            if (!res.ok) {
              sendResponse({ ok: false, message: `Odysee RSS returned HTTP ${res.status}` });
              return;
            }
            const text = await res.text();
            if (text.includes('<rss') && text.includes('<channel>')) {
              sendResponse({ ok: true, message: 'Odysee RSS reachable (returned a valid feed)' });
            } else {
              sendResponse({ ok: false, message: `Odysee RSS returned unexpected content (${text.length} bytes)` });
            }
          } catch (e) {
            sendResponse({ ok: false, message: `Odysee API unreachable: ${e instanceof Error ? e.message : String(e)}` });
          }
        })();
        return true;
      }
      case 'cmd/probe-bilibili': {
        void (async () => {
          try {
            const { probeBilibiliApi } = await import('../lib/api/bilibili');
            sendResponse(await probeBilibiliApi());
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            sendResponse({ ok: false, message: `✗ Bilibili probe failed: ${msg}` });
          }
        })();
        return true;
      }
      case 'cmd/probe-peertube': {
        void (async () => {
          try {
            // Test a real channel from the user's subscriptions instead of a
            // hardcoded instance, so the probe works for any PeerTube instance.
            const channels = await listChannels();
            const ptChannels = channels.filter((c) => c.source === 'peertube');
            if (ptChannels.length === 0) {
              // No PeerTube channels — fall back to testing peertube.tv
              const res = await fetch('https://peertube.tv/api/v1/config', {
                method: 'GET',
                headers: { Accept: 'application/json' },
              });
              if (!res.ok) {
                sendResponse({ ok: false, message: `PeerTube API returned HTTP ${res.status}` });
                return;
              }
              const j = (await res.json()) as { instance?: { name?: string; version?: string } };
              const name = j?.instance?.name ?? 'unknown instance';
              const version = j?.instance?.version ? ` (PeerTube ${j.instance.version})` : '';
              sendResponse({ ok: true, message: `OK — reached ${name}${version} (default instance)` });
              return;
            }
            // Test the first PeerTube channel's instance
            const ch = ptChannels[0];
            const hostMatch = ch.id.match(/^peertube:([^@]+)/);
            const host = hostMatch?.[1];
            if (!host) {
              sendResponse({ ok: false, message: 'Could not parse PeerTube host from channel id' });
              return;
            }
            const handle = ch.urlSlug ?? ch.id.split('@')[1] ?? '';
            const acctRes = await fetch(`https://${host}/api/v1/accounts/${encodeURIComponent(handle)}`, {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            if (!acctRes.ok) {
              sendResponse({ ok: false, message: `PeerTube ${host} returned HTTP ${acctRes.status}` });
              return;
            }
            const acct = (await acctRes.json()) as { displayName?: string; name?: string };
            const displayName = acct.displayName ?? acct.name ?? handle;
            sendResponse({ ok: true, message: `OK — reached ${host} as "${displayName}" (${ptChannels.length} channel${ptChannels.length === 1 ? '' : 's'} subscribed)` });
          } catch (e) {
            sendResponse({ ok: false, message: `PeerTube API unreachable: ${e instanceof Error ? e.message : String(e)}` });
          }
        })();
        return true;
      }
      case 'cmd/probe-soundcloud': {
        void (async () => {
          try {
            const { soundcloudAdapter } = await import('../lib/api/soundcloud');
            const requiredOrigins = [
              'https://m.soundcloud.com/*',
              'https://soundcloud.com/*',
              'https://a-v2.sndcdn.com/*',
              'https://api-v2.soundcloud.com/*',
            ];
            try {
              if (browser.permissions?.contains && browser.permissions?.request) {
                const has = await browser.permissions.contains({ origins: requiredOrigins });
                if (!has) {
                  try {
                    await browser.permissions.request({ origins: requiredOrigins });
                  } catch {
                    // user denied or permissions api unavailable
                  }
                }
              }
            } catch {
              /* ignore */
            }

            console.log('[SC probe] resolveChannel...');
            const channel = await soundcloudAdapter.resolveChannel('https://soundcloud.com/osts');
            console.log('[SC probe] resolved:', channel);
            console.log('[SC probe] fetchChannel...');
            const result = await soundcloudAdapter.fetchChannel(channel.id);
            const n = result.videos.length;
            sendResponse({
              ok: true,
              message: `OK — resolved @${channel.name ?? '?'} via v2 API, got ${n} track${n === 1 ? '' : 's'}`,
            });
          } catch (e) {
            console.error('[SC probe] failed:', e);
            sendResponse({
              ok: false,
              message: `SoundCloud probe failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        })();
        return true;
      }
      default:
        break;
    }
  });

  void (async () => {
    await ensureKeepAliveAlarm();

    const status = await readStoredStatus();
    if (!status.running) {
      await ensureDnrRules();
      await ensureAlarm();
      await updateBadge();

      const settings = await loadSettings();
      if (settings.autoRefreshOnLoad) {
        void refreshAll()
          .catch(() => undefined)
          .then(async () => {
            const s = await loadSettings();
            await pruneOldVideos(s.pruneDays);
          })
          .then(() => updateBadge());
      } else {
        // No auto-refresh requested, but the previous SW might have been
        // killed mid-refresh. Try to resume from the persisted pending
        // queue (no-op if there isn't one).
        try {
          const resumed = await resumePendingRefresh();
          if (resumed) {
            void updateBadge();
          }
        } catch (e) {
          void appendLog({
            ts: Date.now(),
            level: 'error',
            channelId: null,
            channelName: null,
            source: null,
            message: `Failed to resume pending refresh: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    } else {
      // Status says a refresh is currently running. In a fresh SW
      // instance that means the previous SW was killed mid-refresh.
      // Resume from the persisted pending queue.
      void appendLog({
        ts: Date.now(),
        level: 'info',
        channelId: null,
        channelName: null,
        source: null,
        message: 'Detected in-progress refresh in fresh SW — resuming',
      });
      try {
        const resumed = await resumePendingRefresh();
        if (resumed) {
          void updateBadge();
        }
      } catch (e) {
        void appendLog({
          ts: Date.now(),
          level: 'error',
          channelId: null,
          channelName: null,
          source: null,
          message: `Failed to resume pending refresh: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  })();

  browser.runtime.onInstalled.addListener(() => {
    void ensureKeepAliveAlarm();
    void ensureDnrRules().then(() => ensureAlarm()).then(() => updateBadge());
  });

  browser.runtime.onStartup.addListener(() => {
    void ensureKeepAliveAlarm();
    void ensureDnrRules();
  });
});

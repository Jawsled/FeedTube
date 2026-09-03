import { browser } from 'wxt/browser';
import '../api/sources';
import {
  browseChannel,
  parseChannelMeta,
  parseChannelVideos,
  youtubeAdapter,
} from '../api/youtube';
import { fetchChannelRss } from '../api/rss';
import {
  invidiousChannelInfo,
  invidiousChannelLatest,
  normalizeInstance,
} from '../api/invidious';
import { ALL_SOURCE_KINDS, getSource, type SourceFetchResult, type SourceKind } from '../api/source';
import { BiliSkippedError } from '../api/bilibili';
import { getBiliBannedUntil } from '../api/bili-cookies';
import { listChannels, mergeVideos, patchChannel, type NewVideo } from '../db';
import { loadSettings } from '../settings';
import type {
  ChannelRecord,
  EngineLogEntry,
  EngineStatus,
  FetchBackend,
  ParsedVideo,
  SourceKind as EngineSourceKind,
} from '../types';
import { RateLimiter } from './rate-limiter';

const STATUS_KEY = 'engineStatus';
const LOG_KEY = 'engineLog';
const PENDING_KEY = 'enginePending';
const VIDEOS_STALE_MS = 30 * 60_000;
const TABS_STALE_MS = 12 * 3_600_000;
// If a refresh has been "running" for longer than this with no actual
// channel activity, assume the service worker was killed and the status
// is stale. Lower than the 30s SW idle window so the UI recovers quickly.
const RUNNING_TIMEOUT_MS = 90_000;
const NON_YT_STALE_MS = 30 * 60_000;
const LOG_MAX_ENTRIES = 2000;
// How many channels to process in a single tick before yielding to the
// event loop. The yield keeps the SW alive (each yield counts as activity)
// and gives `chrome.alarms` a chance to fire and reset the SW idle timer.
const TICK_BATCH = 8;

export const IDLE_STATUS: EngineStatus = {
  running: false,
  done: 0,
  total: 0,
  currentChannel: null,
  errors: [],
  startedAt: null,
  finishedAt: null,
  addedVideos: 0,
  perSource: { processed: {}, added: {}, errors: {} },
};

interface PendingRefresh {
  // Channel ids still to process (the tail of the queue).
  remaining: string[];
  // The total number of channels when the refresh started (for the UI).
  total: number;
  // Already-processed channels (kept for resumption after SW restart).
  doneIds: string[];
  force: boolean;
  startedAt: number;
  errors: string[];
  addedVideos: number;
  perSource: { processed: Record<string, number>; added: Record<string, number>; errors: Record<string, number> };
}

let aborter: AbortController | null = null;
let runPromise: Promise<EngineStatus> | null = null;
let followUpNeeded = false;
let followUpOptions: RefreshOptions = {};

function logBuffer(): EngineLogEntry[] {
  const g = globalThis as { __feedtubeLog?: EngineLogEntry[] };
  if (!g.__feedtubeLog) g.__feedtubeLog = [];
  return g.__feedtubeLog;
}

let logHydrated = false;
let logHydrationPromise: Promise<void> | null = null;

function ensureLogHydrated(): Promise<void> {
  if (logHydrated) return Promise.resolve();
  if (logHydrationPromise) return logHydrationPromise;
  logHydrationPromise = (async () => {
    try {
      const obj = await browser.storage.local.get(LOG_KEY);
      const arr = obj[LOG_KEY];
      if (Array.isArray(arr)) {
        const buf = logBuffer();
        buf.length = 0;
        buf.push(...(arr as EngineLogEntry[]));
      }
      logHydrated = true;
    } catch {
      /* best-effort */
      logHydrated = true;
    } finally {
      logHydrationPromise = null;
    }
  })();
  return logHydrationPromise;
}

let logWriteScheduled = false;

export async function flushLog(): Promise<void> {
  if (logBuffer().length === 0) return;
  try {
    await browser.storage.local.set({ [LOG_KEY]: logBuffer().slice() });
  } catch {
    /* best-effort */
  }
}

function scheduleLogWrite(): void {
  if (logWriteScheduled) return;
  logWriteScheduled = true;
  queueMicrotask(() => {
    logWriteScheduled = false;
    flushLog();
  });
}

export async function appendLog(entry: EngineLogEntry): Promise<void> {
  await ensureLogHydrated();
  const buf = logBuffer();
  buf.push(entry);
  if (buf.length > LOG_MAX_ENTRIES) buf.splice(0, buf.length - LOG_MAX_ENTRIES);
  scheduleLogWrite();
}

async function writeStatus(s: EngineStatus): Promise<void> {
  await browser.storage.local.set({ [STATUS_KEY]: s });
}

export async function readStoredStatus(): Promise<EngineStatus> {
  const obj = await browser.storage.local.get(STATUS_KEY);
  const s = obj[STATUS_KEY] as EngineStatus | undefined;
  if (!s) return { ...IDLE_STATUS };
  if (s.running && Date.now() - (s.startedAt ?? 0) > RUNNING_TIMEOUT_MS) {
    // The status claims to be running but the engine hasn't touched storage
    // in `RUNNING_TIMEOUT_MS` — the service worker was almost certainly killed.
    // Mark it not-running so the UI doesn't appear stuck forever. If the engine
    // is still actually running in another SW instance, it will overwrite this.
    void appendLog({
      ts: Date.now(),
      level: 'warn',
      channelId: null,
      channelName: null,
      source: null,
      message: `Stale refresh detected (running for >${RUNNING_TIMEOUT_MS / 1000}s with no updates). The service worker was likely killed. Will auto-resume on next startup if pending work exists.`,
    });
    return { ...s, running: false };
  }
  return s;
}

async function readPending(): Promise<PendingRefresh | null> {
  const obj = await browser.storage.local.get(PENDING_KEY);
  return (obj[PENDING_KEY] as PendingRefresh | undefined) ?? null;
}

async function writePending(p: PendingRefresh | null): Promise<void> {
  if (p == null) {
    try {
      await browser.storage.local.remove(PENDING_KEY);
    } catch {
      /* best-effort */
    }
    return;
  }
  await browser.storage.local.set({ [PENDING_KEY]: p });
}

export async function readStoredLog(): Promise<EngineLogEntry[]> {
  const obj = await browser.storage.local.get(LOG_KEY);
  const arr = obj[LOG_KEY];
  return Array.isArray(arr) ? (arr as EngineLogEntry[]) : [];
}

export async function clearStoredLog(): Promise<void> {
  logBuffer().length = 0;
  logHydrated = true;
  try {
    await browser.storage.local.remove(LOG_KEY);
  } catch {
    /* best-effort */
  }
}

export function isRefreshActive(): boolean {
  return runPromise != null;
}

function isStale(ts: number | null, staleMs: number): boolean {
  return ts == null || Date.now() - ts > staleMs;
}

const FETCH_TIMEOUT_MS = 12_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTimeout(signal: AbortSignal | undefined, ms = FETCH_TIMEOUT_MS): AbortSignal {
  const t = AbortSignal.timeout(ms);
  if (!signal) return t;
  return AbortSignal.any([signal, t]);
}

type Tab = 'videos' | 'shorts' | 'live';

function isSourceEnabledFor(
  settings: { youtubeEnabled: boolean; odyseeEnabled: boolean; bilibiliEnabled: boolean; peerTubeEnabled: boolean; soundCloudEnabled: boolean },
  src: string,
): boolean {
  switch (src) {
    case 'youtube':
      return settings.youtubeEnabled;
    case 'odysee':
      return settings.odyseeEnabled;
    case 'bilibili':
      return settings.bilibiliEnabled;
    case 'peertube':
      return settings.peerTubeEnabled;
    case 'soundcloud':
      return settings.soundCloudEnabled;
    default:
      return true;
  }
}

function tabsToFetch(
  ch: ChannelRecord,
  settings: { fetchShorts: boolean; fetchLive: boolean },
  ignoreFresh = false,
): Tab[] {
  if (ch.source !== 'youtube') {
    return isStale(ch.lastFetchedAt, NON_YT_STALE_MS) || ignoreFresh ? ['videos'] : [];
  }
  const tabs: Tab[] = [];
  if (ignoreFresh || isStale(ch.lastVideosFetchedAt, VIDEOS_STALE_MS)) tabs.push('videos');
  if (settings.fetchShorts && (ignoreFresh || isStale(ch.lastShortsFetchedAt, TABS_STALE_MS)))
    tabs.push('shorts');
  if (settings.fetchLive && (ignoreFresh || isStale(ch.lastLiveFetchedAt, TABS_STALE_MS)))
    tabs.push('live');
  return tabs;
}

interface FetchOutcome {
  videos: ParsedVideo[];
  backend: FetchBackend;
  fetchedTabs: Tab[];
  name: string | null;
  avatarUrl: string | null;
  detail?: string;
}

async function fetchNative(
  ch: ChannelRecord,
  settings: { fetchShorts: boolean; fetchLive: boolean },
  force: boolean,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  const tabs = tabsToFetch(ch, settings, force);
  if (tabs.length === 0) throw new Error('up-to-date');

  const results: Partial<Record<Tab, unknown>> = {};
  const failedTabs: string[] = [];

  await Promise.all(
    tabs.map(async (tab) => {
      try {
        const json =
          tab === 'live' ? await browseChannel(ch.id, 'streams', withTimeout(signal)) : await browseChannel(ch.id, tab, withTimeout(signal));
        results[tab] = json;
      } catch {
        failedTabs.push(tab);
      }
    }),
  );

  const collectedTabs = tabs.filter((t) => results[t] != null);
  if (collectedTabs.length === 0) {
    throw new Error(
      failedTabs.length > 0 ? `YouTube API failed (${failedTabs.join(', ')})` : 'YouTube API failed',
    );
  }

  const videos: ParsedVideo[] = [];
  for (const t of collectedTabs) videos.push(...parseChannelVideos(results[t]!));
  const meta = parseChannelMeta(results[collectedTabs[0]]);

  return {
    videos,
    backend: 'native',
    fetchedTabs: collectedTabs,
    name: meta.name,
    avatarUrl: meta.avatarUrl,
  };
}

async function fetchInvidiousBackend(
  ch: ChannelRecord,
  base: string,
  needMeta: boolean,
  signal?: AbortSignal,
): Promise<FetchOutcome> {
  const sig = withTimeout(signal);
  const videos = await invidiousChannelLatest(base, ch.id, sig);
  let name = ch.name !== ch.id ? ch.name : null;
  let avatarUrl = ch.avatarUrl;
  if ((needMeta || !name) && videos.length >= 0) {
    try {
      const info = await invidiousChannelInfo(base, ch.id, sig);
      name = info.name;
      avatarUrl = info.avatarUrl ?? avatarUrl;
    } catch (e) {
      if (!name && videos.length === 0) throw e;
    }
  }
  return { videos, backend: 'invidious', fetchedTabs: ['videos'], name, avatarUrl };
}

async function fetchRssBackend(ch: ChannelRecord, signal?: AbortSignal): Promise<FetchOutcome> {
  const res = await fetchChannelRss(ch.id, withTimeout(signal));
  return {
    videos: res.videos,
    backend: 'rss',
    fetchedTabs: ['videos'],
    name: res.name ?? (ch.name !== ch.id ? ch.name : null),
    avatarUrl: ch.avatarUrl,
  };
}

function fromAdapterResult(r: SourceFetchResult): FetchOutcome {
  // YouTube never uses the generic adapter path (it has dedicated fetchNative/
  // fetchInvidiousBackend/fetchRssBackend), so the only SourceKinds we get here
  // are the non-YouTube ones — all of which are valid FetchBackend values.
  const backend = r.kind as FetchBackend;
  return {
    videos: r.videos,
    backend,
    fetchedTabs: ['videos'],
    name: r.name,
    avatarUrl: r.avatarUrl,
    detail: r.backendDetail,
  };
}

async function fetchOtherSource(
  ch: ChannelRecord,
  limiter: RateLimiter,
  signal?: AbortSignal,
  hint?: { name?: string | null; avatarUrl?: string | null; urlSlug?: string | null; limit?: number },
): Promise<FetchOutcome> {
  // Per-source enable checks are handled in refreshOne (and at the
  // buildPendingList stage), so by the time we get here the channel
  // is known to be enabled.
  const adapter = getSource(ch.source);
  const result = await limiter.run(() => adapter.fetchChannel(ch.id, withTimeout(signal), hint));
  return fromAdapterResult(result);
}

function bumpSource(
  status: EngineStatus,
  source: string,
  key: 'processed' | 'added' | 'errors',
  by = 1,
): void {
  if (!status.perSource) return;
  status.perSource[key][source] = (status.perSource[key][source] ?? 0) + by;
}

async function refreshOne(
  ch: ChannelRecord,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  limiter: RateLimiter,
  status: EngineStatus,
  force: boolean,
  signal: AbortSignal,
): Promise<void> {
  status.currentChannel = ch.name || ch.id;
  const needMeta = ch.name === ch.id || !ch.avatarUrl;
  let outcome: FetchOutcome | null = null;
  let lastError: unknown = null;
  let backendUsed: FetchBackend | null = null;
  let attempts = 0;

  const log = (level: EngineLogEntry['level'], message: string) => {
    void appendLog({
      ts: Date.now(),
      level,
      channelId: ch.id,
      channelName: ch.name,
      source: ch.source,
      message,
    });
  };

  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      log('info', 'Refresh stopped, skipping');
      status.currentChannel = null;
      return;
    }
    attempts = attempt;
    log('info', `Starting ${ch.source} fetch (${ch.id})${attempt > 1 ? ` — retry ${attempt}/${MAX_ATTEMPTS}` : ''}`);

    if (ch.source === 'youtube') {
      if (!settings.useRssOnly) {
        try {
          outcome = await fetchNative(ch, settings, force, signal);
          backendUsed = 'native';
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            log('info', 'Refresh stopped, skipping');
            status.currentChannel = null;
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          lastError = e;
          if (e instanceof Error && e.message === 'up-to-date') {
            log('info', 'Cache is up to date, skipping');
            outcome = { videos: [], backend: 'native', fetchedTabs: [], name: ch.name, avatarUrl: ch.avatarUrl };
            backendUsed = 'native';
          } else {
            log('warn', `YouTube native API failed: ${msg}`);
            if (settings.invidiousEnabled) {
              try {
                outcome = await limiter.run(() =>
                  fetchInvidiousBackend(ch, normalizeInstance(settings.invidiousInstance), needMeta, signal),
                );
                backendUsed = 'invidious';
              } catch (e2) {
                if (e2 instanceof DOMException && e2.name === 'AbortError') {
                  log('info', 'Refresh stopped, skipping');
                  status.currentChannel = null;
                  return;
                }
                const msg2 = e2 instanceof Error ? e2.message : String(e2);
                lastError = e2;
                log('warn', `Invidious fallback failed: ${msg2}`);
              }
            }
          }
        }
      }
      if (!outcome) {
        try {
          outcome = await fetchRssBackend(ch, signal);
          backendUsed = 'rss';
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            log('info', 'Refresh stopped, skipping');
            status.currentChannel = null;
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          lastError = e;
          log('error', `RSS fallback failed: ${msg}`);
        }
      }
    } else {
      // For bilibili, respect the global WBI cooldown so we don't repeatedly
      // hammer a banned IP/UA pair. `force` (per-channel "Refresh now" / force-flag)
      // bypasses the cooldown — the user explicitly asked for it.
      if (ch.source === 'bilibili' && !force) {
        const bannedUntil = await getBiliBannedUntil();
        if (bannedUntil) {
          log(
            'info',
            `Skipping ${ch.name} — Bilibili WBI backed off until ${new Date(bannedUntil).toLocaleTimeString()}`,
          );
          status.done++;
          status.currentChannel = null;
          return;
        }
      }
      try {
        const hint: { name?: string | null; avatarUrl?: string | null; urlSlug?: string | null; force?: boolean; limit?: number } = {
          name: needMeta ? null : ch.name,
          avatarUrl: ch.avatarUrl,
          force,
          limit: settings.feedFetchLimit,
        };
        if (ch.source === 'odysee' && ch.urlSlug) hint.urlSlug = ch.urlSlug;
        if ((ch.source === 'peertube' || ch.source === 'soundcloud') && ch.urlSlug) hint.urlSlug = ch.urlSlug;
        outcome = await fetchOtherSource(
          ch,
          limiter,
          signal,
          hint,
        );
        backendUsed = outcome.backend;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          log('info', 'Refresh stopped, skipping');
          status.currentChannel = null;
          return;
        }
        if (e instanceof BiliSkippedError) {
          log('info', `Skipping ${ch.name} — ${e.message}`);
          status.done++;
          status.currentChannel = null;
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        lastError = e;
        log('error', `${ch.source} fetch failed: ${msg}`);
      }
    }

    if (!outcome) {
      if (attempt < MAX_ATTEMPTS && !signal.aborted) {
        const msg = lastError instanceof Error ? lastError.message : String(lastError);
        log('warn', `${ch.source} fetch failed (${msg}), retrying in a moment`);
        await sleep(1200);
      } else {
        break;
      }
    } else {
      if (outcome.videos.length === 0 && outcome.fetchedTabs.length === 0) {
        log('info', `${ch.source} ${ch.name} fetch returned no videos`);
      }
      break;
    }
  }

  if (!outcome) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    log('error', `✗ ${ch.source} ${ch.name} — ${msg} (skipped, will retry next refresh)`);
    await patchChannel(ch.id, { lastError: msg });
    status.errors.push(`${ch.name || ch.id}: ${msg}`);
    bumpSource(status, ch.source, 'errors');
    status.done++;
    status.currentChannel = null;
    return;
  }

  const empty = outcome.videos.length === 0 && outcome.fetchedTabs.length === 0;
  if (empty) {
    log('warn', `Skipped ${ch.source} ${ch.name} — no videos after ${attempts} attempt${attempts === 1 ? '' : 's'}`);
    await patchChannel(ch.id, { lastError: 'No videos returned' });
    status.done++;
    status.currentChannel = null;
    return;
  }

  const fetchedAt = Date.now();
  const source: EngineSourceKind = ch.source;
  const newVideos: NewVideo[] = outcome.videos.map((v) => ({
    id: v.id,
    source,
    channelId: ch.id,
    title: v.title,
    publishedAt: v.publishedAt,
    approxDate: v.approxDate,
    thumbnailUrl: v.thumbnailUrl,
    durationSeconds: v.durationSeconds,
    viewCount: v.viewCount,
    kind: v.kind,
    backend: outcome!.backend,
    fetchedAt,
  }));
  const added = await mergeVideos(newVideos);
  status.addedVideos += added;
  bumpSource(status, ch.source, 'processed');
  bumpSource(status, ch.source, 'added', added);
  log('info', `✓ Got ${outcome.videos.length} video${outcome.videos.length === 1 ? '' : 's'} via ${backendUsed ?? 'unknown'}${outcome.detail ? ` (${outcome.detail})` : ''} (added ${added} new)`);

  const patch: Partial<ChannelRecord> = { lastFetchedAt: fetchedAt, lastError: null };
  if (ch.source === 'odysee' && ch.urlSlug) patch.urlSlug = ch.urlSlug;
  if ((ch.source === 'peertube' || ch.source === 'soundcloud') && ch.urlSlug) patch.urlSlug = ch.urlSlug;
  if (outcome.name) patch.name = outcome.name;
  if (outcome.avatarUrl) patch.avatarUrl = outcome.avatarUrl;
  for (const tab of outcome.fetchedTabs) {
    if (tab === 'videos') patch.lastVideosFetchedAt = fetchedAt;
    else if (tab === 'shorts') patch.lastShortsFetchedAt = fetchedAt;
    else if (tab === 'live') patch.lastLiveFetchedAt = fetchedAt;
  }
  await patchChannel(ch.id, patch);

  status.done++;
  status.currentChannel = null;
}

/**
 * Build the ordered pending channel list for a refresh. Applies the same
 * bili-ban pre-filter and bilibili-last reordering as before.
 */
async function buildPendingList(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  options: RefreshOptions,
): Promise<ChannelRecord[]> {
  const allChannels = await listChannels();
  let candidates = allChannels;
  if (options.channelIds && options.channelIds.length > 0) {
    const ids = new Set(options.channelIds);
    candidates = candidates.filter((ch) => ids.has(ch.id));
  } else if (options.tags && options.tags.length > 0) {
    candidates = candidates.filter((ch) => ch.tags.some((t) => options.tags!.includes(t)));
  }

        // Filter out channels whose source is disabled in settings.
        const beforeSourceFilter = candidates.length;
        candidates = candidates.filter((ch) => isSourceEnabledFor(settings, ch.source));
        const droppedBySource = beforeSourceFilter - candidates.length;
        // Log a per-source breakdown of enabled/disabled counts so the user
        // can see exactly what the engine thinks is enabled. This is the
        // single source of truth that the refresh will honor.
        const enabledSummary = ALL_SOURCE_KINDS.map((k) => {
          const enabled = isSourceEnabledFor(settings, k);
          const allForSrc = allChannels.filter((c) => c.source === k).length;
          return `${k}=${enabled ? 'on' : 'off'}(${allForSrc})`;
        }).join(', ');
        void appendLog({
          ts: Date.now(),
          level: 'info',
          channelId: null,
          channelName: null,
          source: null,
          message: `Source toggles: ${enabledSummary}`,
        });
        if (droppedBySource > 0) {
          // Build a per-source count of what was dropped, so the log makes
          // it clear which platforms are being skipped because of settings.
          const droppedByPlatform: Partial<Record<SourceKind, number>> = {};
          for (const ch of allChannels) {
            if (!isSourceEnabledFor(settings, ch.source)) {
              droppedByPlatform[ch.source] = (droppedByPlatform[ch.source] ?? 0) + 1;
            }
          }
          const parts = (Object.entries(droppedByPlatform) as [SourceKind, number][])
            .filter(([, n]) => n > 0)
            .map(([src, n]) => `${src}=${n}`)
            .join(', ');
          void appendLog({
            ts: Date.now(),
            level: 'info',
            channelId: null,
            channelName: null,
            source: null,
            message: `Skipped ${droppedBySource} channel${droppedBySource === 1 ? '' : 's'} (source disabled): ${parts}`,
          });
        }

  const force = options.force ?? false;
  const biliBannedUntil: number = force ? 0 : ((await getBiliBannedUntil()) ?? 0);
  const biliSkipped: ChannelRecord[] = [];
  const biliEligible =
    biliBannedUntil > 0
      ? candidates.filter((ch) => {
          if (ch.source !== 'bilibili') return true;
          biliSkipped.push(ch);
          return false;
        })
      : candidates;

  if (biliSkipped.length > 0) {
    void appendLog({
      ts: Date.now(),
      level: 'info',
      channelId: null,
      channelName: null,
      source: 'bilibili',
      message: `Skipping ${biliSkipped.length} bilibili channel${biliSkipped.length === 1 ? '' : 's'} (WBI backed off until ${new Date(biliBannedUntil).toLocaleTimeString()})`,
    });
  }

  const biliLast = biliEligible.filter((ch) => ch.source === 'bilibili');
  const nonBili = biliEligible.filter((ch) => ch.source !== 'bilibili');
  const ordered = [...nonBili, ...biliLast];

  return force
    ? ordered
    : ordered.filter((ch) => tabsToFetch(ch, settings).length > 0);
}

/**
 * Resume a previously-paused refresh. Called on service worker startup.
 * Returns the new run promise if there was work to do, otherwise null.
 */
export function resumePendingRefresh(): Promise<EngineStatus | null> {
  return (async () => {
    const pending = await readPending();
    if (!pending || pending.remaining.length === 0) {
      await writePending(null);
      return null;
    }
    void appendLog({
      ts: Date.now(),
      level: 'info',
      channelId: null,
      channelName: null,
      source: null,
      message: `Resuming previous refresh — ${pending.remaining.length} channel${pending.remaining.length === 1 ? '' : 's'} remaining (of ${pending.total})`,
    });
    return runRefresh(pending);
  })();
}

// Strip out channels whose source is currently disabled in settings.
// Returns the new remaining list and the count of removed channels.
function filterPendingByEnabled(
  pending: PendingRefresh,
  channelById: Map<string, ChannelRecord>,
  settings: { youtubeEnabled: boolean; odyseeEnabled: boolean; bilibiliEnabled: boolean; peerTubeEnabled: boolean; soundCloudEnabled: boolean },
): { remaining: string[]; removed: number } {
  const remaining: string[] = [];
  let removed = 0;
  for (const id of pending.remaining) {
    const ch = channelById.get(id);
    if (!ch) {
      removed++;
      continue;
    }
    if (!isSourceEnabledFor(settings, ch.source)) {
      removed++;
      continue;
    }
    remaining.push(id);
  }
  return { remaining, removed };
}

export interface RefreshOptions {
  force?: boolean;
  tags?: string[];
  channelIds?: string[];
}

/**
 * Public entry: start (or queue) a refresh.
 * If a refresh is already in progress, the new options are queued via
 * `followUpNeeded` so the running refresh picks them up at the end.
 */
export async function refreshAll(options: RefreshOptions = {}): Promise<EngineStatus> {
  if (runPromise) {
    followUpNeeded = true;
    followUpOptions = { ...followUpOptions, ...options };
    return runPromise;
  }
  const settings = await loadSettings();
  const ordered = await buildPendingList(settings, options);
  const total = ordered.length;
  const startedAt = Date.now();
  const status: EngineStatus = {
    running: true,
    done: 0,
    total,
    currentChannel: null,
    errors: [],
    startedAt,
    finishedAt: null,
    addedVideos: 0,
    perSource: { processed: {}, added: {}, errors: {} },
  };
  await writeStatus({ ...status });
  const pending: PendingRefresh = {
    remaining: ordered.map((c) => c.id),
    total,
    doneIds: [],
    force: options.force ?? false,
    startedAt,
    errors: [],
    addedVideos: 0,
    perSource: { processed: {}, added: {}, errors: {} },
  };
  await writePending(pending);
  return runRefresh(pending);
}

async function runRefresh(
  initialPending: PendingRefresh,
): Promise<EngineStatus> {
  // Guard against double-start (e.g. resume + a click arriving in the same
  // tick). If a refresh is already in progress, queue as a follow-up.
  if (runPromise) {
    followUpNeeded = true;
    return runPromise;
  }
  const controller = new AbortController();
  aborter = controller;

  const status: EngineStatus = {
    running: true,
    done: initialPending.total - initialPending.remaining.length,
    total: initialPending.total,
    currentChannel: null,
    errors: initialPending.errors.slice(),
    startedAt: initialPending.startedAt,
    finishedAt: null,
    addedVideos: initialPending.addedVideos,
    perSource: {
      processed: { ...initialPending.perSource.processed },
      added: { ...initialPending.perSource.added },
      errors: { ...initialPending.perSource.errors },
    },
  };

  await writeStatus({ ...status });

  runPromise = (async () => {
    let pending: PendingRefresh = initialPending;
    let isFirstPass = true;
    try {
      do {
        followUpNeeded = false;
        const localOptions = followUpOptions;
        followUpOptions = {};
        if (!isFirstPass) {
          // We only re-derive the pending list if a follow-up refresh was
          // requested (someone called refreshAll while we were running). A
          // resume after SW kill reuses the existing pending state.
          const settings = await loadSettings();
          const ordered = await buildPendingList(settings, localOptions);
          pending = {
            remaining: ordered.map((c) => c.id),
            total: ordered.length,
            doneIds: [],
            force: localOptions.force ?? false,
            startedAt: Date.now(),
            errors: [],
            addedVideos: 0,
            perSource: { processed: {}, added: {}, errors: {} },
          };
          status.errors = [];
          status.addedVideos = 0;
          status.done = 0;
          status.total = ordered.length;
          status.currentChannel = null;
          status.startedAt = pending.startedAt;
          status.finishedAt = null;
          status.perSource = { processed: {}, added: {}, errors: {} };
          await writeStatus({ ...status });
        }

        const allChannels = await listChannels();
        const channelById = new Map(allChannels.map((c) => [c.id, c]));

        // Re-read settings on every pass so the source filter (and any
        // other toggle) reflects what the user has set right now — not
        // what was set when the refresh started. We pass the live settings
        // to refreshOne and to the in-batch guard so a source disabled
        // after the refresh began is honored.
        let settings = await loadSettings();

        // When resuming from a previously-persisted queue, strip out any
        // channels whose source has been disabled since the queue was built.
        // The remaining "doneIds" + "total" stay the same so the progress
        // fraction is still meaningful, but the removed channels are logged
        // as skipped.
        if (isFirstPass) {
          const { remaining, removed } = filterPendingByEnabled(pending, channelById, settings);
          if (removed > 0) {
            void appendLog({
              ts: Date.now(),
              level: 'info',
              channelId: null,
              channelName: null,
              source: null,
              message: `Dropped ${removed} channel${removed === 1 ? '' : 's'} from the resumed queue (source disabled)`,
            });
            pending.remaining = remaining;
            status.total = remaining.length;
            await writePending(pending);
            await writeStatus({ ...status });
          }
        }
        isFirstPass = false;

        // Re-verify the source enable state on every pass. The queue may
        // have been built (or persisted) before the user toggled a source
        // off, and we never want to fetch a disabled source even if its
        // id is already in the queue.

        void appendLog({
          ts: Date.now(),
          level: 'info',
          channelId: null,
          channelName: null,
          source: null,
          message: `Refresh started: ${pending.total} channel${pending.total === 1 ? '' : 's'} to fetch`,
        });

        if (pending.remaining.length > 0) {
          const concurrency = Math.min(4, Math.max(2, Math.ceil(pending.total / 25)));
          const limiter = new RateLimiter(concurrency, 300, 250, controller.signal);

          // Process the queue in batches. After each batch we yield to the
          // event loop (resets the SW idle timer) and persist the pending
          // state to storage (so a SW kill can resume from this exact spot).
          while (pending.remaining.length > 0 && !controller.signal.aborted) {
            // Re-read settings on every batch so a user toggling a source
            // off mid-refresh is picked up immediately. settings.youtubeEnabled
            // is cheap (one storage read) compared to the network calls in
            // the batch below, and being stale here would cause us to fetch
            // channels the user has just disabled.
            settings = await loadSettings();
            const batchIds = pending.remaining.splice(0, TICK_BATCH);
            await Promise.all(
              batchIds.map(async (id) => {
                const ch = channelById.get(id);
                if (!ch) {
                  // Channel was removed while we were queued — skip silently.
                  status.done++;
                  pending.doneIds.push(id);
                  return;
                }
                // Final guard: skip channels whose source was disabled
                // after the queue was built (or after a SW resume).
                if (!isSourceEnabledFor(settings, ch.source)) {
                  void appendLog({
                    ts: Date.now(),
                    level: 'info',
                    channelId: ch.id,
                    channelName: ch.name,
                    source: ch.source,
                    message: `Skipped — ${ch.source} is disabled in settings`,
                  });
                  status.done++;
                  pending.doneIds.push(id);
                  return;
                }
                const t0 = Date.now();
                try {
                  await refreshOne(ch, settings, limiter, status, pending.force, controller.signal);
                } catch (e) {
                  if (controller.signal.aborted) {
                    // Push the unprocessed channels back onto the front so a
                    // resume picks them up.
                    pending.remaining.unshift(id);
                    throw e;
                  }
                  // refreshOne already logged the error and bumped counters
                  // internally; the only path that lands here is a programming
                  // error or an unhandled escape. Surface it for the log.
                  const msg = e instanceof Error ? e.message : String(e);
                  void appendLog({
                    ts: Date.now(),
                    level: 'error',
                    channelId: ch.id,
                    channelName: ch.name,
                    source: ch.source,
                    message: `Unhandled: ${msg}`,
                  });
                } finally {
                  pending.doneIds.push(id);
                }
                const ms = Date.now() - t0;
                if (ms > 15_000) {
                  void appendLog({
                    ts: Date.now(),
                    level: 'warn',
                    channelId: ch.id,
                    channelName: ch.name,
                    source: ch.source,
                    message: `Slow channel: took ${(ms / 1000).toFixed(1)}s`,
                  });
                }
              }),
            );
            // Persist the new pending tail so a SW kill can resume.
            pending.errors = status.errors;
            pending.addedVideos = status.addedVideos;
            pending.perSource = {
              processed: { ...status.perSource!.processed },
              added: { ...status.perSource!.added },
              errors: { ...status.perSource!.errors },
            };
            await writePending(pending);
            await writeStatus({ ...status });
            // Yield to the event loop — this counts as activity and prevents
            // the SW from being killed mid-batch on the next idle window.
            if (pending.remaining.length > 0) {
              await new Promise<void>((r) => setTimeout(r, 0));
            }
          }
        }
      } while (followUpNeeded && !controller.signal.aborted);

      status.running = false;
      status.finishedAt = Date.now();
      status.currentChannel = null;
      await writeStatus({ ...status });
      await writePending(null);

      const ps = status.perSource ?? { processed: {}, added: {}, errors: {} };
      const summaryLines = ALL_SOURCE_KINDS
        .filter((k) => (ps.processed[k] ?? 0) > 0 || (ps.errors[k] ?? 0) > 0)
        .map((k) => {
          const processed = ps.processed[k] ?? 0;
          const errors = ps.errors[k] ?? 0;
          const added = ps.added[k] ?? 0;
          const errPart = errors > 0 ? `, ${errors} error${errors === 1 ? '' : 's'}` : '';
          return `${k}: ${processed} fetched, ${added} new${errPart}`;
        });
      const summaryMsg = `Refresh finished: ${status.done} channels processed, ${status.addedVideos} new videos, ${status.errors.length} errors${
        summaryLines.length > 0 ? ' (' + summaryLines.join('; ') + ')' : ''
      }.`;

      void appendLog({
        ts: Date.now(),
        level: status.errors.length > 0 ? 'warn' : 'info',
        channelId: null,
        channelName: null,
        source: null,
        message: summaryMsg,
      });
      await flushLog();
      return { ...status };
    } catch (e) {
      // If we were aborted, persist the current pending tail so a resume
      // can pick up where we left off.
      try {
        pending.errors = status.errors;
        pending.addedVideos = status.addedVideos;
        pending.perSource = {
          processed: { ...status.perSource!.processed },
          added: { ...status.perSource!.added },
          errors: { ...status.perSource!.errors },
        };
        await writePending(pending);
      } catch {
        /* best-effort */
      }
      throw e;
    } finally {
      aborter = null;
      runPromise = null;
      followUpNeeded = false;
    }
  })();

  return runPromise;
}

export async function cancelRefresh(): Promise<void> {
  aborter?.abort();
  // Also clear any persisted pending state so the next start is clean.
  try {
    await writePending(null);
  } catch {
    /* best-effort */
  }
}

void youtubeAdapter;

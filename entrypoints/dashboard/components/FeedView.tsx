import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { listChannels, listTags, listVideos, setSeen } from '../../../lib/db';
import { loadSettings } from '../../../lib/settings';
import { readStoredLog, readStoredStatus, clearStoredLog } from '../../../lib/core/feed-engine';
import type { EngineLogEntry, EngineStatus, TagDefinition } from '../../../lib/types';
import { ALL_SOURCE_KINDS, SOURCE_META, type SourceKind } from '../../../lib/api/source';
import { Icons } from './ui';
import { EmptyState, Icon, useAsync } from './ui';
import { VideoCard } from './VideoCard';

type Filter = 'all' | 'video' | 'short' | 'live';

const PAGE = 60;

function LogDialog({
  open,
  log,
  sourceFilter,
  onSourceFilterChange,
  onClose,
  onClear,
  scrollRef,
}: {
  open: boolean;
  log: EngineLogEntry[];
  sourceFilter: 'all' | SourceKind | '_engine';
  onSourceFilterChange: (s: 'all' | SourceKind | '_engine') => void;
  onClose: () => void;
  onClear: () => void;
  scrollRef: { current: HTMLDivElement | null };
}) {
  if (!open) return null;
  const visible = log.filter((e) => {
    if (sourceFilter === 'all') return true;
    if (sourceFilter === '_engine') return e.source === null;
    return e.source === sourceFilter;
  });
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        class="card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(900px, 100%)',
          maxHeight: 'min(80vh, 720px)',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>Engine activity log</strong>
          <span
            class="faint"
            style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', minWidth: 110 }}
          >
            Last {log.length} events
          </span>
          <span class="faint" style={{ fontSize: 11 }}>Show:</span>
          <div
            role="group"
            aria-label="Source filter"
            style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
          >
            {(
              [
                { key: 'all' as const, label: 'All', color: undefined, title: 'All sources' },
                {
                  key: '_engine' as const,
                  label: 'Engine',
                  color: undefined,
                  title: 'Engine-wide events only',
                },
                ...ALL_SOURCE_KINDS.map((s) => ({
                  key: s,
                  label: SOURCE_META[s].shortLabel,
                  color: SOURCE_META[s].color,
                  title: SOURCE_META[s].label,
                })),
              ]
            ).map((opt) => {
              const active = sourceFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => onSourceFilterChange(opt.key)}
                  title={opt.title}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.3,
                    padding: '3px 8px',
                    borderRadius: 999,
                    cursor: 'pointer',
                    background: active
                      ? opt.color
                        ? `${opt.color}33`
                        : 'var(--accent-soft)'
                      : 'transparent',
                    color: active && opt.color ? opt.color : 'var(--text-dim)',
                    border: `1px solid ${active ? (opt.color ?? 'var(--accent)') : 'var(--border)'}`,
                    textTransform: 'uppercase',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div style={{ flex: 1 }} />
          <button
            class="btn small"
            onClick={onClear}
            title="Clear log"
            style={{ visibility: log.length > 0 ? 'visible' : 'hidden' }}
          >
            Clear
          </button>
          <button
            class="icon-btn"
            title="Close log"
            onClick={onClose}
            style={{ width: 24, height: 24 }}
          >
            <Icon path={Icons.x} size={14} />
          </button>
        </div>
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 240,
            overflowY: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11.5,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {log.length === 0 ? (
            <div class="faint" style={{ padding: 8 }}>
              No log entries yet. Trigger a refresh and events will appear here.
            </div>
          ) : visible.length === 0 ? (
            <div class="faint" style={{ padding: 8 }}>
              {sourceFilter === 'all'
                ? 'No entries match the current level filter.'
                : `No ${sourceFilter === '_engine' ? 'engine-wide' : sourceFilter} entries in the log.`}
            </div>
          ) : (
            visible.map((e, i) => <LogRow key={`${e.ts}-${i}`} entry={e} />)
          )}
        </div>
      </div>
    </div>
  );
}

const LEVEL_COLORS = {
  info: '#4ade80', // green
  warn: '#fbbf24', // yellow
  error: '#f87171', // red
} as const;

const LEVEL_LABELS = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
} as const;

function LogRow({ entry }: { entry: EngineLogEntry }) {
  const levelColor = LEVEL_COLORS[entry.level];
  const sourceMeta = entry.source ? SOURCE_META[entry.source] : null;
  // Row layout: time | dot | LEVEL | source | message
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '76px 10px 50px 50px 1fr',
        gap: 8,
        alignItems: 'baseline',
        padding: '3px 6px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        borderRadius: 3,
      }}
    >
      <span
        class="faint"
        style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}
      >
        {new Date(entry.ts).toLocaleTimeString()}
      </span>
      <span
        title={entry.level}
        aria-label={entry.level}
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: levelColor,
          display: 'inline-block',
          justifySelf: 'center',
          alignSelf: 'center',
          boxShadow: `0 0 4px ${levelColor}66`,
        }}
      />
      <span
        style={{
          color: levelColor,
          fontWeight: 700,
          fontSize: 10,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {LEVEL_LABELS[entry.level]}
      </span>
      {sourceMeta ? (
        <span
          title={sourceMeta.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9.5,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            padding: '1px 5px',
            borderRadius: 3,
            background: `${sourceMeta.color}22`,
            color: sourceMeta.color,
            lineHeight: '14px',
          }}
        >
          {sourceMeta.shortLabel}
        </span>
      ) : (
        <span
          title="Engine-wide event"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 9.5,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
            padding: '1px 5px',
            borderRadius: 3,
            background: 'var(--bg-hover)',
            color: 'var(--text-dim)',
            lineHeight: '14px',
          }}
        >
          —
        </span>
      )}
      <span style={{ color: 'var(--text)', minWidth: 0 }}>
        {entry.channelName ? (
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{entry.channelName}</span>
        ) : null}
        {entry.channelName ? ' — ' : ''}
        <span style={{ color: 'var(--text-dim)' }}>{entry.message}</span>
      </span>
    </div>
  );
}

export function FeedView({ onGoToSubs }: { onGoToSubs: () => void }) {
  const feed = useAsync(
    async () => {
      const [videos, channels, settings, tags] = await Promise.all([
        listVideos(),
        listChannels(),
        loadSettings(),
        listTags(),
      ]);
      const nameById = new Map(channels.map((c) => [c.id, c.name]));
      const channelById = new Map(channels.map((c) => [c.id, c]));
      videos.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
      return { videos, nameById, channelById, settings, tags };
    },
    [],
  );

  const [filter, setFilter] = useState<Filter>('video');
  const [hideSeen, setHideSeen] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(PAGE);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string | null>(null);

  const pickTag = (tag: string | null) => {
    setTagFilter(tag);
  };

  const clearChannelFilter = () => {
    setChannelFilter(null);
    const base = location.hash.split('?')[0];
    location.hash = base || '#/feed';
  };

  const refreshChannel = () => {
    if (!channelFilter || refreshing) return;
    void browser.runtime.sendMessage({
      type: 'cmd/start-refresh',
      channelIds: [channelFilter],
      force: true,
    });
  };

  useEffect(() => {
    const readChannel = () => {
      const q = location.hash.split('?')[1];
      if (!q) {
        setChannelFilter(null);
        return;
      }
      const params = new URLSearchParams(q);
      setChannelFilter(params.get('channel'));
    };
    readChannel();
    addEventListener('hashchange', readChannel);
    return () => removeEventListener('hashchange', readChannel);
  }, []);

  useEffect(() => {
    if (feed.data && hideSeen == null) setHideSeen(feed.data.settings.hideSeenByDefault);
  }, [feed.data]);

  useEffect(() => {
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'engineStatus' in changes) {
        const status = changes.engineStatus as { newValue?: { running?: boolean; finishedAt?: number | null } };
        if (status?.newValue && !status.newValue.running && status.newValue.finishedAt != null) {
          feed.reload();
        }
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    readStoredStatus().then((s) => {
      if (!s.running && s.finishedAt != null) feed.reload();
    });
  }, []);

  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [log, setLog] = useState<EngineLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  // Lives in the parent (not the dialog) so the selection persists across
  // dialog open/close, and so the dialog re-renders cleanly whenever the
  // log itself updates.
  const [logSourceFilter, setLogSourceFilter] = useState<
    'all' | SourceKind | '_engine'
  >('all');
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const read = () => void readStoredStatus().then(setStatus);
    read();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'engineStatus' in changes) read();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    void readStoredLog().then(setLog);
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && 'engineLog' in changes) {
        const next = (changes.engineLog as { newValue?: EngineLogEntry[] }).newValue;
        setLog(Array.isArray(next) ? next : []);
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    const pollId = setInterval(() => {
      void readStoredLog().then((next) => {
        setLog((prev) => {
          if (prev.length !== next.length || prev[prev.length - 1]?.ts !== next[next.length - 1]?.ts) {
            return next;
          }
          return prev;
        });
      });
    }, 1000);
    return () => {
      browser.storage.onChanged.removeListener(onChanged);
      clearInterval(pollId);
    };
  }, []);

  const clearLog = () => {
    setLog([]);
    void clearStoredLog();
    void browser.runtime.sendMessage({ type: 'cmd/clear-log' });
  };

  const cancelRefresh = () => {
    void browser.runtime.sendMessage({ type: 'cmd/cancel-refresh' });
  };

  useEffect(() => {
    if (!logOpen) return;
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, logOpen]);

  const refreshing = status?.running ?? false;

  const startRefresh = () => {
    void browser.runtime.sendMessage(
      tagFilter
        ? { type: 'cmd/start-refresh', tags: [tagFilter], force: true }
        : { type: 'cmd/start-refresh', force: true },
    );
  };

  const filtered = useMemo(() => {
    const d = feed.data;
    if (!d) return [];
    let items = d.videos;
    if (hideSeen) items = items.filter((v) => !v.seen);
    if (filter === 'video') {
      items = items.filter((v) => v.kind !== 'short' && v.kind !== 'live');
    } else if (filter === 'short' && d.settings.fetchShorts) {
      items = items.filter((v) => v.kind === 'short');
    } else if (filter === 'live' && d.settings.fetchLive) {
      items = items.filter((v) => v.kind === 'live');
    }
    if (tagFilter) {
      const channelIdsWithTag = new Set(
        d.channelById.entries()
          .filter(([, ch]) => ch.tags.includes(tagFilter))
          .map(([id]) => id),
      );
      items = items.filter((v) => channelIdsWithTag.has(v.channelId));
    }
    if (channelFilter) {
      items = items.filter((v) => v.channelId === channelFilter);
    }
    const q = query.trim().toLowerCase();
    if (q) {
      items = items.filter(
        (v) =>
          v.title.toLowerCase().includes(q) ||
          (d.nameById.get(v.channelId) ?? '').toLowerCase().includes(q),
      );
    }
    return items;
  }, [feed.data, filter, hideSeen, query, tagFilter, channelFilter]);

  const toggleSeen = (id: string, seen: boolean) => {
    void setSeen([id], seen);
    void browser.runtime.sendMessage({ type: 'cmd/update-badge' });
    feed.setData((d) =>
      d
        ? {
            ...d,
            videos: d.videos.map((v) => (v.id === id ? { ...v, seen, seenAt: seen ? Date.now() : null } : v)),
          }
        : d,
    );
  };

  if (feed.loading) {
    return (
      <>
        <div class="empty-state">
          <div class="spinner" />
        </div>
        <LogDialog
          open={logOpen}
          log={log}
          sourceFilter={logSourceFilter}
          onSourceFilterChange={setLogSourceFilter}
          onClose={() => setLogOpen(false)}
          onClear={clearLog}
          scrollRef={logRef}
        />
      </>
    );
  }

  const hasChannels = (feed.data?.nameById.size ?? 0) > 0;
  const errorCount = status?.errors.length ?? 0;
  const videoCount = feed.data?.videos.length ?? 0;
  const showLogToggle = videoCount > 0 || hasChannels;
  const unreadCount = videoCount > 0 ? feed.data!.videos.filter((v) => !v.seen).length : 0;

  // Single body — covers both the empty-state (no videos yet / no channels)
  // and the main feed. The LogDialog always renders at the end so the
  // "Show log" button works in every state.
  return (
    <>
      {videoCount === 0 && hasChannels && (
        <div>
          <EmptyState
            icon={refreshing ? <div class="spinner" /> : <Icon path={Icons.feed} size={44} />}
            title={refreshing ? 'Fetching your subscriptions…' : 'No videos yet'}
            hint={
              refreshing
                ? (() => {
                    const ps = status?.perSource;
                    const parts: string[] = [];
                    if (ps) {
                      for (const k of ALL_SOURCE_KINDS) {
                        const processed = ps.processed[k] ?? 0;
                        const errs = ps.errors[k] ?? 0;
                        if (processed > 0 || errs > 0) {
                          parts.push(`${k} ${processed}${errs > 0 ? ` (${errs} err)` : ''}`);
                        }
                      }
                    }
                    const total = status?.total ?? 0;
                    const done = status?.done ?? 0;
                    const progress = total > 0 ? `${done}/${total} channels` : '';
                    const breakdown = parts.length > 0 ? `Done: ${parts.join(', ')}.` : '';
                    const current = status?.currentChannel ? ` Currently on ${status.currentChannel}.` : '';
                    return `${progress ? `Progress: ${progress}. ` : ''}${breakdown}${breakdown ? ' ' : ''}This can take a minute for large subscription lists.${current}`;
                  })()
                : errorCount > 0
                  ? `${errorCount} channel${errorCount === 1 ? '' : 's'} failed to fetch. Check the Subscriptions tab for details, or click refresh to retry.`
                  : 'You have channels but no videos in the cache yet. Click refresh to fetch their latest uploads.'
            }
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                class="btn primary"
                onClick={startRefresh}
                disabled={refreshing}
                title={tagFilter ? `Refresh ${tagFilter}` : 'Refresh everything'}
              >
                <Icon path={Icons.refresh} size={15} /> Refresh now
              </button>
              {refreshing && (
                <button class="btn danger" onClick={cancelRefresh} title="Stop the current refresh">
                  <Icon path={Icons.x} size={15} /> Stop refresh
                </button>
              )}
              <button class="btn" onClick={onGoToSubs}>
                <Icon path={Icons.users} /> Manage subscriptions
              </button>
              {showLogToggle && (
                <button
                  class="chip"
                  onClick={() => setLogOpen((o) => !o)}
                  title="Show engine activity log"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 12 }}
                >
                  log
                  <span
                    style={{
                      display: 'inline-block',
                      minWidth: 20,
                      textAlign: 'center',
                      fontSize: 10,
                      background: log.length > 0 ? 'var(--bg-hover)' : 'transparent',
                      padding: log.length > 0 ? '0 4px' : 0,
                      borderRadius: 999,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                    aria-label={`${log.length} log entries`}
                  >
                    {log.length > 0 ? log.length : '0'}
                  </span>
                </button>
              )}
            </div>
          </EmptyState>
        </div>
      )}
      {videoCount === 0 && !hasChannels && (
        <div>
          <EmptyState
            icon={<Icon path={Icons.feed} size={44} />}
            title="Your feed is empty"
            hint="Add the channels you want to follow, then refresh to pull their latest uploads."
          >
            <button class="btn primary" onClick={onGoToSubs}>
              <Icon path={Icons.users} /> Add subscriptions
            </button>
          </EmptyState>
        </div>
      )}
      {videoCount > 0 && (
        <div>
          <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', paddingTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              key="video"
              class={`chip${filter === 'video' ? ' active' : ''}`}
              onClick={() => setFilter('video')}
            >
              {'Videos'}
            </button>
            {feed.data!.settings.fetchShorts && (
              <button
                key="short"
                class={`chip${filter === 'short' ? ' active' : ''}`}
                onClick={() => setFilter('short')}
              >
                {'Shorts'}
              </button>
            )}
            {feed.data!.settings.fetchLive && (
              <button
                key="live"
                class={`chip${filter === 'live' ? ' active' : ''}`}
                onClick={() => setFilter('live')}
              >
                {'Live'}
              </button>
            )}
            {feed.data!.tags.length > 0 && (
              <>
                <span style={{ color: 'var(--border)', fontSize: 18 }}>|</span>
                <span class="muted">Current Tag:</span>
                <select
                  value={tagFilter ?? ''}
                  onChange={(e) => pickTag((e.target as HTMLSelectElement).value || null)}
                  style={{ width: 'auto', maxWidth: 200 }}
                >
                  <option value="">All tags</option>
                  {feed.data!.tags.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            {refreshing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 160, flexWrap: 'wrap' }}>
                <span
                  class="faint"
                  style={{
                    whiteSpace: 'nowrap',
                    maxWidth: 260,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  Refreshing {status?.done ?? 0}/{status?.total ?? 0}
                  {status?.currentChannel ? ` — ${status.currentChannel}` : ''}
                </span>
                <div class="progress-bar" style={{ width: 90, flexShrink: 0 }}>
                  <div
                    style={{
                      width: status && status.total > 0 ? `${Math.round((status.done / status.total) * 100)}%` : '5%',
                    }}
                  />
                </div>
                {status?.perSource && (() => {
                  const ps = status.perSource;
                  const parts: string[] = [];
                  for (const k of ALL_SOURCE_KINDS) {
                    const n = ps.processed[k] ?? 0;
                    const err = ps.errors[k] ?? 0;
                    if (n > 0 || err > 0) {
                      parts.push(`${k[0]?.toUpperCase()}${n}${err > 0 ? `+${err}!` : ''}`);
                    }
                  }
                  return parts.length > 0 ? (
                    <span
                      class="faint"
                      style={{
                        fontSize: 11,
                        whiteSpace: 'nowrap',
                        fontVariantNumeric: 'tabular-nums',
                        minWidth: 64,
                        textAlign: 'right',
                      }}
                    >
                      {parts.join(' ')}
                    </span>
                  ) : null;
                })()}
              </div>
            )}
            {refreshing && (
              <button
                class="chip"
                onClick={cancelRefresh}
                title="Stop the current refresh"
                style={{ borderColor: 'var(--err)', color: 'var(--err)' }}
              >
                <Icon path={Icons.x} size={12} /> Stop
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button
              class="chip"
              onClick={() => setLogOpen((o) => !o)}
              title="Show engine activity log"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px', fontSize: 12 }}
            >
              <Icon path={Icons.feed} size={12} />
              log
              <span
                style={{
                  display: 'inline-block',
                  minWidth: 20,
                  textAlign: 'center',
                  fontSize: 10,
                  background: log.length > 0 ? 'var(--bg-hover)' : 'transparent',
                  padding: log.length > 0 ? '0 4px' : 0,
                  borderRadius: 999,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}
                aria-label={`${log.length} log entries`}
              >
                {log.length > 0 ? log.length : '0'}
              </span>
            </button>
            <button
              class="refresh-fab"
              title={tagFilter ? `Refresh ${tagFilter}` : 'Refresh everything'}
              disabled={refreshing}
              onClick={startRefresh}
            >
              <span class={refreshing ? 'icon-spin' : ''} style={{ display: 'inline-flex' }}>
                <Icon path={Icons.refresh} size={16} />
              </span>
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <input
              type="search"
              placeholder="Search feed…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              style={{ flex: 1, minWidth: 180 }}
            />
            <button class={`chip${hideSeen ? ' active' : ''}`} onClick={() => setHideSeen((h) => !h)}>
              {hideSeen ? 'Hiding seen' : 'Showing seen'}
            </button>
          </div>

          {channelFilter && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                padding: '8px 12px',
                background: 'var(--accent-soft)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <span style={{ fontSize: 13 }}>
                Showing uploads from{' '}
                <strong>{feed.data?.nameById.get(channelFilter) ?? channelFilter}</strong>
              </span>
              <span style={{ flex: 1 }} />
              <button
                class="icon-btn"
                style={{ width: 26, height: 26 }}
                disabled={refreshing}
                onClick={refreshChannel}
                title={`Check ${feed.data?.nameById.get(channelFilter) ?? channelFilter} for new uploads`}
              >
                <Icon path={Icons.refresh} size={15} />
              </button>
              <button class="btn small" onClick={clearChannelFilter} title="Show all channels">
                Clear filter
              </button>
            </div>
          )}

          <div class="faint" style={{ marginBottom: 10 }}>
            {filtered.length} videos • {unreadCount} unseen
          </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              title="Nothing matches"
              hint={
                channelFilter
                  ? 'This channel has no videos in your cache yet — try refreshing.'
                  : 'Try different filters or refresh your feed.'
              }
            />
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 16,
                }}
              >
                {filtered.slice(0, count).map((v) => (
                  <VideoCard
                    key={v.id}
                    video={v}
                    channelName={feed.data!.nameById.get(v.channelId) ?? v.channelId}
                    markSeenOnClick={feed.data!.settings.markSeenOnClick}
                    onToggleSeen={toggleSeen}
                  />
                ))}
              </div>
              {filtered.length > count && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '22px 0' }}>
                  <button class="btn" onClick={() => setCount((c) => c + PAGE)}>
                    Load more ({filtered.length - count} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <LogDialog
        open={logOpen}
        log={log}
        sourceFilter={logSourceFilter}
        onSourceFilterChange={setLogSourceFilter}
        onClose={() => setLogOpen(false)}
        onClear={clearLog}
        scrollRef={logRef}
      />
    </>
  );
}

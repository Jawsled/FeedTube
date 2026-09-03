import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { listChannels, listVideos, setSeen } from '../../lib/db';
import { readStoredStatus } from '../../lib/core/feed-engine';
import { formatRelative, sourceWatchUrl } from '../../lib/utils';
import type { SourceKind, VideoKind } from '../../lib/types';
import { Avatar, EmptyState, Icon, Icons } from '../dashboard/components/ui';

interface FeedItem {
  id: string;
  source: SourceKind;
  kind: VideoKind;
  title: string;
  channelId: string;
  channelName: string;
  avatarUrl: string | null;
  publishedAt: number | null;
}

export function App() {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [hasChannels, setHasChannels] = useState(true);

  useEffect(() => {
    const load = async () => {
      const [videos, channels] = await Promise.all([listVideos(), listChannels()]);
      setHasChannels(channels.length > 0);
      const nameById = new Map(channels.map((c) => [c.id, c]));
      const unread = videos
        .filter((v) => !v.seen)
        .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
      setUnreadTotal(unread.length);
      setItems(
        unread.slice(0, 12).map((v) => ({
          id: v.id,
          source: v.source,
          kind: v.kind,
          title: v.title,
          channelId: v.channelId,
          channelName: nameById.get(v.channelId)?.name ?? v.channelId,
          avatarUrl: nameById.get(v.channelId)?.avatarUrl ?? null,
          publishedAt: v.publishedAt,
        })),
      );
    };
    void load();
    const onChanged = (
      changes: Record<string, unknown>,
      area: string,
    ) => {
      if (area === 'local' && 'engineStatus' in changes) {
        const s = (changes.engineStatus as { newValue?: { running?: boolean; finishedAt?: number | null } })
          .newValue;
        if (s) setRefreshing(!!s.running && s.finishedAt == null);
        if (s && !s.running && s.finishedAt != null) void load();
      }
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  useEffect(() => {
    void readStoredStatus().then((s) => setRefreshing(s.running));
  }, []);

  const openVideo = async (item: FeedItem) => {
    await setSeen([item.id], true);
    await browser.runtime.sendMessage({ type: 'cmd/update-badge' });
    await browser.tabs.create({ url: sourceWatchUrl(item.source, item.id, item.kind) });
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? null);
    setUnreadTotal((n) => Math.max(0, n - 1));
  };

  return (
    <div style={{ width: 380, display: 'flex', flexDirection: 'column', minHeight: 320 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg)',
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <img src="/icon/32.png" alt="" width={22} height={22} style={{ borderRadius: 5 }} />
        <strong style={{ fontSize: 15 }}>FeedTube</strong>
        <div style={{ flex: 1 }} />
        {unreadTotal > 0 && (
          <span class="faint" style={{ fontSize: 12 }}>{unreadTotal} unseen</span>
        )}
        <button
          class="icon-btn"
          title="Open dashboard"
          onClick={() =>
            void browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') })
          }
        >
          <Icon path={Icons.feed} size={16} />
        </button>
        <button
          class="icon-btn"
          title="Refresh"
          disabled={refreshing}
          onClick={() => void browser.runtime.sendMessage({ type: 'cmd/start-refresh' })}
        >
          {refreshing ? <span class="spinner" /> : <Icon path={Icons.refresh} size={16} />}
        </button>
        <button
          class="icon-btn"
          title="Settings"
          onClick={() =>
            void browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html#/settings') })
          }
        >
          <Icon path={Icons.gear} size={16} />
        </button>
      </div>

      <div style={{ flex: 1 }}>
        {items == null ? (
          <div class="empty-state">
            <div class="spinner" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Icon path={Icons.check} size={36} />}
            title={hasChannels ? 'All caught up' : 'Welcome to FeedTube'}
            hint={
              hasChannels
                ? undefined
                : 'Open the dashboard to add channels or import your subscriptions.'
            }
          >
            {!hasChannels && (
              <button
                class="btn primary"
                onClick={() =>
                  void browser.tabs.create({
                    url: browser.runtime.getURL('/dashboard.html#/subs'),
                  })
                }
              >
                Add subscriptions
              </button>
            )}
          </EmptyState>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              onClick={() => void openVideo(item)}
              style={{
                display: 'flex',
                gap: 10,
                padding: '9px 14px',
                cursor: 'pointer',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
            >
              <Avatar src={item.avatarUrl} name={item.channelName} size={34} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.3,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {item.title}
                </div>
                <div class="faint" style={{ marginTop: 2 }}>
                  {item.channelName} • {formatRelative(item.publishedAt)}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

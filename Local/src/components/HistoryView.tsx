import { useMemo, useState } from 'preact/hooks';
import { updateBadge } from '../lib/core/badge';
import { listChannels, listSeenVideos } from '../lib/db';
import { useAsync } from './ui';
import { VideoCard } from './VideoCard';

const PAGE = 60;

export function HistoryView() {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(PAGE);

  const feed = useAsync(async () => {
    const [videos, channels] = await Promise.all([listSeenVideos(), listChannels()]);
    const nameById = new Map(channels.map((c) => [c.id, c.name]));
    videos.sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0));
    return { videos, nameById };
  }, []);

  const filtered = useMemo(() => {
    const d = feed.data;
    if (!d) return [];
    let items = d.videos;
    const q = query.trim().toLowerCase();
    if (q) {
      items = items.filter(
        (v) =>
          v.title.toLowerCase().includes(q) ||
          (d.nameById.get(v.channelId) ?? '').toLowerCase().includes(q),
      );
    }
    return items;
  }, [feed.data, query]);

  const toggleSeen = (id: string, seen: boolean) => {
    // In history view, toggle means unmark (removes from history)
    void import('../lib/db').then(({ setSeen }) => {
      void setSeen([id], seen);
      void updateBadge();
      feed.setData((d) =>
        d ? { ...d, videos: d.videos.filter((v) => v.id !== id) } : d,
      );
    });
  };

  if (feed.loading) {
    return (
      <div class="empty-state">
        <div class="spinner" />
      </div>
    );
  }

  const videoCount = feed.data?.videos.length ?? 0;

  return (
    <div>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--bg)', paddingTop: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            type="search"
            placeholder="Search history…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            style={{ flex: 1, minWidth: 180 }}
          />
        </div>
        <div class="faint" style={{ marginBottom: 10 }}>
          {filtered.length} watched video{filtered.length === 1 ? '' : 's'}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div class="empty-state">
          <div style={{ fontSize: 32, opacity: 0.3 }}>No watched videos</div>
          <div class="faint">
            {videoCount === 0
              ? 'Import watch history or mark videos as seen in the feed.'
              : 'Try a different search.'}
          </div>
        </div>
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
                markSeenOnClick={false}
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
  );
}

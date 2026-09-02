import { useState } from 'preact/hooks';
import { formatDuration, formatRelative, formatViews, sourceWatchUrl } from '../lib/utils';
import type { VideoRecord } from '../lib/types';
import { Icon, Icons, SourcePill } from './ui';

function IconEye({ seen }: { seen: boolean }) {
  return <Icon path={seen ? Icons.eye : Icons.eyeOff} size={15} />;
}

export function VideoCard({
  video,
  channelName,
  markSeenOnClick,
  onToggleSeen,
}: {
  video: VideoRecord;
  channelName: string;
  markSeenOnClick: boolean;
  onToggleSeen: (id: string, seen: boolean) => void;
}) {
  const url = sourceWatchUrl(video.source, video.id, video.kind);
  const [copied, setCopied] = useState(false);

  const copyLink = (e: MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(url);
    if (!video.seen) onToggleSeen(video.id, true);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const open = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (markSeenOnClick && !video.seen) onToggleSeen(video.id, true);
    window.open(url, '_blank', 'noopener');
  };

  const openChannel = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    location.hash = `#/feed?channel=${encodeURIComponent(video.channelId)}`;
  };

  return (
    <div
      class={`video-card${video.seen ? ' seen' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        cursor: 'pointer',
        position: 'relative',
        transition: 'border-color .15s ease, transform .15s ease, box-shadow .15s ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--text-faint)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.25)';
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 1px 3px rgba(0,0,0,0.12)';
        (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '16/9', background: '#000' }}>
        <a
          href={url}
          onClick={open}
          style={{ display: 'block', width: '100%', height: '100%' }}
          title="Open video"
        >
          <img
            src={video.thumbnailUrl ?? ''}
            alt=""
            loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            onError={(e) => {
              if (video.source === 'youtube') {
                (e.currentTarget as HTMLImageElement).src = `https://i.ytimg.com/vi/${video.id.replace(/^youtube:/, '')}/hqdefault.jpg`;
              }
            }}
          />
        </a>
        {video.durationSeconds != null && (
          <span class="badge" style={{ right: 6, bottom: 6 }}>
            {formatDuration(video.durationSeconds)}
          </span>
        )}
        {video.kind === 'live' && (
          <span class="live-badge" style={{ left: 6, top: 6 }}>
            LIVE
          </span>
        )}
        {video.seen && (
          <span
            style={{
              position: 'absolute',
              left: 6,
              top: 6,
              padding: '2px 7px',
              borderRadius: 3,
              background: 'rgba(0, 0, 0, 0.75)',
              color: '#fff',
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}
          >
            Watched
          </span>
        )}
        {!video.seen && (
          <span
            style={{
              position: 'absolute',
              left: 6,
              bottom: 6,
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: 'var(--accent)',
            }}
            title="Unseen"
          />
        )}
      </div>
      {video.seen && (
        <div
          class="watched-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.65)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
      <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <a
          href={url}
          onClick={open}
          title={video.title}
          style={{
            fontWeight: 600,
            fontSize: 13.5,
            lineHeight: 1.35,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            minHeight: '2.6em',
            textDecoration: 'none',
            color: 'inherit',
          }}
        >
          {video.title}
        </a>
        <div class="faint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <a
            href={`#/feed?channel=${encodeURIComponent(video.channelId)}`}
            onClick={openChannel}
            title={`Open ${channelName} in FeedTube`}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              textDecoration: 'none',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            {channelName}
          </a>
          <SourcePill source={video.source} />
          {video.kind === 'short' && <span>• Short</span>}
        </div>
        <div
          class="faint"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
        >
          <span>
            {formatRelative(video.publishedAt)}
            {video.viewCount != null ? ` • ${formatViews(video.viewCount)}` : ''}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button
              class="icon-btn"
              style={{ width: 24, height: 24 }}
              title={copied ? 'Copied!' : 'Copy link'}
              onClick={copyLink}
            >
              <Icon path={copied ? Icons.check : Icons.copy} size={15} />
            </button>
            <button
              class="icon-btn"
              style={{ width: 24, height: 24 }}
              title={video.seen ? 'Mark unseen' : 'Mark seen'}
              onClick={(e) => {
                e.stopPropagation();
                onToggleSeen(video.id, !video.seen);
              }}
            >
              <IconEye seen={video.seen} />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

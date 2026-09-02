import { useState } from 'preact/hooks';
import { refreshAll } from '../lib/core/feed-engine';
import { updateBadge } from '../lib/core/badge';
import { listChannels, listTags, markAllSeen, clearVideos, markHistoryAsSeen, listSeenVideos, countSeenVideos, clearHistory } from '../lib/db';
import { importFromFile, type ImportFormat } from '../lib/io/importer';
import { buildFeedTubeJson, buildOpml, buildOpmlBySource, buildNewPipeJson, buildGrayjayZip } from '../lib/io/export';
import { ALL_SOURCE_KINDS } from '../lib/api/source';
import { SectionTitle, useAsync, useToast } from './ui';
import type { ImportSummary } from '../lib/types';
import { detectHistoryFormatFromFile, parseHistoryFile, parseGrayjayHistoryFromFile, type HistoryFormat } from '../lib/io/import-history';
import { buildHistoryExport } from '../lib/io/export-history';

function download(filename: string, content: string | Blob, mime: string): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mime }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const HISTORY_FORMAT_LABELS: Record<HistoryFormat, string> = {
  'freetube-history': 'FreeTube watch history',
  'youtube-history': 'YouTube watch history (Google Takeout)',
  'grayjay-history': 'Grayjay history',
  'feedtube-history': 'FeedTube history export',
  unknown: 'Unknown',
};

export function ImportExportSection() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historySummary, setHistorySummary] = useState<{ format: string; total: number; matched: number } | null>(null);

  const channels = useAsync(async () => {
    const [ch, tags] = await Promise.all([listChannels(), listTags()]);
    return { channels: ch, tags };
  }, []);

  const seenCount = useAsync(() => countSeenVideos(), []);

  const handleFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setSummary(null);
    try {
      const result = await importFromFile(file);
      setSummary(result);
      channels.reload();
      if (result.added > 0) {
        void refreshAll();
      }
    } catch (e) {
      toast(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleHistoryFile = async (file: File | undefined) => {
    if (!file || historyBusy) return;
    setHistoryBusy(true);
    setHistorySummary(null);
    try {
      const { format, text } = await detectHistoryFormatFromFile(file);
      if (format === 'unknown') {
        toast('Unrecognized history file format');
        setHistoryBusy(false);
        return;
      }

      let entries;
      if (format === 'grayjay-history') {
        entries = await parseGrayjayHistoryFromFile(file);
      } else {
        entries = parseHistoryFile(format, text);
      }

      if (entries.length === 0) {
        toast('No history entries found in file');
        setHistoryBusy(false);
        return;
      }

      const result = await markHistoryAsSeen(entries);
      setHistorySummary({
        format: HISTORY_FORMAT_LABELS[format],
        total: entries.length,
        matched: result.matched,
      });
      seenCount.reload();
      void updateBadge();
      if (result.matched > 0) {
        toast(`Marked ${result.matched} video${result.matched === 1 ? '' : 's'} as seen`);
      }
    } catch (e) {
      toast(`History import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const exportJson = async () => {
    const data = channels.data ?? { channels: [], tags: [] };
    download(
      `feedtube-subscriptions-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(buildFeedTubeJson(data.channels, data.tags), null, 2),
      'application/json',
    );
  };

  const exportOpml = async () => {
    download(
      `feedtube-subscriptions-${new Date().toISOString().slice(0, 10)}.opml`,
      buildOpml(channels.data?.channels ?? []),
      'text/x-opml',
    );
  };

  const exportOpmlBySource = async () => {
    const data = channels.data?.channels ?? [];
    const grouped = buildOpmlBySource(data);
    ALL_SOURCE_KINDS.forEach((k) => {
      const list = data.filter((c) => c.source === k);
      if (list.length === 0) return;
      download(
        `feedtube-${k}-${new Date().toISOString().slice(0, 10)}.opml`,
        grouped[k],
        'text/x-opml',
      );
    });
    toast(`Exported ${data.length} channel${data.length === 1 ? '' : 's'} by source`);
  };

  const exportNewPipe = async () => {
    download(
      `feedtube-subscriptions-${new Date().toISOString().slice(0, 10)}.json`,
      buildNewPipeJson(channels.data?.channels ?? []),
      'application/json',
    );
  };

  const exportGrayjay = async () => {
    const data = channels.data ?? { channels: [], tags: [] };
    const blob = await buildGrayjayZip(data.channels, data.tags);
    download(
      `feedtube-subscriptions-${new Date().toISOString().slice(0, 10)}.zip`,
      blob,
      'application/zip',
    );
  };

  const exportHistory = async () => {
    const videos = await listSeenVideos();
    if (videos.length === 0) {
      toast('No watch history to export');
      return;
    }
    download(
      `feedtube-history-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(buildHistoryExport(videos), null, 2),
      'application/json',
    );
    toast(`Exported ${videos.length} watched video${videos.length === 1 ? '' : 's'}`);
  };

  return (
    <>
      <SectionTitle>Import / Export</SectionTitle>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
      <div class="card">
        <h3 style={{ margin: '0 0 6px' }}>Import subscriptions</h3>
        <p class="faint" style={{ marginTop: 0 }}>
          Supports NewPipe (<code>.db</code> or exported <code>.json</code>), Google Takeout
          (<code>.csv</code> / <code>.json</code>), Grayjay (<code>.zip</code>), OPML files and
          FeedTube exports.
        </p>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '28px 16px',
            border: '2px dashed var(--border)',
            borderRadius: 'var(--radius)',
            cursor: busy ? 'wait' : 'pointer',
            textAlign: 'center',
          }}
        >
          {busy ? (
            <>
              <span class="spinner" />
              <span class="muted">Importing…</span>
            </>
          ) : (
            <>
              <strong>Drop a file here or click to browse</strong>
              <span class="faint">.db .json .csv .opml .zip</span>
            </>
          )}
          <input
            type="file"
            accept=".db,.sqlite,.json,.csv,.opml,.xml,.zip"
            disabled={busy}
            style={{ display: 'none' }}
            onChange={(e) => {
              void handleFile((e.target as HTMLInputElement).files?.[0]);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
        {summary && (
          <div style={{ marginTop: 12 }}>
            <div>
              Detected: <strong>{summary.detected}</strong>
            </div>
            <div class="muted" style={{ marginTop: 4 }}>
              {summary.parsed} found • {summary.added} added • {summary.duplicates} duplicates
              {summary.failed.length > 0 && ` • ${summary.failed.length} failed`}
            </div>
            {summary.failed.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary class="error-text" style={{ cursor: 'pointer' }}>
                  Show failures
                </summary>
                <ul style={{ margin: '6px 0', paddingLeft: 18 }} class="error-text">
                  {summary.failed.slice(0, 20).map((f, i) => (
                    <li key={i}>
                      {f.input}: {f.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {summary.added > 0 && <div class="faint">Fetching new channels in the background…</div>}
          </div>
        )}
      </div>

      <div class="card">
        <h3 style={{ margin: '0 0 6px' }}>Export subscriptions</h3>
        <p class="faint" style={{ marginTop: 0 }}>
          Export your channel list (with tags) to re-import here on another device, as OPML for
          any RSS reader, as NewPipe JSON, or as a Grayjay ZIP.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            class="btn"
            onClick={() => void exportJson()}
            disabled={(channels.data?.channels.length ?? 0) === 0}
          >
            FeedTube JSON ({(channels.data?.channels.length ?? 0)} channels, {(channels.data?.tags.length ?? 0)} tags)
          </button>
          <button
            class="btn"
            onClick={() => void exportOpml()}
            disabled={(channels.data?.channels.length ?? 0) === 0}
          >
            OPML (all)
          </button>
          <button
            class="btn"
            onClick={() => void exportOpmlBySource()}
            disabled={(channels.data?.channels.length ?? 0) === 0}
          >
            Per-source OPML (one file per platform)
          </button>
          <button
            class="btn"
            onClick={() => void exportNewPipe()}
            disabled={(channels.data?.channels.length ?? 0) === 0}
          >
            NewPipe JSON (YouTube only)
          </button>
          <button
            class="btn"
            onClick={() => void exportGrayjay()}
            disabled={(channels.data?.channels.length ?? 0) === 0}
          >
            Grayjay ZIP ({(channels.data?.channels.length ?? 0)} channels)
          </button>
        </div>
      </div>

      <div class="card">
        <h3 style={{ margin: '0 0 6px' }}>Import watch history</h3>
        <p class="faint" style={{ marginTop: 0 }}>
          Import history from FreeTube (<code>.db</code>), YouTube Takeout (<code>.json</code>),
          Grayjay (<code>.zip</code>), or FeedTube exports. Videos already in your cache will be
          marked as seen.
        </p>
        <label
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '28px 16px',
            border: '2px dashed var(--border)',
            borderRadius: 'var(--radius)',
            cursor: historyBusy ? 'wait' : 'pointer',
            textAlign: 'center',
          }}
        >
          {historyBusy ? (
            <>
              <span class="spinner" />
              <span class="muted">Importing history…</span>
            </>
          ) : (
            <>
              <strong>Drop a history file here or click to browse</strong>
              <span class="faint">.db .json .zip</span>
            </>
          )}
          <input
            type="file"
            accept=".db,.sqlite,.json,.zip"
            disabled={historyBusy}
            style={{ display: 'none' }}
            onChange={(e) => {
              void handleHistoryFile((e.target as HTMLInputElement).files?.[0]);
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
        {historySummary && (
          <div style={{ marginTop: 12 }}>
            <div>
              Detected: <strong>{historySummary.format}</strong>
            </div>
            <div class="muted" style={{ marginTop: 4 }}>
              {historySummary.total} entries found • {historySummary.matched} matched videos marked as seen
            </div>
          </div>
        )}
      </div>

      <div class="card">
        <h3 style={{ margin: '0 0 6px' }}>Export watch history</h3>
        <p class="faint" style={{ marginTop: 0 }}>
          Export your watched videos as a FeedTube history file. Currently has{' '}
          <strong>{seenCount.data ?? 0}</strong> watched video{(seenCount.data ?? 0) === 1 ? '' : 's'} in cache.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            class="btn"
            onClick={() => void exportHistory()}
            disabled={(seenCount.data ?? 0) === 0}
          >
            FeedTube history ({seenCount.data ?? 0} videos)
          </button>
        </div>
      </div>

      <div class="card" style={{ borderColor: 'var(--err)' }}>
        <h3 style={{ margin: '0 0 6px', color: 'var(--err)' }}>Danger zone</h3>
        <p class="faint" style={{ marginTop: 0 }}>
          These actions affect cached data only. Your subscription list stays intact unless noted.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button
            class="btn danger"
            onClick={() => {
              if (!confirm('Mark every video as seen?')) return;
              if (!confirm('Are you sure? This will mark ALL videos as watched.')) return;
              void markAllSeen().then(() => {
                void updateBadge();
                toast('All videos marked seen');
                seenCount.reload();
              });
            }}
          >
            Mark all videos seen
          </button>
          <button
            class="btn danger"
            onClick={() => {
              if (!confirm('Clear watch history? This unmarks all videos as seen.')) return;
              if (!confirm('Are you sure? This will remove all watch history.')) return;
              void clearHistory().then(() => {
                void updateBadge();
                toast('Watch history cleared');
                seenCount.reload();
              });
            }}
          >
            Clear history
          </button>
          <button
            class="btn danger"
            onClick={() => {
              if (!confirm('Delete all cached videos? Channels are kept.')) return;
              if (!confirm('Are you sure? This will permanently delete all cached videos.')) return;
              void clearVideos().then(() => {
                void updateBadge();
                toast('Video cache cleared');
                seenCount.reload();
              });
            }}
          >
            Clear video cache
          </button>
        </div>
      </div>
      </div>
    </>
  );
}

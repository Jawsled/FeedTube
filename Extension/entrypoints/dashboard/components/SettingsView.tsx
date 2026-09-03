import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../../lib/settings';
import { normalizeInstance, testInvidiousInstance } from '../../../lib/api/invidious';
import { ALL_SOURCE_KINDS, SOURCE_META, type SourceKind } from '../../../lib/api/source';
import { Row, SectionTitle, Toggle, useToast } from './ui';
import { ImportExportSection } from './ImportExportView';

type ProbeName = 'odysee' | 'bilibili' | 'peertube' | 'soundcloud';
const PROBE_BY_SOURCE: Partial<Record<SourceKind, ProbeName>> = {
  odysee: 'odysee',
  bilibili: 'bilibili',
  peertube: 'peertube',
  soundcloud: 'soundcloud',
};
const PROBE_LABELS: Record<ProbeName, string> = {
  odysee: 'Test Odysee API',
  bilibili: 'Test Bilibili API',
  peertube: 'Test PeerTube API',
  soundcloud: 'Test SoundCloud API',
};

function probeViaSw(probe: ProbeName): Promise<string> {
  return browser.runtime
    .sendMessage({ type: `cmd/probe-${probe}` })
    .then((res: { ok: boolean; message: string } | undefined) => {
      if (!res) return `✗ ${PROBE_LABELS[probe].replace('Test ', '')}: no response from service worker`;
      return res.ok ? `✓ ${res.message}` : `✗ ${res.message}`;
    })
    .catch((e: unknown) =>
      `✗ ${PROBE_LABELS[probe].replace('Test ', '')} API unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
}

const SOURCE_HINTS: Record<SourceKind, string> = {
  youtube: 'Built-in. Disable to skip YouTube channel refreshes entirely.',
  odysee: 'Uses lbry.tv RSS. Disable to skip Odysee refreshes.',
  bilibili: 'Web API (WBI-signed) with anonymous app API fallback. Disable if geo-blocked.',
  peertube: 'Federated network. Each channel lives on its own instance — host is auto-detected from the URL.',
  soundcloud:
    'Uses the same v2 web API as the official SoundCloud app (the public per-user RSS feed was disabled in 2024). Disable to skip SoundCloud refreshes.',
};

export function SettingsView() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [instanceInput, setInstanceInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [probes, setProbes] = useState<Partial<Record<SourceKind, string | null>>>(
    Object.fromEntries(ALL_SOURCE_KINDS.map((k) => [k, null])),
  );

  useEffect(() => {
    void loadSettings().then((s) => {
      setSettings(s);
      setInstanceInput(s.invidiousInstance);
    });
  }, []);

  if (!settings) {
    return (
      <div class="empty-state">
        <div class="spinner" />
      </div>
    );
  }

  const update = async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    if ('refreshPeriodMin' in patch) {
      void browser.runtime.sendMessage({ type: 'cmd/reschedule-alarm' });
    }
  };

  const applyInvidious = async () => {
    const raw = instanceInput.trim();
    if (!raw) {
      await update({ invidiousInstance: '', invidiousEnabled: false });
      return;
    }
    let base: string;
    try {
      base = normalizeInstance(raw);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      const granted = await browser.permissions.request({ origins: [`${base}/*`] });
      if (!granted) {
        toast('Permission denied for that instance');
        return;
      }
    } catch {
      toast('Could not request site permission');
      return;
    }
    await update({ invidiousInstance: base });
    setTestResult(null);
    toast('Invidious instance saved');
  };

  const runTest = async () => {
    let base: string;
    try {
      base = normalizeInstance(instanceInput.trim());
    } catch (e) {
      setTestResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const { version } = await testInvidiousInstance(base);
      setTestResult(`✓ Instance reachable (Invidious ${version})`);
    } catch (e) {
      setTestResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  const runProbe = async (source: SourceKind) => {
    const probe = PROBE_BY_SOURCE[source];
    if (!probe) return;
    setProbes((p) => ({ ...p, [source]: 'Checking…' }));
    const result = await probeViaSw(probe);
    setProbes((p) => ({ ...p, [source]: result }));
  };

  const getEnabled = (source: SourceKind): boolean => {
    if (source === 'youtube') return settings.youtubeEnabled;
    if (source === 'odysee') return settings.odyseeEnabled;
    if (source === 'bilibili') return settings.bilibiliEnabled;
    if (source === 'peertube') return settings.peerTubeEnabled;
    return settings.soundCloudEnabled;
  };

  const setEnabled = (source: SourceKind, v: boolean) => {
    if (source === 'youtube') {
      void update({ youtubeEnabled: v });
      return;
    }
    if (source === 'odysee') {
      void update({ odyseeEnabled: v });
      return;
    }
    if (source === 'bilibili') {
      void update({ bilibiliEnabled: v });
      return;
    }
    if (source === 'peertube') {
      void update({ peerTubeEnabled: v });
      return;
    }
    void update({ soundCloudEnabled: v });
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <SectionTitle>Feed</SectionTitle>
      <div class="card" style={{ padding: '4px 18px' }}>
        <Row label="Background refresh" hint="How often to check channels for new uploads while the browser is open">
          <select
            value={settings.refreshPeriodMin}
            onChange={(e) => void update({ refreshPeriodMin: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value={0}>Off</option>
            <option value={15}>Every 15 min</option>
            <option value={30}>Every 30 min</option>
            <option value={60}>Every hour</option>
            <option value={180}>Every 3 h</option>
            <option value={360}>Every 6 h</option>
          </select>
        </Row>
        <Row label="Include Shorts" hint="Off by default. When enabled, also fetches each channel's Shorts tab and shows a Shorts filter in the feed">
          <Toggle on={settings.fetchShorts} onChange={(v) => void update({ fetchShorts: v })} />
        </Row>
        <Row label="Include live streams">
          <Toggle on={settings.fetchLive} onChange={(v) => void update({ fetchLive: v })} />
        </Row>
        <Row label="Videos per channel" hint="How many videos to fetch per channel during background refresh. Fewer = faster refreshes.">
          <select
            value={settings.feedFetchLimit}
            onChange={(e) => void update({ feedFetchLimit: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
            <option value={30}>30 (full)</option>
          </select>
        </Row>
        <Row
          label="RSS-only mode"
          hint="Use YouTube RSS feeds exclusively. Slower metadata but very reliable — recommended for 125+ subscriptions."
        >
          <Toggle on={settings.useRssOnly} onChange={(v) => void update({ useRssOnly: v })} />
        </Row>
        <Row label="Cache retention" hint="Videos older than this are removed from local storage after refreshes">
          <select
            value={settings.pruneDays}
            onChange={(e) => void update({ pruneDays: Number((e.target as HTMLSelectElement).value) })}
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={3650}>Keep everything</option>
          </select>
        </Row>
      </div>

      <SectionTitle>Behavior</SectionTitle>
      <div class="card" style={{ padding: '4px 18px' }}>
        <Row label="Mark seen when opening a video">
          <Toggle on={settings.markSeenOnClick} onChange={(v) => void update({ markSeenOnClick: v })} />
        </Row>
        <Row label="Hide seen videos by default" hint="Can be toggled in the feed at any time">
          <Toggle on={settings.hideSeenByDefault} onChange={(v) => void update({ hideSeenByDefault: v })} />
        </Row>
      </div>

      <SectionTitle>YouTube Integration</SectionTitle>
      <div class="card" style={{ padding: '4px 18px' }}>
        <Row
          label="Replace subscribe button on YouTube"
          hint="When visiting a channel page, replace the native subscribe button so you can assign tags on subscribe"
        >
          <Toggle
            on={settings.replaceSubscribeButton}
            onChange={(v) => void update({ replaceSubscribeButton: v })}
          />
        </Row>
        <Row
          label="Auto-refresh on browser start"
          hint="Trigger a feed refresh when the extension starts up"
        >
          <Toggle
            on={settings.autoRefreshOnLoad}
            onChange={(v) => void update({ autoRefreshOnLoad: v })}
          />
        </Row>
      </div>

      <SectionTitle>Sources</SectionTitle>
      <div class="card" style={{ padding: '0 0 4px' }}>
        {ALL_SOURCE_KINDS.map((source, idx) => {
          const meta = SOURCE_META[source];
          const enabled = getEnabled(source);
          const probe = PROBE_BY_SOURCE[source];
          const status = probes[source] ?? null;
          const isLast = idx === ALL_SOURCE_KINDS.length - 1;
          return (
            <div
              key={source}
              style={{
                padding: '8px 18px',
                borderBottom: isLast ? 'none' : '1px solid var(--border)',
                opacity: enabled ? 1 : 0.65,
              }}
            >
              <Row
                label={
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span
                      // eslint-disable-next-line react/no-danger
                      dangerouslySetInnerHTML={{ __html: meta.icon }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        color: meta.color,
                      }}
                      aria-hidden="true"
                    />
                    {meta.label}
                  </span>
                }
                hint={SOURCE_HINTS[source]}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Toggle
                    on={enabled}
                    onChange={(v) => void setEnabled(source, v)}
                    title={enabled ? 'Disable this source' : 'Enable this source'}
                  />
                </div>
              </Row>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, flexWrap: 'wrap' }}>
                {probe ? (
                  <button
                    class="btn small"
                    onClick={() => void runProbe(source)}
                    disabled={!enabled}
                    title={
                      enabled
                        ? `Probe ${meta.label}'s public API`
                        : `Enable ${meta.label} to test`
                    }
                  >
                    {PROBE_LABELS[probe]}
                  </button>
                ) : (
                  <span class="faint" style={{ fontSize: 11 }}>
                    Built-in — disable the toggle to skip refreshes.
                  </span>
                )}
                {status && (
                  <span
                    class="faint"
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      flex: 1,
                      minWidth: 0,
                      wordBreak: 'break-word',
                    }}
                  >
                    {status}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div style={{ padding: '8px 18px 0', fontSize: 11.5 }} class="faint">
          Disabled sources' channels are kept but skipped during refresh.
        </div>
      </div>

      <SectionTitle>Invidious</SectionTitle>
      <div class="card" style={{ padding: '4px 18px' }}>
        <Row
          label="Enable Invidious fallback"
          hint="When the native YouTube API fails, use your Invidious instance instead of RSS. Disabled by default."
        >
          <Toggle on={settings.invidiousEnabled} onChange={(v) => void update({ invidiousEnabled: v })} />
        </Row>
        <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
          <label class="muted" style={{ display: 'block', marginBottom: 6 }}>
            Instance URL
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="https://invidious.example.net"
              value={instanceInput}
              onInput={(e) => setInstanceInput((e.target as HTMLInputElement).value)}
              style={{ flex: 1 }}
            />
            <button class="btn small" disabled={testing || !instanceInput.trim()} onClick={() => void runTest()}>
              {testing ? <span class="spinner" /> : 'Test'}
            </button>
            <button class="btn primary small" onClick={() => void applyInvidious()}>
              Save
            </button>
          </div>
          {testResult && (
            <div class="faint" style={{ marginTop: 8 }}>
              {testResult}
            </div>
          )}
          <div class="faint" style={{ marginTop: 8 }}>
            Saving requests permission to reach that instance. Public instance list:
            docs.invidious.io/instances
          </div>
        </div>
      </div>

      <SectionTitle>Sidebar</SectionTitle>
      <div class="card" style={{ padding: '4px 18px' }}>
        <Row
          label="Collapse control"
          hint="What expands/collapses the sidebar. 'Brand logo' makes the logo itself the toggle (icons stay visible when collapsed); 'Hamburger' shows a menu button next to it."
        >
          <select
            value={settings.sidebarToggle}
            onChange={(e) =>
              void update({ sidebarToggle: (e.target as HTMLSelectElement).value as 'logo' | 'hamburger' })
            }
          >
            <option value="logo">Brand logo</option>
            <option value="hamburger">Hamburger menu</option>
          </select>
        </Row>
      </div>

      <SectionTitle>About</SectionTitle>
      <div class="card">
        <p class="muted" style={{ margin: '0 0 8px' }}>
          FeedTube keeps your own local subscription list and shows new uploads in one place. Videos
          always open on youtube.com in a normal tab — no embedded playback tricks.
        </p>
        <p class="faint" style={{ margin: 0 }}>
          Data sources: YouTube native API → Invidious (optional) → RSS; Odysee, Bilibili, PeerTube
          &amp; SoundCloud use their first-party public APIs. Inspired by FreeTube &amp; NewPipe. v0.1.0
        </p>
        <button class="btn small" style={{ marginTop: 10 }} onClick={() => void update(DEFAULT_SETTINGS)}>
          Reset all settings
        </button>
      </div>

      <ImportExportSection />
    </div>
  );
}

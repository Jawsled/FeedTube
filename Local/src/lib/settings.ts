import { browser } from './platform';

export interface Settings {
  refreshPeriodMin: number;
  useRssOnly: boolean;
  fetchShorts: boolean;
  fetchLive: boolean;
  markSeenOnClick: boolean;
  hideSeenByDefault: boolean;
  pruneDays: number;
  invidiousEnabled: boolean;
  invidiousInstance: string;
  youtubeEnabled: boolean;
  odyseeEnabled: boolean;
  bilibiliEnabled: boolean;
  peerTubeEnabled: boolean;
  soundCloudEnabled: boolean;
  replaceSubscribeButton: boolean;
  autoRefreshOnLoad: boolean;
  sidebarToggle: 'logo' | 'hamburger';
  feedFetchLimit: number;
}

export const DEFAULT_SETTINGS: Settings = {
  refreshPeriodMin: 30,
  useRssOnly: false,
  fetchShorts: false,
  fetchLive: true,
  markSeenOnClick: true,
  hideSeenByDefault: false,
  pruneDays: 90,
  invidiousEnabled: false,
  invidiousInstance: '',
  youtubeEnabled: true,
  odyseeEnabled: true,
  bilibiliEnabled: true,
  // SoundCloud now works via the v2 web API (same one Grayjay uses).
  // Defaults to enabled.
  peerTubeEnabled: true,
  soundCloudEnabled: true,
  replaceSubscribeButton: true,
  autoRefreshOnLoad: false,
  sidebarToggle: 'logo',
  feedFetchLimit: 3,
};

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const obj = await browser.storage.local.get(SETTINGS_KEY);
  const stored = (obj[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings();
  const next: Settings = { ...cur, ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// Platform reachability probes, ported from the extension's background
// message handlers. In the local app these run directly in-page; cross-origin
// requests go through the relay server via apiFetch.

import { listChannels } from '../db';
import { probeBilibiliApi } from '../api/bilibili';
import { soundcloudAdapter } from '../api/soundcloud';
import { apiFetch } from '../platform';

export interface ProbeResult {
  ok: boolean;
  message: string;
}

export async function probeOdysee(): Promise<ProbeResult> {
  try {
    const res = await apiFetch('https://lbry.tv/$/rss/@Odysee:9', { method: 'GET', redirect: 'follow' });
    if (!res.ok) return { ok: false, message: `Odysee RSS returned HTTP ${res.status}` };
    const text = await res.text();
    if (text.includes('<rss') && text.includes('<channel>')) {
      return { ok: true, message: 'Odysee RSS reachable (returned a valid feed)' };
    }
    return { ok: false, message: `Odysee RSS returned unexpected content (${text.length} bytes)` };
  } catch (e) {
    return { ok: false, message: `Odysee API unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function probeBilibili(): Promise<ProbeResult> {
  try {
    const r = await probeBilibiliApi();
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return { ok: false, message: `✗ Bilibili probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function probePeerTube(): Promise<ProbeResult> {
  try {
    // Test a real channel from the user's subscriptions instead of a
    // hardcoded instance, so the probe works for any PeerTube instance.
    const channels = await listChannels();
    const ptChannels = channels.filter((c) => c.source === 'peertube');
    if (ptChannels.length === 0) {
      const res = await apiFetch('https://peertube.tv/api/v1/config', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, message: `PeerTube API returned HTTP ${res.status}` };
      const j = (await res.json()) as { instance?: { name?: string; version?: string } };
      const name = j?.instance?.name ?? 'unknown instance';
      const version = j?.instance?.version ? ` (PeerTube ${j.instance.version})` : '';
      return { ok: true, message: `OK — reached ${name}${version} (default instance)` };
    }
    // Test the first PeerTube channel's instance
    const ch = ptChannels[0];
    const hostMatch = ch.id.match(/^peertube:([^@]+)/);
    const host = hostMatch?.[1];
    if (!host) return { ok: false, message: 'Could not parse PeerTube host from channel id' };
    const handle = ch.urlSlug ?? ch.id.split('@')[1] ?? '';
    const acctRes = await apiFetch(`https://${host}/api/v1/accounts/${encodeURIComponent(handle)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!acctRes.ok) return { ok: false, message: `PeerTube ${host} returned HTTP ${acctRes.status}` };
    const acct = (await acctRes.json()) as { displayName?: string; name?: string };
    const displayName = acct.displayName ?? acct.name ?? handle;
    return {
      ok: true,
      message: `OK — reached ${host} as "${displayName}" (${ptChannels.length} channel${ptChannels.length === 1 ? '' : 's'} subscribed)`,
    };
  } catch (e) {
    return { ok: false, message: `PeerTube API unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function probeSoundCloud(): Promise<ProbeResult> {
  try {
    console.log('[SC probe] resolveChannel...');
    const channel = await soundcloudAdapter.resolveChannel('https://soundcloud.com/osts');
    console.log('[SC probe] resolved:', channel);
    console.log('[SC probe] fetchChannel...');
    const result = await soundcloudAdapter.fetchChannel(channel.id);
    const n = result.videos.length;
    return { ok: true, message: `OK — resolved @${channel.name ?? '?'} via v2 API, got ${n} track${n === 1 ? '' : 's'}` };
  } catch (e) {
    console.error('[SC probe] failed:', e);
    return { ok: false, message: `SoundCloud probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

import express from 'express';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const PORT = process.env.PORT ?? 5198;

// ── helpers ──────────────────────────────────────────────────────────────────

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function readJSON(name) {
  const p = join(DATA_DIR, name);
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJSON(name, data) {
  await ensureDataDir();
  const p = join(DATA_DIR, name);
  const tmp = p + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  // rename is atomic on the same filesystem
  const { renameSync } = await import('node:fs');
  renameSync(tmp, p);
}

// ── app ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS for local dev (Vite on different port)
app.use((_req, res, next) => {
  res.header('access-control-allow-origin', '*');
  res.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('access-control-allow-headers', 'content-type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Channels ─────────────────────────────────────────────────────────────────

app.get('/api/channels', async (_req, res) => {
  res.json((await readJSON('channels.json')) ?? []);
});

app.get('/api/channels/:id', async (req, res) => {
  const list = (await readJSON('channels.json')) ?? [];
  const ch = list.find((c) => c.id === req.params.id);
  if (!ch) return res.status(404).json({ error: 'not found' });
  res.json(ch);
});

app.post('/api/channels', async (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const list = (await readJSON('channels.json')) ?? [];
  const map = new Map(list.map((c) => [c.id, c]));
  for (const ch of incoming) map.set(ch.id, { ...map.get(ch.id), ...ch });
  const out = [...map.values()];
  await writeJSON('channels.json', out);
  res.json({ ok: true });
});

app.patch('/api/channels/:id', async (req, res) => {
  const list = (await readJSON('channels.json')) ?? [];
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], ...req.body };
  await writeJSON('channels.json', list);
  res.json({ ok: true });
});

app.delete('/api/channels/:id', async (req, res) => {
  const id = req.params.id;
  const channels = (await readJSON('channels.json')) ?? [];
  const videos = (await readJSON('videos.json')) ?? [];
  await writeJSON('channels.json', channels.filter((c) => c.id !== id));
  await writeJSON('videos.json', videos.filter((v) => v.channelId !== id));
  res.json({ ok: true });
});

app.post('/api/channels/:id/tags', async (req, res) => {
  const { tags } = req.body;
  const list = (await readJSON('channels.json')) ?? [];
  const idx = list.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list[idx] = { ...list[idx], tags };
  await writeJSON('channels.json', list);
  res.json({ ok: true });
});

app.post('/api/channels/batch-tags', async (req, res) => {
  const { channelIds, tags } = req.body;
  const list = (await readJSON('channels.json')) ?? [];
  const set = new Set(channelIds);
  for (let i = 0; i < list.length; i++) {
    if (set.has(list[i].id)) list[i] = { ...list[i], tags };
  }
  await writeJSON('channels.json', list);
  res.json({ ok: true });
});

// ── Videos ───────────────────────────────────────────────────────────────────

app.get('/api/videos', async (_req, res) => {
  res.json((await readJSON('videos.json')) ?? []);
});

app.post('/api/videos/merge', async (req, res) => {
  const incoming = req.body; // NewVideo[]
  if (!Array.isArray(incoming) || incoming.length === 0) return res.json({ added: 0 });
  const videos = (await readJSON('videos.json')) ?? [];
  const map = new Map(videos.map((v) => [v.id, v]));
  let added = 0;
  for (const nv of incoming) {
    const key = `${nv.source}:${nv.id}`;
    const prev = map.get(key);
    if (prev) {
      map.set(key, mergeVideo(prev, { ...nv, id: key }));
    } else {
      added++;
      map.set(key, { ...nv, id: key, seen: false, seenAt: null });
    }
  }
  await writeJSON('videos.json', [...map.values()]);
  res.json({ added });
});

function mergeVideo(prev, next) {
  const rssLikeBackend = next.backend === 'rss' || next.backend === 'lbry' || next.backend === 'bili' || next.backend === 'peertube' || next.backend === 'soundcloud';
  const rssDowngrade = rssLikeBackend && prev.backend !== next.backend;
  return {
    id: prev.id,
    source: prev.source,
    channelId: prev.channelId,
    title: next.title || prev.title,
    publishedAt: next.publishedAt ?? prev.publishedAt,
    approxDate:
      next.publishedAt != null ? (rssDowngrade ? prev.approxDate : next.approxDate) : prev.approxDate,
    thumbnailUrl: next.thumbnailUrl ?? prev.thumbnailUrl,
    durationSeconds:
      rssDowngrade && prev.durationSeconds != null
        ? prev.durationSeconds
        : next.durationSeconds ?? prev.durationSeconds,
    viewCount: next.viewCount ?? prev.viewCount,
    kind: rssDowngrade ? prev.kind : next.kind,
    seen: prev.seen,
    seenAt: prev.seenAt,
    backend: rssDowngrade ? prev.backend : next.backend,
    fetchedAt: next.fetchedAt,
  };
}

app.post('/api/videos/seen', async (req, res) => {
  const { videoIds, seen } = req.body;
  if (!Array.isArray(videoIds) || videoIds.length === 0) return res.json({ ok: true });
  const videos = (await readJSON('videos.json')) ?? [];
  const set = new Set(videoIds);
  const now = Date.now();
  for (let i = 0; i < videos.length; i++) {
    if (set.has(videos[i].id) && videos[i].seen !== seen) {
      videos[i] = { ...videos[i], seen, seenAt: seen ? now : null };
    }
  }
  await writeJSON('videos.json', videos);
  res.json({ ok: true });
});

app.post('/api/videos/mark-all-seen', async (_req, res) => {
  const videos = (await readJSON('videos.json')) ?? [];
  const now = Date.now();
  for (let i = 0; i < videos.length; i++) {
    if (!videos[i].seen) videos[i] = { ...videos[i], seen: true, seenAt: now };
  }
  await writeJSON('videos.json', videos);
  res.json({ ok: true });
});

app.delete('/api/videos', async (_req, res) => {
  await writeJSON('videos.json', []);
  res.json({ ok: true });
});

app.post('/api/videos/prune', async (req, res) => {
  const { maxAgeDays } = req.body;
  if (maxAgeDays <= 0) return res.json({ ok: true });
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const videos = (await readJSON('videos.json')) ?? [];
  await writeJSON(
    'videos.json',
    videos.filter((v) => {
      const pub = v.publishedAt ?? v.fetchedAt;
      return pub >= cutoff;
    }),
  );
  res.json({ ok: true });
});

app.post('/api/videos/history-as-seen', async (req, res) => {
  const entries = req.body; // { videoId, source, watchedAt }[]
  if (!Array.isArray(entries) || entries.length === 0) return res.json({ matched: 0, total: 0 });
  const videos = (await readJSON('videos.json')) ?? [];
  let matched = 0;
  for (const entry of entries) {
    const key = `${entry.source}:${entry.videoId}`;
    const idx = videos.findIndex((v) => v.id === key);
    if (idx !== -1 && !videos[idx].seen) {
      matched++;
      videos[idx] = { ...videos[idx], seen: true, seenAt: entry.watchedAt };
    }
  }
  await writeJSON('videos.json', videos);
  res.json({ matched, total: entries.length });
});

// ── Tags ─────────────────────────────────────────────────────────────────────

app.get('/api/tags', async (_req, res) => {
  res.json((await readJSON('tags.json')) ?? []);
});

app.post('/api/tags', async (req, res) => {
  const tag = req.body;
  const tags = (await readJSON('tags.json')) ?? [];
  const idx = tags.findIndex((t) => t.name === tag.name);
  if (idx >= 0) tags[idx] = tag;
  else tags.push(tag);
  await writeJSON('tags.json', tags);
  res.json({ ok: true });
});

app.delete('/api/tags/:name', async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const tags = (await readJSON('tags.json')) ?? [];
  await writeJSON(
    'tags.json',
    tags.filter((t) => t.name !== name),
  );
  // cascade: remove tag from channels
  const channels = (await readJSON('channels.json')) ?? [];
  for (let i = 0; i < channels.length; i++) {
    if (channels[i].tags.includes(name)) {
      channels[i] = { ...channels[i], tags: channels[i].tags.filter((t) => t !== name) };
    }
  }
  await writeJSON('channels.json', channels);
  res.json({ ok: true });
});

app.post('/api/tags/rename', async (req, res) => {
  const { oldName, newName } = req.body;
  const tags = (await readJSON('tags.json')) ?? [];
  const idx = tags.findIndex((t) => t.name === oldName);
  if (idx === -1) return res.status(404).json({ error: 'tag not found' });
  tags[idx] = { ...tags[idx], name: newName };
  await writeJSON('tags.json', tags);
  // cascade
  const channels = (await readJSON('channels.json')) ?? [];
  for (let i = 0; i < channels.length; i++) {
    if (channels[i].tags.includes(oldName)) {
      channels[i] = {
        ...channels[i],
        tags: channels[i].tags.map((t) => (t === oldName ? newName : t)),
      };
    }
  }
  await writeJSON('channels.json', channels);
  res.json({ ok: true });
});

// ── Settings (simple key-value, stored in one file) ──────────────────────────

app.get('/api/settings', async (_req, res) => {
  res.json((await readJSON('settings.json')) ?? {});
});

app.put('/api/settings', async (req, res) => {
  await writeJSON('settings.json', req.body);
  res.json({ ok: true });
});

// ── Engine state (status / log / pending / bili-banned) ──────────────────────

app.get('/api/engine/status', async (_req, res) => {
  res.json((await readJSON('engine-status.json')) ?? null);
});

app.put('/api/engine/status', async (req, res) => {
  await writeJSON('engine-status.json', req.body);
  res.json({ ok: true });
});

app.get('/api/engine/log', async (_req, res) => {
  res.json((await readJSON('engine-log.json')) ?? []);
});

app.put('/api/engine/log', async (req, res) => {
  await writeJSON('engine-log.json', req.body);
  res.json({ ok: true });
});

app.delete('/api/engine/log', async (_req, res) => {
  await writeJSON('engine-log.json', []);
  res.json({ ok: true });
});

app.get('/api/engine/pending', async (_req, res) => {
  res.json((await readJSON('engine-pending.json')) ?? null);
});

app.put('/api/engine/pending', async (req, res) => {
  await writeJSON('engine-pending.json', req.body);
  res.json({ ok: true });
});

app.delete('/api/engine/pending', async (_req, res) => {
  await writeJSON('engine-pending.json', null);
  res.json({ ok: true });
});

app.get('/api/engine/bili-banned', async (_req, res) => {
  res.json((await readJSON('bili-banned.json')) ?? null);
});

app.put('/api/engine/bili-banned', async (req, res) => {
  await writeJSON('bili-banned.json', req.body);
  res.json({ ok: true });
});

app.delete('/api/engine/bili-banned', async (_req, res) => {
  await writeJSON('bili-banned.json', null);
  res.json({ ok: true });
});

// ── start ────────────────────────────────────────────────────────────────────

await ensureDataDir();
app.listen(PORT, () => {
  console.log(`[feedtube] data API listening on http://localhost:${PORT}`);
});

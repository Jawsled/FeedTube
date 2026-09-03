import { useMemo, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import {
  deleteChannelCascade,
  deleteTag,
  listChannels,
  listTags,
  listUntaggedChannels,
  listVideos,
  renameTag,
  setChannelTags,
  upsertChannels,
  upsertTag,
} from '../../../lib/db';
import { resolveChannel } from '../../../lib/api/resolve-channel';
import { autoCategorizeChannel } from '../../../lib/api/categorize';
import { formatRelative, sourceChannelUrl } from '../../../lib/utils';
import { SOURCE_META, detectSource } from '../../../lib/api/source';
import type { ChannelRecord, SourceKind, TagDefinition } from '../../../lib/types';
import { Avatar, EmptyState, Icon, Icons, SourcePill, useAsync, useToast } from './ui';

const TAG_COLORS = ['#f0484a', '#4ade80', '#60a5fa', '#fbbf24', '#c084fc', '#fb923c', '#38bdf8', '#f472b6'];

function TagPicker({
  channel,
  tags,
  allTags,
  onChanged,
}: {
  channel: ChannelRecord;
  tags: TagDefinition[];
  allTags: TagDefinition[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);

  const toggle = async (tagName: string) => {
    const next = channel.tags.includes(tagName)
      ? channel.tags.filter((t) => t !== tagName)
      : [...channel.tags, tagName];
    await setChannelTags(channel.id, next);
    onChanged();
  };

  if (!open) {
    return (
      <button
        class="icon-btn"
        title="Manage tags"
        onClick={() => setOpen(true)}
        style={{ position: 'relative' }}
      >
        <Icon path={Icons.tag} size={15} />
        {channel.tags.length > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--accent)',
            }}
          />
        )}
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        zIndex: 20,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: '8px 6px',
        minWidth: 160,
        boxShadow: 'var(--shadow)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '0 6px 4px', fontWeight: 600 }}>
        Assign tags
      </div>
      {allTags.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '4px 6px' }}>
          No tags yet — create one in Tag Management below
        </div>
      )}
      {allTags.map((t) => (
        <label
          key={t.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            padding: '4px 6px',
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 13,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <input
            type="checkbox"
            checked={channel.tags.includes(t.name)}
            onChange={() => void toggle(t.name)}
            style={{ accentColor: t.color }}
          />
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: t.color,
              flexShrink: 0,
            }}
          />
          {t.name}
        </label>
      ))}
      <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
        <button
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '4px 6px',
            fontSize: 12,
            color: 'var(--text-dim)',
            borderRadius: 6,
          }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function TagManagement({
  tags,
  reloadTags,
}: {
  tags: TagDefinition[];
  reloadTags: () => void;
}) {
  const toast = useToast();
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [newInterval, setNewInterval] = useState(60);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [editInterval, setEditInterval] = useState(60);

  const createTag = async () => {
    const name = newName.trim();
    if (!name) return;
    if (tags.some((t) => t.name === name)) {
      toast('Tag already exists');
      return;
    }
    await upsertTag({ name, color: newColor, refreshIntervalMin: newInterval });
    setNewName('');
    reloadTags();
    toast(`Tag "${name}" created`);
  };

  const removeTag = async (name: string) => {
    if (!confirm(`Delete tag "${name}"? Channels with this tag will keep it removed.`)) return;
    await deleteTag(name);
    reloadTags();
    toast(`Tag "${name}" deleted`);
  };

  const startEdit = (t: TagDefinition) => {
    setEditing(t.name);
    setEditName(t.name);
    setEditColor(t.color);
    setEditInterval(t.refreshIntervalMin);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditing(null);
      return;
    }
    if (trimmed !== editing && tags.some((t) => t.name === trimmed)) {
      toast('A tag with that name already exists');
      return;
    }
    if (trimmed !== editing) {
      await renameTag(editing, trimmed);
    }
    await upsertTag({ name: trimmed, color: editColor, refreshIntervalMin: editInterval });
    setEditing(null);
    reloadTags();
    toast(`Tag updated`);
  };

  const autoTagUntagged = async () => {
    const untagged = await listUntaggedChannels();
    if (untagged.length === 0) {
      toast('All channels already have tags');
      return;
    }
    toast(`Auto-tagging ${untagged.length} channel${untagged.length === 1 ? '' : 's'}…`);
    let done = 0;
    const BATCH = 8;
    for (let i = 0; i < untagged.length; i += BATCH) {
      const batch = untagged.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((ch) => autoCategorizeChannel({ id: ch.id, source: ch.source }, ch.tags.map((t) => ({ name: t })))),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) done++;
      }
      if (i + BATCH < untagged.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    reloadTags();
    if (done > 0) toast(`Tagged ${done} channel${done === 1 ? '' : 's'}`);
    else toast('Could not detect categories for any channels');
  };

  return (
    <div class="card" style={{ marginTop: 16 }}>
      <button
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          fontWeight: 600,
          fontSize: 14,
          padding: '2px 0',
        }}
        onClick={() => setExpanded((e) => !e)}
      >
        <Icon path={expanded ? Icons.x : Icons.tag} size={16} />
        Tag Management ({tags.length})
        <span style={{ flex: 1 }} />
        <span class="faint" style={{ fontWeight: 400 }}>
          {expanded ? 'collapse' : 'expand'}
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: 12 }}>
          {tags.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {tags.map((t) => (
                <div
                  key={t.name}
                  style={{
                    padding: '8px 10px',
                    background: 'var(--bg)',
                    borderRadius: 6,
                  }}
                >
                  {editing === t.name ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          autoFocus
                          value={editName}
                          onInput={(e) => setEditName((e.target as HTMLInputElement).value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitEdit();
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          style={{ flex: 1, fontWeight: 500, fontSize: 13 }}
                          placeholder="Tag name"
                        />
                        <select
                          value={editInterval}
                          onChange={(e) => setEditInterval(Number((e.target as HTMLSelectElement).value))}
                        >
                          <option value={15}>15m</option>
                          <option value={30}>30m</option>
                          <option value={60}>1h</option>
                          <option value={180}>3h</option>
                          <option value={360}>6h</option>
                          <option value={720}>12h</option>
                          <option value={1440}>24h</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {TAG_COLORS.map((c) => (
                          <button
                            key={c}
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: '50%',
                              background: c,
                              border: editColor === c ? '2px solid var(--text)' : '2px solid transparent',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                            onClick={() => setEditColor(c)}
                          />
                        ))}
                        <span style={{ flex: 1 }} />
                        <button class="btn small" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                        <button class="btn primary small" onClick={() => void commitEdit()}>
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          background: t.color,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontWeight: 500, flex: 1 }}>{t.name}</span>
                      <span class="faint">every {t.refreshIntervalMin}m</span>
                      <button class="icon-btn" title="Edit tag" onClick={() => startEdit(t)}>
                        <Icon path={Icons.edit} size={14} />
                      </button>
                      <button class="icon-btn" title="Delete tag" onClick={() => void removeTag(t.name)}>
                        <Icon path={Icons.trash} size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <button class="btn small" onClick={() => void autoTagUntagged()}>
              <Icon path={Icons.tag} size={14} /> Auto-tag untagged channels
            </button>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <input
              placeholder="Tag name"
              value={newName}
              onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createTag();
              }}
              style={{ width: 130 }}
            />
            <div style={{ display: 'flex', gap: 3 }}>
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: '50%',
                    background: c,
                    border: newColor === c ? '2px solid var(--text)' : '2px solid transparent',
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
            <select value={newInterval} onChange={(e) => setNewInterval(Number((e.target as HTMLSelectElement).value))}>
              <option value={15}>15m</option>
              <option value={30}>30m</option>
              <option value={60}>1h</option>
              <option value={180}>3h</option>
              <option value={360}>6h</option>
              <option value={720}>12h</option>
              <option value={1440}>24h</option>
            </select>
            <button class="btn primary small" disabled={!newName.trim()} onClick={() => void createTag()}>
              <Icon path={Icons.plus} size={14} /> Create
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SubscriptionsView({ onGoToImport }: { onGoToImport: () => void }) {
  const subs = useAsync(
    async () => {
      const [channels, videos, tags] = await Promise.all([listChannels(), listVideos(), listTags()]);
      const counts = new Map<string, number>();
      for (const v of videos) counts.set(v.channelId, (counts.get(v.channelId) ?? 0) + 1);
      const sorted = [...channels].sort((a, b) => a.name.localeCompare(b.name));
      return { channels: sorted, counts, tags };
    },
    [],
  );

  const toast = useToast();
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!subs.data) return [];
    let list = subs.data.channels;
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
    if (tagFilter) list = list.filter((c) => c.tags.includes(tagFilter));
    return list;
  }, [subs.data, query, tagFilter]);

  const addChannel = async () => {
    const raw = input.trim();
    if (!raw || adding) return;
    setAdding(true);
    try {
      // For PeerTube URLs, request host permission before resolving.
      const ptHost = /^https?:\/\/([^/]+)\/(?:@|c\/)/i.exec(raw)?.[1];
      if (ptHost) {
        try {
          const granted = await browser.permissions.request({ origins: [`https://${ptHost}/*`] });
          if (!granted) {
            toast(`Permission denied for ${ptHost}`);
            setAdding(false);
            return;
          }
        } catch {
          // permissions.request may fail in some contexts; continue anyway
        }
      }
      const resolved = await resolveChannel(raw);
      const existing = subs.data?.channels.find((c) => c.id === resolved.id && c.source === resolved.source);
      if (existing) {
        toast(`Already subscribed to ${existing.name}`);
        setInput('');
        return;
      }
      const name = resolved.name ?? resolved.id;
      const record: ChannelRecord = {
        id: resolved.id,
        source: resolved.source,
        name,
        avatarUrl: resolved.avatarUrl,
        tags: [],
        addedAt: Date.now(),
        lastFetchedAt: null,
        lastVideosFetchedAt: null,
        lastShortsFetchedAt: null,
        lastLiveFetchedAt: null,
        lastError: null,
        urlSlug: resolved.urlSlug ?? null,
      };
      await upsertChannels([record]);
      if (resolved.source === 'youtube') {
        autoCategorizeChannel({ id: record.id, source: 'youtube' }, []).then((cat) => {
          if (cat) {
            toast(`Auto-tagged as "${cat}"`);
            subs.reload();
          }
        });
      } else {
        toast(`Added ${name} from ${SOURCE_META[resolved.source].label}`);
      }
      void browser.runtime.sendMessage({ type: 'cmd/start-refresh', channelIds: [record.id], force: true });
      toast(`Added ${name}`);
      setInput('');
      subs.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const removeChannel = async (ch: ChannelRecord) => {
    if (removing) return;
    if (!confirm(`Unsubscribe from ${ch.name}?`)) return;
    setRemoving(ch.id);
    try {
      await deleteChannelCascade(ch.id);
      toast(`Removed ${ch.name}`);
      subs.reload();
    } finally {
      setRemoving(null);
    }
  };

  const refreshOne = (ch: ChannelRecord) => {
    void browser.runtime.sendMessage({ type: 'cmd/start-refresh', channelIds: [ch.id], force: true });
    toast(`Refreshing ${ch.name}…`);
  };

  if (subs.loading) {
    return (
      <div class="empty-state">
        <div class="spinner" />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          placeholder="YouTube / Odysee / Bilibili / PeerTube / SoundCloud URL, handle or ID"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addChannel();
          }}
          style={{ flex: 1 }}
        />
        <button class="btn primary" disabled={adding || !input.trim()} onClick={() => void addChannel()}>
          {adding ? <span class="spinner" /> : <Icon path={Icons.plus} size={15} />}
          Add
        </button>
      </div>

      <TagManagement tags={subs.data?.tags ?? []} reloadTags={() => subs.reload()} />

      {(subs.data?.channels.length ?? 0) === 0 ? (
        <EmptyState
          icon={<Icon path={Icons.users} size={44} />}
          title="No subscriptions yet"
          hint="Add channels above, or import your subscriptions from NewPipe, Google Takeout or an OPML file."
        >
          <button class="btn" onClick={onGoToImport}>
            <Icon path={Icons.io} /> Import subscriptions
          </button>
        </EmptyState>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span class="muted">
              {subs.data!.channels.length} channel{subs.data!.channels.length === 1 ? '' : 's'}
            </span>
            <div style={{ flex: 1 }} />
            {subs.data!.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <button
                  class={`chip${tagFilter === null ? ' active' : ''}`}
                  onClick={() => setTagFilter(null)}
                >
                  All
                </button>
                {subs.data!.tags.map((t) => (
                  <button
                    key={t.name}
                    class={`chip${tagFilter === t.name ? ' active' : ''}`}
                    onClick={() => setTagFilter(tagFilter === t.name ? null : t.name)}
                    style={tagFilter === t.name ? { borderColor: t.color, color: t.color, background: `${t.color}22` } : {}}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: t.color,
                        marginRight: 4,
                      }}
                    />
                    {t.name}
                  </button>
                ))}
              </div>
            )}
            <input
              type="search"
              placeholder="Filter…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              style={{ width: 180 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((ch) => (
              <div
                key={ch.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '9px 12px',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  position: 'relative',
                }}
              >
                <Avatar src={ch.avatarUrl} name={ch.name} size={34} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <a
                      href={`#/feed?channel=${encodeURIComponent(ch.id)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        location.hash = `#/feed?channel=${encodeURIComponent(ch.id)}`;
                      }}
                      title={`Open ${ch.name} in FeedTube`}
                      style={{ fontWeight: 600, textDecoration: 'none', cursor: 'pointer' }}
                    >
                      {ch.name}
                    </a>
                    <SourcePill source={ch.source} />
                    {ch.tags.map((tagName) => {
                      const tag = subs.data!.tags.find((t) => t.name === tagName);
                      return tag ? (
                        <span
                          key={tagName}
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 999,
                            background: `${tag.color}22`,
                            color: tag.color,
                            fontWeight: 600,
                            lineHeight: '16px',
                          }}
                        >
                          {tagName}
                        </span>
                      ) : null;
                    })}
                  </div>
                  <div class="faint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>{subs.data!.counts.get(ch.id) ?? 0} cached videos</span>
                    {ch.lastVideosFetchedAt && <span>• fetched {formatRelative(ch.lastVideosFetchedAt)}</span>}
                    {ch.lastError && (
                      <span class="error-text" title={ch.lastError}>
                        ⚠ {ch.lastError}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ position: 'relative' }}>
                  <TagPicker
                    channel={ch}
                    tags={ch.tags.map((n) => subs.data!.tags.find((t) => t.name === n)).filter(Boolean) as TagDefinition[]}
                    allTags={subs.data!.tags}
                    onChanged={() => subs.reload()}
                  />
                </div>
                <a
                  class="icon-btn"
                  title={`Open on ${SOURCE_META[ch.source].label}`}
                  href={sourceChannelUrl(ch.source, ch.id)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon path={Icons.external} size={15} />
                </a>
                <button class="icon-btn" title="Refresh now" onClick={() => refreshOne(ch)}>
                  <Icon path={Icons.refresh} size={15} />
                </button>
                <button
                  class="icon-btn"
                  title="Unsubscribe"
                  onClick={() => void removeChannel(ch)}
                  disabled={removing === ch.id}
                >
                  <Icon path={Icons.trash} size={15} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

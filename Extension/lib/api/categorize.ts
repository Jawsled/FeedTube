import { detectChannelCategory } from './rss';
import { listTags, upsertTag, setChannelTags } from '../db';
import type { ChannelRecord } from '../types';

const CATEGORY_COLORS: Record<string, string> = {
  Music: '#c084fc',
  Gaming: '#4ade80',
  Sports: '#60a5fa',
  Entertainment: '#fb923c',
  'Film & Animation': '#f472b6',
  'Autos & Vehicles': '#38bdf8',
  'Howto & Style': '#fbbf24',
  News: '#f87171',
  'Pets & Animals': '#4ade80',
  'Travel & Events': '#38bdf8',
  'Science & Technology': '#60a5fa',
  Education: '#c084fc',
  'Nonprofits & Activism': '#fb923c',
  Comedy: '#fbbf24',
};

const DEFAULT_COLORS = ['#f0484a', '#4ade80', '#60a5fa', '#fbbf24', '#c084fc', '#fb923c', '#38bdf8', '#f472b6'];

export async function autoCategorizeChannel(
  channel: { id: string; source: ChannelRecord['source'] } | string,
  existingTags: { name: string }[],
): Promise<string | null> {
  const ch = typeof channel === 'string' ? { id: channel, source: 'youtube' as const } : channel;
  if (ch.source !== 'youtube') return null;
  let category: string | null = null;
  try {
    category = await detectChannelCategory(ch.id);
  } catch {
    return null;
  }
  if (!category) return null;

  const alreadyHas = existingTags.some((t) => t.name === category);
  if (!alreadyHas) {
    const existingTagNames = (await listTags()).map((t) => t.name);
    if (!existingTagNames.includes(category)) {
      const color = CATEGORY_COLORS[category] ?? DEFAULT_COLORS[existingTagNames.length % DEFAULT_COLORS.length];
      await upsertTag({ name: category, color, refreshIntervalMin: 60 });
    }
    const currentTags = existingTags.map((t) => t.name);
    await setChannelTags(ch.id, [...currentTags, category]);
  }
  return category;
}

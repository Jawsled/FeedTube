import type { ImportedChannel } from '../types';
import { dedupeChannels } from './common';

interface FreeTubeSubscription {
  id: string;
  name: string;
  thumbnail?: string;
}

interface FreeTubeDb {
  _id?: string;
  subscriptions?: FreeTubeSubscription[];
}

function robustJsonParse(text: string): unknown {
  text = text.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* browser file.text() may append or corrupt trailing bytes;
       find the end of the top-level JSON value and retry */
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (escape) { escape = false; continue; }
      if (c === 92 /* \ */) { escape = true; continue; }
      if (c === 34 /* " */) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === 123 /* { */ || c === 91 /* [ */) depth++;
      else if (c === 125 /* } */ || c === 93 /* ] */) {
        depth--;
        if (depth === 0) {
          return JSON.parse(text.slice(0, i + 1));
        }
      }
    }
    throw new Error('Could not parse FreeTube JSON');
  }
}

export function isFreeTubeDb(text: string): boolean {
  try {
    const j = robustJsonParse(text) as Record<string, unknown>;
    return (
      typeof j === 'object' &&
      j !== null &&
      '_id' in j &&
      j._id === 'allChannels' &&
      Array.isArray(j.subscriptions)
    );
  } catch {
    return false;
  }
}

export function parseFreeTubeDb(text: string): ImportedChannel[] {
  const data = robustJsonParse(text) as FreeTubeDb;
  if (!Array.isArray(data.subscriptions)) {
    throw new Error('Invalid FreeTube DB: missing subscriptions array');
  }

  const items: ImportedChannel[] = [];
  for (const sub of data.subscriptions) {
    if (!sub.id || typeof sub.id !== 'string') continue;
    items.push({
      id: sub.id,
      url: `https://www.youtube.com/channel/${sub.id}`,
      name: sub.name ?? null,
      avatarUrl: sub.thumbnail ?? null,
    });
  }
  return dedupeChannels(items);
}

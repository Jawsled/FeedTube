// Local-platform replacement for the WXT `browser` API surface that this app
// actually uses: storage.local get/set/remove, storage.onChanged listeners,
// and a fetch helper that routes cross-origin requests through the local
// relay server (replacing declarativeNetRequest header rewriting + host
// permissions from the extension).
//
// Data is now persisted to JSON files via the backend API server instead of
// browser localStorage/IndexedDB, so different browser profiles share the
// same data.

export interface StorageChange {
  oldValue: unknown;
  newValue: unknown;
}

type Changes = Record<string, StorageChange>;
type ChangeListener = (changes: Changes, area: string) => void;

const BUS_NAME = 'feedtube-bus';

// In-memory fallback so the same modules can run under Node (smoke tests).
const memStore = new Map<string, unknown>();

function isBrowserEnv(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

// ── API-backed storage ───────────────────────────────────────────────────────

// Map generic storage keys to specific backend API endpoints.
const KEY_TO_ENDPOINT: Record<string, string> = {
  settings: '/api/settings',
  engineStatus: '/api/engine/status',
  engineLog: '/api/engine/log',
  enginePending: '/api/engine/pending',
  biliWebBannedUntil: '/api/engine/bili-banned',
};

async function apiGet(key: string): Promise<unknown> {
  const endpoint = KEY_TO_ENDPOINT[key];
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function apiSet(key: string, value: unknown): Promise<void> {
  const endpoint = KEY_TO_ENDPOINT[key];
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch {
    /* best-effort */
  }
}

async function apiRemove(key: string): Promise<void> {
  const endpoint = KEY_TO_ENDPOINT[key];
  if (!endpoint) return;
  try {
    await fetch(endpoint, { method: 'DELETE' });
  } catch {
    /* best-effort */
  }
}

async function readKeys(keys: string[]): Promise<Record<string, unknown>> {
  if (!isBrowserEnv()) {
    // Node / test environment: read from memStore
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (memStore.has(k)) out[k] = memStore.get(k);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const val = await apiGet(k);
    if (val != null) out[k] = val;
  }
  return out;
}

const listeners = new Set<ChangeListener>();
let bus: BroadcastChannel | null = null;

function getBus(): BroadcastChannel | null {
  if (bus) return bus;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    bus = new BroadcastChannel(BUS_NAME);
    bus.onmessage = (e: MessageEvent) => {
      const data = e.data as { t?: string; changes?: Changes } | null;
      if (data?.t === 'storage' && data.changes) {
        for (const cb of listeners) cb(data.changes, 'local');
      }
    };
  } catch {
    bus = null;
  }
  return bus;
}

function notifyLocal(changes: Changes): void {
  for (const cb of listeners) cb(changes, 'local');
  const b = getBus();
  if (b) {
    try {
      b.postMessage({ t: 'storage', changes });
    } catch {
      /* ignore */
    }
  }
}

export const browser = {
  storage: {
    local: {
      async get(keys?: string | string[]): Promise<Record<string, unknown>> {
        if (keys == null) {
          // Return all known keys
          return readKeys(Object.keys(KEY_TO_ENDPOINT));
        }
        const list = Array.isArray(keys) ? keys : [keys];
        return readKeys(list);
      },
      async set(obj: Record<string, unknown>): Promise<void> {
        const changes: Changes = {};
        for (const [k, v] of Object.entries(obj)) {
          const oldValue = (await apiGet(k)) ?? undefined;
          if (isBrowserEnv()) {
            await apiSet(k, v);
          } else {
            memStore.set(k, v);
          }
          changes[k] = { oldValue, newValue: v };
        }
        notifyLocal(changes);
      },
      async remove(keys: string | string[]): Promise<void> {
        const list = Array.isArray(keys) ? keys : [keys];
        const changes: Changes = {};
        for (const k of list) {
          const oldValue = (await apiGet(k)) ?? undefined;
          if (isBrowserEnv()) {
            await apiRemove(k);
          } else {
            memStore.delete(k);
          }
          changes[k] = { oldValue, newValue: undefined };
        }
        notifyLocal(changes);
      },
    },
    onChanged: {
      addListener(cb: ChangeListener): void {
        listeners.add(cb);
      },
      removeListener(cb: ChangeListener): void {
        listeners.delete(cb);
      },
    },
  },
};

// Routes cross-origin requests through the local relay server so we get the
// same effective behavior as the extension's declarativeNetRequest rules +
// host permissions (the relay sets Origin/Referer/Accept per upstream host).
// Same-origin and Node-context calls go straight to fetch.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!isBrowserEnv()) return fetch(url, init);
  const u = new URL(url);
  if (u.origin === location.origin) return fetch(url, init);
  return fetch(`/proxy?url=${encodeURIComponent(u.toString())}`, init);
}

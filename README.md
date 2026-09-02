# FeedTube

A proof of concept browser extension and web-app for tracking channel uploads across YouTube, Odysee, Bilibili, PeerTube, and SoundCloud. Videos always open on the native platform in a normal browser tab. Inspired by FreeTube, Newpipe and Grayjay.

## Why I made this

I love using alternative clients such as Freetube, Newpipe, and Grayjay, however they face too much issues with playback due to changes on YouTube side, making them difficult to use. 

This project is a proof of concept, that if you just have a tracker, then leave the player to a browser, not only does it allow more flexibility for users, but I avoid having to keep dealing with playback changes, and users are free to combine it with any other extension or surrounding software as they see fit.

## What this is not

- this is ot an ad blocker
- This does not offer download capabilities
- This does not deal with any playback

## Supported Platforms

| Platform | Method |
|---|---|
| YouTube | InnerTube API, RSS, optional Invidious fallback |
| Odysee | RSS via lbry.tv |
| Bilibili | Web API with WBI request signing |
| PeerTube | Atom RSS + REST API (federated instances supported) |
| SoundCloud | v2 web API

## Features

**Feed Engine**
- Configurable background refresh (off, 15min, 30min, 1h, 3h, 6h)
- Batch processing with concurrency limits and rate limiting
- Videos, shorts, and live streams handled separately
- Automatic pruning of old videos (30, 90, 180 days, or keep everything)
- MV3 service worker survival with auto-resume on restart

**Dashboard UI**
- Full-page SPA with collapsible sidebar
- Feed view with source and tag filtering
- Subscription management with bulk tag assignment
- Watched video history
- Settings panel with per-platform toggles
- Dark and light theme support

**Tags**
- Colored tag definitions with per-tag refresh intervals
- Auto-categorization of YouTube channels by RSS category
- Channels can belong to multiple tags

**YouTube Content Script**
- Replaces YouTube's subscribe button with a "+ FeedTube" overlay
- Lets you assign tags before subscribing directly from YouTube

**Import and Export**

| Format | Import | Export |
|---|---|---|
| FeedTube JSON (with tags) | Yes | Yes |
| NewPipe database (.db) | Yes | No |
| NewPipe JSON | Yes | Yes |
| FreeTube subscriptions (.db) | Yes | No |
| FreeTube watch history (.db) | Yes | Yes |
| Google Takeout JSON/CSV | Yes | No |
| YouTube Takeout history (.json) | Yes | No |
| OPML | Yes | Yes |
| Grayjay ZIP | Yes | Yes |

---

# Browser Extension

## Build

```
npm run build          # Chrome (Manifest V3)
npm run build:firefox  # Firefox
```
## Development

```
npm run dev          # Chrome dev mode with hot reload
npm run dev:firefox  # Firefox dev mode
```

## Install

Just install like any other unpacked extension. 

## Tech Stack

- **WXT** - browser extension framework (Manifest V3)
- **Preact** - UI rendering
- **TypeScript** - strict typing
- **IndexedDB** (via `idb`) - local storage for channels, videos, tags
- **sql.js** - SQLite in-browser for NewPipe/FreeTube database imports
- **fast-xml-parser** - RSS/Atom/OPML parsing
- **JSZip** - Grayjay ZIP import/export
- **spark-md5** - Bilibili WBI signature hashing

## Storage

All data stays local in your browser:

- **IndexedDB** (`feedtube` database) - channels, videos, tags
- **browser.storage.local** - settings, engine status, refresh queue

## Permissions

The extension requests these permissions:

- `storage` - IndexedDB and local settings
- `alarms` - periodic background refresh
- `declarativeNetRequest` - header rewriting for YouTube API and SoundCloud CORS
- `offscreen` - SoundCloud fetches in page context

Host permissions cover the API and web origins for each supported platform. Optional host permissions allow resolving arbitrary channel URLs.

---

# Local  Web-app

## Quick Start

```bash
npm install
npm run dev
```

Opens at **http://localhost:5199**. The data API runs on port 5198 (proxied through Vite automatically).


## Architecture

```
Browser (localhost:5199)          Express (localhost:5198)
┌──────────────────────┐         ┌──────────────────────┐
│  Preact SPA          │  /api/* │  REST API            │
│  ├─ FeedView         │ ──────> │  ├─ channels CRUD    │
│  ├─ SubscriptionsView│         │  ├─ videos merge     │
│  ├─ HistoryView      │         │  ├─ tags CRUD        │
│  └─ SettingsView     │         │  ├─ settings         │
│                      │         │  └─ engine state     │
│  api-client.ts       │         │                      │
│  db.ts (API-backed)  │         │  data/*.json files   │
│  platform.ts         │         │                      │
└──────────────────────┘         └──────────────────────┘
        │
        │ /proxy?url=...
        v
   External APIs (YouTube, Bilibili, etc.)
```

### Data Storage

All data is stored as JSON files in the `data/` directory at the project root:

| File | Contents |
|------|----------|
| `channels.json` | Subscribed channel records |
| `videos.json` | Cached video records |
| `tags.json` | Tag definitions |
| `settings.json` | App configuration |
| `engine-status.json` | Refresh engine state |
| `engine-log.json` | Activity log |
| `engine-pending.json` | Interrupted refresh queue |

Since data lives on disk, multiple browser profiles (or machines sharing the same directory) see the same subscriptions and history.

### Vite Proxy

Cross-origin requests to external APIs are routed through a Vite dev server middleware (`/proxy?url=<target>`) that strips the `Origin` header and sets appropriate `Referer` values — replacing the browser extension's `host_permissions` and `declarativeNetRequest` rules.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start data API + Vite dev server |
| `npm run server` | Start only the data API |
| `npm run build` | Production build to `dist/` |
| `npm run compile` | TypeScript type check |
| `npm test` | Run smoke + IO tests |

---

## Acknowledgement
Inspiration and technical implementation:
[Freetube](https://github.com/FreeTubeApp/FreeTube), [Grayjay plugins](https://grayjay.app/), [PipePipe](https://github.com/InfinityLoop1308/PipePipe)
Thank you for your amazing work!

## Disclosure on LLM use
This proof of concept was written with assist from Qwen3.8 27B.

# FeedTube

A prrof of concept browser extension for tracking channel uploads across YouTube, Odysee, Bilibili, PeerTube, and SoundCloud. Videos always open on the native platform in a normal browser tab. Inspired by FreeTube, Newpipe and Grayjay.

## Why I made this

I love using alternative clients such as Freetube, Newpipe, and Grayjay, however they face too much issues with playback due to changes on YouTube side, making them difficult to use. 

This project is a proof of concept, that if you just have a tracker, then leave the player to a browser, not only does it allow more flexibility for users, but I avoid having to keep dealing with playback changes, and users are free to combine it with any other extension or surrounding software as they see fit.

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

## What this is not

- this extension is not an ad blocker
- This extension does not offer download capabilities
- This extension does not deal with any playback
- This extension does not deal with any playback
- This extension does not deal with any playback


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

## Acknowledgement
Inspiration and technical implementation:
[Freetube](https://github.com/FreeTubeApp/FreeTube), [Grayjay plugins](https://grayjay.app/), [PipePipe](https://github.com/InfinityLoop1308/PipePipe)
Thank you for your amazing work!

## Disclosure on LLM use
This proof of concept was written with assist from Qwen3.8 27B.


import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'FeedTube',
    description: 'Track channel uploads on YouTube, Odysee, Bilibili, PeerTube, and SoundCloud.',
    permissions: [
      'storage',
      'alarms',
      'declarativeNetRequest',
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://api.odysee.com/*',
      'https://odysee.com/*',
      'https://lbry.tv/*',
      'https://api.bilibili.com/*',
      'https://app.bilibili.com/*',
      'https://www.bilibili.com/*',
      'https://space.bilibili.com/*',
      'https://b23.tv/*',
      'https://peertube.tv/*',
      'https://soundcloud.com/*',
      'https://m.soundcloud.com/*',
      'https://a-v2.sndcdn.com/*',
      'https://api-v2.soundcloud.com/*',
      'https://feeds.soundcloud.com/*',
    ],
    optional_host_permissions: ['https://*/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    action: {
      default_icon: {
        16: '/icon/16.png',
        32: '/icon/32.png',
      },
      default_title: 'FeedTube',
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'feedtube@jawsled.dev',
              strict_min_version: '128.0',
              data_collection_permissions: { required: ['none' as const] },
            },
          },
          optional_permissions: ['https://*/*'],
        }
      : {}),
  }),
});

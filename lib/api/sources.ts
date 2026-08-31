import './youtube';
import './odysee';
import './bilibili';
import './peertube';
import './soundcloud';

export { detectSource, getSource, registerSource, SOURCE_META, listSourceKinds, ALL_SOURCE_KINDS } from './source';
export type { SourceKind, SourceMeta, SourceAdapter, SourceFetchResult, ResolvedChannel } from './source';
export {
  youtubeAdapter,
  browseChannel,
  parseChannelMeta,
  parseChannelVideos,
  INNERTUBE_CLIENT_VERSION,
} from './youtube';
export type { BrowseTab } from './youtube';
export { odyseeAdapter } from './odysee';
export { bilibiliAdapter } from './bilibili';
export { peertubeAdapter } from './peertube';
export { soundcloudAdapter } from './soundcloud';

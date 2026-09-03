import './sources';
import { detectSource, getSource, type ResolvedChannel, type SourceKind } from './source';

export interface ResolvedChannelWithSource {
  id: string;
  source: SourceKind;
  name: string | null;
  avatarUrl: string | null;
  urlSlug?: string | null;
}

export async function resolveChannel(
  rawInput: string,
  signal?: AbortSignal,
): Promise<ResolvedChannelWithSource> {
  const input = rawInput.trim();
  if (input.length === 0) throw new Error('Empty channel input');
  const kind = detectSource(input);
  if (!kind) {
    throw new Error(
      'Could not detect a supported platform. Try a YouTube URL/handle, odysee.com URL, space.bilibili.com URL, a PeerTube account URL, or a soundcloud.com URL/handle.',
    );
  }
  const resolved: ResolvedChannel = await getSource(kind).resolveChannel(input, signal);
  return {
    id: resolved.id,
    source: kind,
    name: resolved.name,
    avatarUrl: resolved.avatarUrl,
    urlSlug: resolved.urlSlug ?? null,
  };
}

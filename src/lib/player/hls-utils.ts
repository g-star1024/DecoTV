export type PlaybackStreamType = 'hls' | 'mp4' | 'flv' | 'unknown';

export type PlaybackStrategy =
  | 'direct'
  | 'manifest-proxy'
  | 'asset-proxy'
  | 'full-proxy'
  | 'native';

export type PlaybackProxyMode = 'smart' | 'direct' | 'proxy' | 'off';

export interface HlsVariant {
  uri: string;
  bandwidth?: number;
  resolution?: string;
  width?: number;
  height?: number;
  codecs?: string;
}

export interface HlsKeyInfo {
  method?: string;
  uri?: string;
  resolvedUri?: string;
}

export interface HlsMapInfo {
  uri?: string;
  resolvedUri?: string;
}

export interface ParsedHlsPlaylist {
  isMaster: boolean;
  variants: HlsVariant[];
  firstSegment?: string;
  firstSegmentResolved?: string;
  key?: HlsKeyInfo;
  map?: HlsMapInfo;
  targetDuration?: number;
}

export interface PlaybackHealthResult {
  ok: boolean;
  playable: boolean;
  recommendedStrategy: Exclude<PlaybackStrategy, 'full-proxy' | 'native'>;
  source?: string;
  urlType: PlaybackStreamType;
  manifest?: {
    ok: boolean;
    status?: number;
    contentType?: string;
    size?: number;
    finalUrl?: string;
    isMaster?: boolean;
    selectedVariant?: HlsVariant;
    targetDuration?: number;
    reason?: string;
  };
  key?: {
    present: boolean;
    ok?: boolean;
    status?: number;
    size?: number;
    reason?: string;
  };
  firstSegment?: {
    ok: boolean;
    status?: number;
    contentType?: string;
    contentLength?: number;
    acceptRanges?: string;
    timeToFirstByteMs?: number;
    firstChunkBytes?: number;
    reason?: string;
  };
  cors?: {
    manifestReadable?: boolean;
    segmentReadable?: boolean;
    checkedInBrowser?: boolean;
    reason?: string;
  };
  timings?: Record<string, number>;
  reason?: string;
  suggestions: string[];
  warnings?: string[];
  nestedProxy?: boolean;
  score?: number;
  grade?: 'A' | 'B' | 'C' | 'D';
  debug?: Record<string, unknown>;
}

export const DEFAULT_ANDROID_TV_UA =
  'Mozilla/5.0 (Linux; Android 10; AndroidTV) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function isHlsUrl(url: string): boolean {
  if (!url) return false;
  return (
    /\.m3u8(?:$|[?#])/i.test(url) ||
    /\/m3u8(?:$|[/?#-])/i.test(url) ||
    /\/api\/proxy\/m3u8(?:$|[/?#-])/i.test(url)
  );
}

export function isMp4Url(url: string): boolean {
  if (!url) return false;
  return /\.mp4(?:$|[?#])/i.test(url);
}

export function isFlvUrl(url: string): boolean {
  if (!url) return false;
  return /\.flv(?:$|[?#])/i.test(url);
}

export function isLikelyM3U8Content(
  contentType: string | null | undefined,
  url = '',
): boolean {
  const lower = (contentType || '').toLowerCase();
  return (
    lower.includes('mpegurl') ||
    lower.includes('vnd.apple.mpegurl') ||
    lower.includes('application/x-mpegurl') ||
    lower.includes('audio/mpegurl') ||
    lower.includes('octet-stream') ||
    isHlsUrl(url)
  );
}

export function inferPlaybackType(
  url: string,
  contentType?: string | null,
): PlaybackStreamType {
  const lowerType = (contentType || '').toLowerCase();
  if (isLikelyM3U8Content(contentType, url)) return 'hls';
  if (lowerType.includes('video/mp4') || isMp4Url(url)) return 'mp4';
  if (lowerType.includes('flv') || isFlvUrl(url)) return 'flv';
  return 'unknown';
}

export function sanitizeEpisodeUrl(rawUrl: string): string {
  return (rawUrl || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, '');
}

export function resolveUrl(baseUrl: string, value: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function getPlaylistBaseUrl(finalUrl: string): string {
  try {
    return new URL('.', finalUrl).toString();
  } catch {
    const idx = finalUrl.lastIndexOf('/');
    return idx >= 0 ? finalUrl.slice(0, idx + 1) : finalUrl;
  }
}

export function unwrapDecoProxyUrl(rawUrl: string): {
  url: string;
  referer?: string;
  wasProxy: boolean;
  proxyPath?: string;
} {
  const sanitized = sanitizeEpisodeUrl(rawUrl);
  try {
    const base =
      typeof window !== 'undefined' ? window.location.origin : 'http://local';
    const parsed = new URL(sanitized, base);
    const isDecoProxy =
      parsed.pathname === '/api/proxy/m3u8' ||
      parsed.pathname === '/api/proxy/m3u8-filter' ||
      parsed.pathname === '/api/proxy/m3u8-asset' ||
      parsed.pathname === '/api/proxy/segment' ||
      parsed.pathname === '/api/proxy/key';
    const upstream = parsed.searchParams.get('url');
    if (isDecoProxy && upstream) {
      return {
        url: sanitizeEpisodeUrl(upstream),
        referer: parsed.searchParams.get('referer') || undefined,
        wasProxy: true,
        proxyPath: parsed.pathname,
      };
    }
  } catch {
    // Fall through to the sanitized input.
  }

  return { url: sanitized, wasProxy: false };
}

export function hasSuspiciousUrlEncoding(rawUrl: string): string[] {
  const warnings: string[] = [];
  if (!rawUrl || rawUrl.trim() !== rawUrl) warnings.push('url-whitespace');
  if (/\\u0026/i.test(rawUrl)) warnings.push('escaped-ampersand');
  if (/\$/.test(rawUrl)) warnings.push('mac-cms-separator-leftover');
  if (/\s/.test(rawUrl.trim())) warnings.push('url-contains-space');
  return warnings;
}

function parseAttributeList(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  }
  return result;
}

function parseResolution(value?: string): {
  resolution?: string;
  width?: number;
  height?: number;
} {
  if (!value) return {};
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) return { resolution: value };
  const width = Number(match[1]);
  const height = Number(match[2]);
  return {
    resolution: value,
    width: Number.isFinite(width) ? width : undefined,
    height: Number.isFinite(height) ? height : undefined,
  };
}

export function parseHlsPlaylist(
  content: string,
  baseUrl: string,
): ParsedHlsPlaylist {
  const lines = content.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  let firstSegment: string | undefined;
  let key: HlsKeyInfo | undefined;
  let map: HlsMapInfo | undefined;
  let targetDuration: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      const duration = Number(line.slice('#EXT-X-TARGETDURATION:'.length));
      if (Number.isFinite(duration)) targetDuration = duration;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      key = {
        method: attrs.METHOD,
        uri: attrs.URI,
        resolvedUri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : undefined,
      };
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      map = {
        uri: attrs.URI,
        resolvedUri: attrs.URI ? resolveUrl(baseUrl, attrs.URI) : undefined,
      };
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next) continue;
        if (!next.startsWith('#')) {
          uri = next;
          i = j;
        }
        break;
      }
      const resolution = parseResolution(attrs.RESOLUTION);
      variants.push({
        uri: uri ? resolveUrl(baseUrl, uri) : '',
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : undefined,
        codecs: attrs.CODECS,
        ...resolution,
      });
      continue;
    }

    if (!line.startsWith('#') && !firstSegment) {
      firstSegment = line;
    }
  }

  return {
    isMaster: variants.length > 0,
    variants,
    firstSegment,
    firstSegmentResolved: firstSegment
      ? resolveUrl(baseUrl, firstSegment)
      : undefined,
    key,
    map,
    targetDuration,
  };
}

export function chooseDefaultHlsVariant(
  variants: HlsVariant[],
): HlsVariant | undefined {
  if (!variants.length) return undefined;
  const scored = variants
    .filter((variant) => variant.uri)
    .map((variant, index) => {
      const height = variant.height || 0;
      const bandwidth = variant.bandwidth || 0;
      const targetHeight =
        height >= 720 && height <= 1080
          ? 100
          : height > 1080
            ? Math.max(20, 90 - (height - 1080) / 40)
            : height / 12;
      const bitratePenalty = bandwidth > 10_000_000 ? 15 : 0;
      return {
        variant,
        index,
        score:
          targetHeight + Math.min(bandwidth / 500_000, 20) - bitratePenalty,
      };
    });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.variant || variants[0];
}

export function scorePlaybackHealth(
  health: Pick<
    PlaybackHealthResult,
    'manifest' | 'key' | 'firstSegment' | 'cors' | 'playable' | 'nestedProxy'
  >,
): { score: number; grade: 'A' | 'B' | 'C' | 'D' } {
  let score = 0;

  if (health.firstSegment?.ok) {
    score += 40;
    const ttfb = health.firstSegment.timeToFirstByteMs || 0;
    if (ttfb > 0) {
      if (ttfb <= 800) score += 30;
      else if (ttfb <= 2000) score += 24;
      else if (ttfb <= 5000) score += 16;
      else score += 8;
    } else {
      score += 12;
    }
  }

  if (health.manifest?.ok) score += 15;
  if (!health.key?.present || health.key.ok) score += 10;
  if (health.cors?.manifestReadable) score += 5;
  if (health.playable && score < 65) score = 65;
  if (health.nestedProxy) score -= 8;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 45 ? 'C' : 'D';
  return { score, grade };
}

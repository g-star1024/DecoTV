import type { ApiSite } from '@/lib/config';
import {
  fetchWithValidatedRedirects,
  normalizeHeaderUrl,
  validateProxyTargetUrl,
} from '@/lib/proxy-security';

import {
  chooseDefaultHlsVariant,
  DEFAULT_ANDROID_TV_UA,
  getPlaylistBaseUrl,
  hasSuspiciousUrlEncoding,
  inferPlaybackType,
  isHlsUrl,
  parseHlsPlaylist,
  PlaybackHealthResult,
  PlaybackStrategy,
  PlaybackStreamType,
  resolveUrl,
  sanitizeEpisodeUrl,
  scorePlaybackHealth,
  unwrapDecoProxyUrl,
} from './hls-utils';

export interface PlaybackHealthInput {
  source?: string;
  sourceConfig?: Partial<ApiSite>;
  episodeUrl: string;
  strategy?: PlaybackStrategy | 'smart';
  requestOrigin?: string;
  userAgent?: string;
  referer?: string;
  title?: string;
  episodeIndex?: number;
}

const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function getHealthTimeoutMs(sourceConfig?: Partial<ApiSite>): number {
  const sourceTimeout = Number(sourceConfig?.timeoutMs);
  if (Number.isFinite(sourceTimeout) && sourceTimeout > 0) {
    return sourceTimeout;
  }
  return Number(process.env.PLAYBACK_HEALTH_TIMEOUT_MS) || 8000;
}

function shouldTestFirstSegment(): boolean {
  const flag = process.env.PLAYBACK_FIRST_SEGMENT_TEST;
  return flag === undefined || flag === 'true' || flag === '1';
}

function getHeaderRecord(headers?: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([key, value]) => [key, String(value)]),
  );
}

export function buildPlaybackRequestHeaders(input: {
  url: string;
  sourceConfig?: Partial<ApiSite>;
  userAgent?: string;
  referer?: string;
  range?: string;
}): Record<string, string> {
  const sourceHeaders = getHeaderRecord(input.sourceConfig?.headers);
  const headers: Record<string, string> = {
    Accept: '*/*',
    'User-Agent':
      sourceHeaders['User-Agent'] ||
      sourceHeaders['user-agent'] ||
      input.sourceConfig?.ua ||
      input.userAgent ||
      DEFAULT_ANDROID_TV_UA,
    ...sourceHeaders,
  };

  const explicitReferer = normalizeHeaderUrl(
    input.referer || input.sourceConfig?.referer,
  );
  let inferredReferer: string | undefined;
  try {
    inferredReferer = new URL(input.url).origin + '/';
  } catch {
    inferredReferer = undefined;
  }

  const referer = explicitReferer || inferredReferer;
  if (referer && !headers.Referer && !headers.referer) {
    headers.Referer = referer;
  }

  const explicitOrigin =
    input.sourceConfig?.origin ||
    (() => {
      try {
        return referer ? new URL(referer).origin : undefined;
      } catch {
        return undefined;
      }
    })();
  if (explicitOrigin && !headers.Origin && !headers.origin) {
    headers.Origin = explicitOrigin;
  }

  if (input.range) {
    headers.Range = input.range;
  }

  return headers;
}

async function readTextWithLimit(
  response: Response,
  maxBytes = MAX_PLAYLIST_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('playlist-too-large');
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('playlist-too-large');
    }
    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function isHtmlPayload(text: string, contentType: string): boolean {
  const trimmed = text.trimStart().slice(0, 100).toLowerCase();
  return (
    contentType.toLowerCase().includes('text/html') ||
    trimmed.startsWith('<!doctype html') ||
    trimmed.startsWith('<html')
  );
}

function parseContentLength(headers: Headers): number | undefined {
  const value = Number(headers.get('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function fetchPlaylist(input: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{
  response: Response;
  text: string;
  durationMs: number;
}> {
  await validateProxyTargetUrl(input.url);
  const startedAt = Date.now();
  const response = await fetchWithValidatedRedirects(
    input.url,
    {
      cache: 'no-store',
      headers: input.headers,
      method: 'GET',
    },
    { timeoutMs: input.timeoutMs, maxRedirects: MAX_REDIRECTS },
  );
  const text = await readTextWithLimit(response);
  return {
    response,
    text,
    durationMs: Date.now() - startedAt,
  };
}

async function testSmallAsset(input: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  kind: 'key' | 'segment' | 'map' | 'file';
}): Promise<{
  ok: boolean;
  status?: number;
  contentType?: string;
  contentLength?: number;
  acceptRanges?: string;
  timeToFirstByteMs?: number;
  firstChunkBytes?: number;
  reason?: string;
}> {
  try {
    await validateProxyTargetUrl(input.url);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'invalid-url',
    };
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetchWithValidatedRedirects(
      input.url,
      {
        cache: 'no-store',
        headers: {
          ...input.headers,
          Range: input.kind === 'key' ? 'bytes=0-255' : 'bytes=0-1023',
        },
        method: 'GET',
      },
      { timeoutMs: input.timeoutMs, maxRedirects: MAX_REDIRECTS },
    );
  } catch (error) {
    return {
      ok: false,
      timeToFirstByteMs: Date.now() - startedAt,
      reason: error instanceof Error ? error.message : 'upstream-fetch-failed',
    };
  }

  const timeToFirstByteMs = Date.now() - startedAt;
  const status = response.status;
  const contentType = response.headers.get('content-type') || undefined;
  const contentLength = parseContentLength(response.headers);
  const acceptRanges = response.headers.get('accept-ranges') || undefined;

  let firstChunkBytes = 0;
  try {
    const reader = response.body?.getReader();
    if (reader) {
      const first = await reader.read();
      firstChunkBytes = first.value?.byteLength || 0;
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    // The status/header information is still useful.
  }

  const ok = response.ok || status === 206;
  return {
    ok,
    status,
    contentType,
    contentLength,
    acceptRanges,
    timeToFirstByteMs,
    firstChunkBytes,
    reason: ok ? undefined : `HTTP ${status}`,
  };
}

function detectNestedProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host.includes('pz.v88.qzz.io') ||
      host.includes('v88.qzz.io') ||
      host.includes('proxy') ||
      host.includes('jx.')
    );
  } catch {
    return false;
  }
}

function isMixedContentRisk(url: string, requestOrigin?: string): boolean {
  if (!requestOrigin) return false;
  try {
    return (
      new URL(requestOrigin).protocol === 'https:' &&
      new URL(url).protocol === 'http:'
    );
  } catch {
    return false;
  }
}

function recommendedStrategyFor(input: {
  url: string;
  requestOrigin?: string;
  manifestOk: boolean;
  firstSegmentOk: boolean;
  keyOk: boolean;
  strategy?: PlaybackStrategy | 'smart';
}): PlaybackHealthResult['recommendedStrategy'] {
  if (input.strategy === 'direct') return 'direct';
  if (input.strategy === 'manifest-proxy') return 'manifest-proxy';
  if (input.strategy === 'asset-proxy' || input.strategy === 'full-proxy') {
    return 'asset-proxy';
  }
  if (isMixedContentRisk(input.url, input.requestOrigin)) return 'asset-proxy';
  if (!input.manifestOk) return 'manifest-proxy';
  if (!input.firstSegmentOk || !input.keyOk) return 'asset-proxy';
  return 'direct';
}

export async function checkPlaybackHealth(
  input: PlaybackHealthInput,
): Promise<PlaybackHealthResult> {
  const rawUrl = input.episodeUrl || '';
  const unwrapped = unwrapDecoProxyUrl(rawUrl);
  const url = sanitizeEpisodeUrl(unwrapped.url);
  const warnings = hasSuspiciousUrlEncoding(rawUrl);
  const timings: Record<string, number> = {};
  const sourceConfig = input.sourceConfig || {};
  const timeoutMs = getHealthTimeoutMs(sourceConfig);
  const nestedProxy = detectNestedProxy(url);
  if (nestedProxy) warnings.push('nested-proxy');
  if (isMixedContentRisk(url, input.requestOrigin))
    warnings.push('mixed-content');

  if (!url) {
    return {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'unknown',
      reason: 'empty-url',
      suggestions: ['播放地址为空，请换源或重新获取详情。'],
      warnings,
      nestedProxy,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'unknown',
      reason: 'invalid-url',
      suggestions: ['播放地址不是合法 URL。'],
      warnings,
      nestedProxy,
    };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'unknown',
      reason: 'unsupported-protocol',
      suggestions: ['仅支持 http/https 播放地址。'],
      warnings,
      nestedProxy,
    };
  }

  const headers = buildPlaybackRequestHeaders({
    url,
    sourceConfig,
    userAgent: input.userAgent,
    referer: input.referer || unwrapped.referer,
  });
  const urlType = inferPlaybackType(url);

  if (urlType !== 'hls' && !isHlsUrl(url)) {
    const firstSegment = await testSmallAsset({
      url,
      headers,
      timeoutMs,
      kind: urlType === 'mp4' ? 'file' : 'segment',
    });
    const playable = firstSegment.ok && urlType !== 'flv';
    const base: PlaybackHealthResult = {
      ok: playable,
      playable,
      recommendedStrategy: recommendedStrategyFor({
        url,
        requestOrigin: input.requestOrigin,
        manifestOk: true,
        firstSegmentOk: firstSegment.ok,
        keyOk: true,
        strategy: input.strategy,
      }),
      source: input.source,
      urlType,
      firstSegment,
      cors: {
        checkedInBrowser: false,
        reason: 'server-side-only',
      },
      timings,
      reason: playable
        ? undefined
        : urlType === 'flv'
          ? 'flv-not-supported'
          : firstSegment.reason || 'asset-failed',
      suggestions:
        urlType === 'flv'
          ? ['当前播放器未启用 flv.js，建议换 mp4/m3u8 源。']
          : firstSegment.ok
            ? []
            : ['媒体文件首段不可访问，请换源或尝试代理。'],
      warnings,
      nestedProxy,
    };
    const scored = scorePlaybackHealth(base);
    return { ...base, ...scored };
  }

  let manifestResponse: Response;
  let manifestText: string;
  let manifestDurationMs = 0;
  try {
    const manifest = await fetchPlaylist({ url, headers, timeoutMs });
    manifestResponse = manifest.response;
    manifestText = manifest.text;
    manifestDurationMs = manifest.durationMs;
    timings.manifestMs = manifestDurationMs;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'manifest-fetch-failed';
    return {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'hls',
      manifest: {
        ok: false,
        reason,
      },
      cors: {
        checkedInBrowser: false,
        reason: 'server-side-only',
      },
      timings,
      reason,
      suggestions: ['m3u8 列表无法获取，优先尝试列表代理或换源。'],
      warnings,
      nestedProxy,
      ...scorePlaybackHealth({
        playable: false,
        manifest: { ok: false },
        firstSegment: { ok: false },
        nestedProxy,
      }),
    };
  }

  const manifestStatus = manifestResponse.status;
  const manifestContentType =
    manifestResponse.headers.get('content-type') || '';
  const manifestFinalUrl = manifestResponse.url || url;
  const manifestSize = new Blob([manifestText]).size;

  if (!manifestResponse.ok) {
    const base: PlaybackHealthResult = {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'hls',
      manifest: {
        ok: false,
        status: manifestStatus,
        contentType: manifestContentType,
        size: manifestSize,
        finalUrl: manifestFinalUrl,
        reason: `HTTP ${manifestStatus}`,
      },
      cors: { checkedInBrowser: false, reason: 'server-side-only' },
      timings,
      reason: `manifest-http-${manifestStatus}`,
      suggestions: ['m3u8 返回非 2xx 状态，建议尝试代理或换源。'],
      warnings,
      nestedProxy,
    };
    return { ...base, ...scorePlaybackHealth(base) };
  }

  if (isHtmlPayload(manifestText, manifestContentType)) {
    const base: PlaybackHealthResult = {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'hls',
      manifest: {
        ok: false,
        status: manifestStatus,
        contentType: manifestContentType,
        size: manifestSize,
        finalUrl: manifestFinalUrl,
        reason: 'html-instead-of-m3u8',
      },
      cors: { checkedInBrowser: false, reason: 'server-side-only' },
      timings,
      reason: 'html-instead-of-m3u8',
      suggestions: ['上游返回 HTML 而不是 m3u8，通常是防盗链或源失效。'],
      warnings,
      nestedProxy,
    };
    return { ...base, ...scorePlaybackHealth(base) };
  }

  if (!manifestText.trimStart().startsWith('#EXTM3U')) {
    const base: PlaybackHealthResult = {
      ok: false,
      playable: false,
      recommendedStrategy: 'manifest-proxy',
      source: input.source,
      urlType: 'hls',
      manifest: {
        ok: false,
        status: manifestStatus,
        contentType: manifestContentType,
        size: manifestSize,
        finalUrl: manifestFinalUrl,
        reason: 'not-m3u8',
      },
      cors: { checkedInBrowser: false, reason: 'server-side-only' },
      timings,
      reason: 'not-m3u8',
      suggestions: ['播放列表格式不正确，请换源。'],
      warnings,
      nestedProxy,
    };
    return { ...base, ...scorePlaybackHealth(base) };
  }

  let playlist = parseHlsPlaylist(
    manifestText,
    getPlaylistBaseUrl(manifestFinalUrl),
  );
  let selectedVariant = chooseDefaultHlsVariant(playlist.variants);

  if (playlist.isMaster && selectedVariant?.uri) {
    try {
      const media = await fetchPlaylist({
        url: selectedVariant.uri,
        headers,
        timeoutMs,
      });
      timings.mediaManifestMs = media.durationMs;
      const mediaBaseUrl = getPlaylistBaseUrl(
        media.response.url || selectedVariant.uri,
      );
      const mediaText = media.text;
      if (media.response.ok && mediaText.trimStart().startsWith('#EXTM3U')) {
        playlist = parseHlsPlaylist(mediaText, mediaBaseUrl);
      }
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'media-playlist-fetch-failed';
      const base: PlaybackHealthResult = {
        ok: false,
        playable: false,
        recommendedStrategy: 'manifest-proxy',
        source: input.source,
        urlType: 'hls',
        manifest: {
          ok: false,
          status: manifestStatus,
          contentType: manifestContentType,
          size: manifestSize,
          finalUrl: manifestFinalUrl,
          isMaster: true,
          selectedVariant,
          reason,
        },
        cors: { checkedInBrowser: false, reason: 'server-side-only' },
        timings,
        reason,
        suggestions: ['master playlist 可访问，但清晰度子列表不可访问。'],
        warnings,
        nestedProxy,
      };
      return { ...base, ...scorePlaybackHealth(base) };
    }
  }

  let keyResult: PlaybackHealthResult['key'] = {
    present: Boolean(playlist.key?.resolvedUri),
  };
  if (playlist.key?.resolvedUri) {
    const keyStartedAt = Date.now();
    const keyAsset = await testSmallAsset({
      url: playlist.key.resolvedUri,
      headers,
      timeoutMs,
      kind: 'key',
    });
    timings.keyMs = Date.now() - keyStartedAt;
    keyResult = {
      present: true,
      ok: keyAsset.ok,
      status: keyAsset.status,
      size: keyAsset.firstChunkBytes || keyAsset.contentLength,
      reason: keyAsset.reason,
    };
  }

  let firstSegment: PlaybackHealthResult['firstSegment'] = {
    ok: Boolean(playlist.firstSegmentResolved),
  };
  if (playlist.firstSegmentResolved && shouldTestFirstSegment()) {
    firstSegment = await testSmallAsset({
      url: playlist.firstSegmentResolved,
      headers,
      timeoutMs,
      kind: 'segment',
    });
    timings.firstSegmentMs = firstSegment.timeToFirstByteMs || 0;
  } else if (!playlist.firstSegmentResolved) {
    firstSegment = {
      ok: false,
      reason: 'first-segment-missing',
    };
  }

  const manifestOk = true;
  const keyOk = !keyResult.present || Boolean(keyResult.ok);
  const playable = manifestOk && firstSegment.ok && keyOk;
  const recommendedStrategy = recommendedStrategyFor({
    url,
    requestOrigin: input.requestOrigin,
    manifestOk,
    firstSegmentOk: Boolean(firstSegment.ok),
    keyOk,
    strategy: input.strategy,
  });

  const base: PlaybackHealthResult = {
    ok: manifestOk,
    playable,
    recommendedStrategy,
    source: input.source,
    urlType: 'hls' as PlaybackStreamType,
    manifest: {
      ok: true,
      status: manifestStatus,
      contentType: manifestContentType,
      size: manifestSize,
      finalUrl: manifestFinalUrl,
      isMaster: Boolean(selectedVariant),
      selectedVariant,
      targetDuration: playlist.targetDuration,
    },
    key: keyResult,
    firstSegment,
    cors: {
      checkedInBrowser: false,
      reason: 'server-side-only',
    },
    timings,
    reason: playable
      ? undefined
      : !keyOk
        ? 'key-failed'
        : firstSegment.reason || 'segment-failed',
    suggestions: playable
      ? []
      : !keyOk
        ? ['AES key 无法获取，建议尝试分片代理或换源。']
        : ['首个分片无法获取，建议尝试分片代理或换源。'],
    warnings,
    nestedProxy,
    debug: {
      checkedUrl: url,
      unwrappedProxy: unwrapped.wasProxy ? unwrapped.proxyPath : undefined,
      manifestDurationMs,
      firstSegmentHost: playlist.firstSegmentResolved
        ? new URL(resolveUrl(url, playlist.firstSegmentResolved)).hostname
        : undefined,
    },
  };

  return { ...base, ...scorePlaybackHealth(base) };
}

import { errorFields } from '../utils/errorText';
import {
    getFoliaNativePlugin,
    resetNativeAudioServerPort,
    resolveNativeAudioServerPort,
} from './nativeAudioServerPort';

// src/services/nativeMediaCache.ts
// 安卓媒体缓存的原生一侧：缓存的字节放在 LocalAudioServer 的 /media-cache 下，播放时交给
// ExoPlayer 的是 127.0.0.1 的 http 地址，而不是网页的 blob:（原生播放器读不了 blob:，
// 真机上正是这一点把已缓存的在线歌打回 <audio> 的 fallback:blob-source）。
//
// 契约（Java 同事按这个实现；改一处两边都要改）：
//   PUT    /media-cache/<id>          body=音频字节, Content-Type: audio/...  -> 201
//   GET    /media-cache/<id>          -> 音频字节（支持 Range）
//   HEAD   /media-cache/<id>          -> 存在则 2xx
//   DELETE /media-cache/<id>?size=NN  -> 204（服务端可校验大小）
//   DELETE /media-cache               -> 清空
//   GET    /media-cache-stats         -> { count, bytes }
//   id = base64url(UTF-8 cacheKey)，只含 [A-Za-z0-9_-]，最长 120
//
// 这条路径永远是「锦上添花」：网页、Electron、还没带这个路由的旧 APK 上，每个函数都立刻返回
// false / null（不发请求），调用方照旧走 IndexedDB 或主进程缓存。

/** 服务端接受的 id 上限，超了就不该发请求。 */
const ID_MAX_LENGTH = 120;

/** 本地服务不可用（没起来 / 端口变了）时不能拖住播放，所以每个请求都带超时。 */
const PORT_TIMEOUT_MS = 2_000;
const HEAD_TIMEOUT_MS = 1_500;
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 3_000;
const CLEAR_TIMEOUT_MS = 5_000;
const STATS_TIMEOUT_MS = 1_500;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type NativeMediaCacheStats = {
    count: number;
    bytes: number;
};

/**
 * 把任意 cacheKey 编成契约里的 id。自己编码而不是 btoa：btoa 只吃 latin1，缓存键里的中文
 * mediaId 会直接抛错；这里按 UTF-8 字节走，结果只用 [A-Za-z0-9_-]，也不需要去 '='。
 */
export const nativeMediaCacheId = (cacheKey: string): string => {
    const bytes = new TextEncoder().encode(String(cacheKey ?? ''));
    let encoded = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
        const triple = (first << 16) | (second << 8) | third;
        encoded += BASE64URL_ALPHABET[(triple >> 18) & 63];
        encoded += BASE64URL_ALPHABET[(triple >> 12) & 63];
        if (index + 1 < bytes.length) encoded += BASE64URL_ALPHABET[(triple >> 6) & 63];
        if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[triple & 63];
    }
    return encoded;
};

/** Capacitor 原生壳 + 安卓 + 插件里真的有取端口的方法，三者同时成立才启用。 */
export const isNativeMediaCacheAvailable = (): boolean => {
    if (typeof window === 'undefined') return false;
    const capacitor = (window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
    }).Capacitor;
    if (!capacitor?.isNativePlatform?.()) return false;
    if (capacitor.getPlatform?.() !== 'android') return false;
    return typeof getFoliaNativePlugin<{ localAudioServerPort?: unknown }>()?.localAudioServerPort === 'function';
};

const resolvePortWithin = async (timeoutMs: number): Promise<number> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            resolveNativeAudioServerPort(),
            new Promise<number>(resolve => {
                timer = setTimeout(() => resolve(0), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

const resolveOrigin = async (): Promise<string | null> => {
    if (!isNativeMediaCacheAvailable()) return null;
    const port = await resolvePortWithin(PORT_TIMEOUT_MS);
    return port > 0 ? `http://127.0.0.1:${port}` : null;
};

/** 超时信号：新内核用 AbortSignal.timeout，老 WebView 退回 AbortController。 */
const timeoutSignal = (timeoutMs: number): AbortSignal | null => {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(timeoutMs);
    }
    if (typeof AbortController !== 'undefined') {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), timeoutMs);
        return controller.signal;
    }
    return null;
};

/**
 * 一个带超时的请求。连不上 / 超时都按「原生这一侧暂时没有」处理：返回 null，日志留痕，
 * 顺手忘掉缓存的端口（服务可能刚换了端口）。HTTP 层的 404/500 不算连不上，原样返回响应。
 */
const fetchWithin = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> => {
    if (typeof fetch !== 'function') return null;
    const signal = timeoutSignal(timeoutMs);
    try {
        return await fetch(url, signal ? { ...init, signal } : init);
    } catch (error) {
        console.warn('[NativeMediaCache] request failed; keeping the IndexedDB path', url, errorFields(error));
        resetNativeAudioServerPort();
        return null;
    }
};

/** 校验后的 id；太长或为空时返回 null（退回 IndexedDB，而不是让服务端回 414）。 */
const idFor = (cacheKey: string): string | null => {
    const id = nativeMediaCacheId(cacheKey);
    if (id && id.length <= ID_MAX_LENGTH) return id;
    console.warn('[NativeMediaCache] cache key cannot be a native id; keeping it in IndexedDB', {
        keyLength: String(cacheKey ?? '').length,
        idLength: id.length,
    });
    return null;
};

/**
 * 这首歌在原生缓存里的回环地址（不检查存在性：要放进播放器之前先问 `has`）。
 * 原生不可用 / 端口拿不到时返回 null。
 */
export const nativeMediaCacheUrl = async (cacheKey: string): Promise<string | null> => {
    const id = idFor(cacheKey);
    if (!id) return null;
    const origin = await resolveOrigin();
    return origin ? `${origin}/media-cache/${id}` : null;
};

/** HEAD：原生缓存里有没有这份字节。任何失败都算没有。 */
async function has(cacheKey: string): Promise<boolean> {
    const url = await nativeMediaCacheUrl(cacheKey);
    if (!url) return false;
    const response = await fetchWithin(url, { method: 'HEAD', cache: 'no-store' }, HEAD_TIMEOUT_MS);
    return Boolean(response?.ok);
}

/** GET -> Blob：给不走 ExoPlayer 的路径（分析、时长校验、旧数据迁移）读字节用。 */
async function readBlob(cacheKey: string): Promise<Blob | null> {
    const url = await nativeMediaCacheUrl(cacheKey);
    if (!url) return null;
    const response = await fetchWithin(url, { method: 'GET', cache: 'no-store' }, READ_TIMEOUT_MS);
    if (!response?.ok) return null;
    try {
        const blob = await response.blob();
        return blob.size > 0 ? blob : null;
    } catch (error) {
        console.warn('[NativeMediaCache] could not read the cached bytes', errorFields(error));
        return null;
    }
}

/** PUT：把字节写进原生缓存。成功返回 true；false 表示调用方该回落到 IndexedDB。 */
async function save(cacheKey: string, blob: Blob, mimeType?: string): Promise<boolean> {
    if (!blob || blob.size <= 0) return false;
    const url = await nativeMediaCacheUrl(cacheKey);
    if (!url) return false;
    const type = mimeType || blob.type || 'audio/mpeg';
    const response = await fetchWithin(url, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': type },
        cache: 'no-store',
    }, WRITE_TIMEOUT_MS);
    if (!response) return false;
    if (!response.ok) {
        console.warn('[NativeMediaCache] save refused', { status: response.status, bytes: blob.size });
        return false;
    }
    console.log('[NativeMediaCache] stored a cached copy in the native media cache', {
        bytes: blob.size,
        mime: type,
    });
    return true;
}

/**
 * DELETE：删这份副本。带 `size` 时由服务端校验大小（读完之后又被写过的文件留下）；
 * 404 只是「本来就没有」，不算失败。返回是否真的删掉了。
 */
async function remove(cacheKey: string, size?: number): Promise<boolean> {
    const url = await nativeMediaCacheUrl(cacheKey);
    if (!url) return false;
    const bytes = Number(size);
    const target = Number.isFinite(bytes) && bytes > 0 ? `${url}?size=${Math.trunc(bytes)}` : url;
    const response = await fetchWithin(target, { method: 'DELETE', cache: 'no-store' }, DELETE_TIMEOUT_MS);
    if (!response) return false;
    if (response.ok) return true;
    if (response.status !== 404) {
        console.warn('[NativeMediaCache] remove refused', { status: response.status });
    }
    return false;
}

/** DELETE /media-cache：清空整个原生缓存（「清除媒体缓存」和「清空数据」用）。 */
async function clear(): Promise<boolean> {
    const origin = await resolveOrigin();
    if (!origin) return false;
    const response = await fetchWithin(`${origin}/media-cache`, { method: 'DELETE', cache: 'no-store' }, CLEAR_TIMEOUT_MS);
    return Boolean(response?.ok);
}

/** GET /media-cache-stats：给缓存用量和诊断报告用。拿不到时返回 null（不是 0）。 */
async function stats(): Promise<NativeMediaCacheStats | null> {
    const origin = await resolveOrigin();
    if (!origin) return null;
    const response = await fetchWithin(`${origin}/media-cache-stats`, { method: 'GET', cache: 'no-store' }, STATS_TIMEOUT_MS);
    if (!response?.ok) return null;
    try {
        const payload = await response.json() as { count?: unknown; bytes?: unknown };
        const count = Number(payload?.count);
        const bytes = Number(payload?.bytes);
        if (!Number.isFinite(count) || !Number.isFinite(bytes)) return null;
        return { count: Math.max(0, Math.trunc(count)), bytes: Math.max(0, Math.trunc(bytes)) };
    } catch (error) {
        console.warn('[NativeMediaCache] could not read the cache stats', errorFields(error));
        return null;
    }
}

/** 调用方统一从这里取，测试也只需替换这一个对象。 */
export const nativeMediaCache = {
    isAvailable: isNativeMediaCacheAvailable,
    id: nativeMediaCacheId,
    urlFor: nativeMediaCacheUrl,
    has,
    readBlob,
    save,
    remove,
    clear,
    stats,
};

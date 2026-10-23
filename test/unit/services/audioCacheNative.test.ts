import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/services/audioCacheNative.test.ts
// 安卓的媒体缓存在原生（/media-cache）：写进去就不该再写一份 IndexedDB，读之前先看原生，
// 原生没有才回落到 IndexedDB，并把旧的那份顺手迁过去、删掉。

const stored = new Map<string, unknown>();

const nativeCache = vi.hoisted(() => ({
    isAvailable: vi.fn(() => true),
    id: vi.fn((key: string) => key),
    urlFor: vi.fn(async () => null as string | null),
    has: vi.fn(async () => false),
    readBlob: vi.fn(async () => null as Blob | null),
    save: vi.fn(async () => false),
    remove: vi.fn(async () => false),
    clear: vi.fn(async () => true),
    stats: vi.fn(async () => null),
}));

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(async (key: string) => stored.get(key) ?? null),
    removeFromCache: vi.fn(async (key: string) => { stored.delete(key); }),
    saveToCache: vi.fn(async (key: string, value: unknown) => { stored.set(key, value); }),
}));

vi.mock('@/services/nativeMediaCache', () => ({
    nativeMediaCache: nativeCache,
    isNativeMediaCacheAvailable: nativeCache.isAvailable,
}));

const { getCachedAudioBlob, hasCachedAudio, removeAudioBlob, saveAudioBlob } = await import('@/services/audioCache');
const { getFromCache, removeFromCache, saveToCache } = await import('@/services/db');

beforeEach(() => {
    stored.clear();
    vi.clearAllMocks();
    nativeCache.isAvailable.mockReturnValue(true);
    nativeCache.has.mockResolvedValue(false);
    nativeCache.readBlob.mockResolvedValue(null);
    nativeCache.save.mockResolvedValue(false);
    nativeCache.remove.mockResolvedValue(false);
    vi.stubGlobal('window', {});
    vi.spyOn(console, 'log').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('saveAudioBlob', () => {
    it('keeps a copy in the native cache only, not in IndexedDB as well', async () => {
        nativeCache.save.mockResolvedValue(true);
        const blob = new Blob(['audio'], { type: 'audio/flac' });

        await saveAudioBlob('audio_x', blob);

        expect(nativeCache.save).toHaveBeenCalledExactlyOnceWith('audio_x', blob, 'audio/flac');
        expect(saveToCache).not.toHaveBeenCalled();
    });

    it('falls back to IndexedDB when the native cache will not take it', async () => {
        nativeCache.save.mockResolvedValue(false);
        const blob = new Blob(['audio'], { type: 'audio/mpeg' });

        await saveAudioBlob('audio_x', blob);

        expect(saveToCache).toHaveBeenCalledExactlyOnceWith('audio_x', blob);
    });
});

describe('getCachedAudioBlob', () => {
    it('reads the native copy first and never touches IndexedDB', async () => {
        const blob = new Blob(['native'], { type: 'audio/mpeg' });
        nativeCache.readBlob.mockResolvedValue(blob);

        await expect(getCachedAudioBlob('audio_x')).resolves.toBe(blob);

        expect(getFromCache).not.toHaveBeenCalled();
    });

    it('migrates an IndexedDB copy into the native cache and deletes it there', async () => {
        const blob = new Blob(['legacy'], { type: 'audio/mpeg' });
        stored.set('audio_x', blob);
        nativeCache.save.mockResolvedValue(true);

        await expect(getCachedAudioBlob('audio_x')).resolves.toBe(blob);

        expect(nativeCache.save).toHaveBeenCalledExactlyOnceWith('audio_x', blob, 'audio/mpeg');
        expect(removeFromCache).toHaveBeenCalledExactlyOnceWith('audio_x');
        expect(stored.has('audio_x')).toBe(false);
    });

    it('keeps the IndexedDB copy when the migration does not land', async () => {
        const blob = new Blob(['legacy'], { type: 'audio/mpeg' });
        stored.set('audio_x', blob);
        nativeCache.save.mockResolvedValue(false);

        await expect(getCachedAudioBlob('audio_x')).resolves.toBe(blob);

        expect(removeFromCache).not.toHaveBeenCalled();
        expect(stored.get('audio_x')).toBe(blob);
    });
});

describe('hasCachedAudio', () => {
    it('answers from the native cache without reading IndexedDB', async () => {
        nativeCache.has.mockResolvedValue(true);

        await expect(hasCachedAudio('audio_x')).resolves.toBe(true);

        expect(getFromCache).not.toHaveBeenCalled();
    });

    it('looks in IndexedDB when the native cache has nothing', async () => {
        stored.set('audio_x', new Blob(['legacy']));

        await expect(hasCachedAudio('audio_x')).resolves.toBe(true);
    });
});

describe('removeAudioBlob', () => {
    it('deletes the native copy with the size it was read at', async () => {
        nativeCache.remove.mockResolvedValue(true);

        await expect(removeAudioBlob('audio_x', 5)).resolves.toBe(true);

        expect(nativeCache.remove).toHaveBeenCalledExactlyOnceWith('audio_x', 5);
        expect(removeFromCache).not.toHaveBeenCalled();
    });

    it('still deletes the IndexedDB copy of that size', async () => {
        stored.set('audio_x', new Blob(['12345']));

        await expect(removeAudioBlob('audio_x', 5)).resolves.toBe(true);

        expect(removeFromCache).toHaveBeenCalledExactlyOnceWith('audio_x');
    });
});

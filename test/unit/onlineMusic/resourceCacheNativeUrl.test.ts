import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';

// test/unit/onlineMusic/resourceCacheNativeUrl.test.ts
// 已缓存的在线歌在安卓上要交给 ExoPlayer 一个回环地址，而不是 blob。级别判定必须和读字节
// 那条路一致，否则「按级别换歌」只在一半路径上生效。

const nativeCache = vi.hoisted(() => ({
    isAvailable: vi.fn(() => true),
    id: vi.fn((key: string) => key),
    urlFor: vi.fn(async (_key: string) => null as string | null),
    has: vi.fn(async (_key: string) => false),
    readBlob: vi.fn(async () => null as Blob | null),
    save: vi.fn(async () => false),
    remove: vi.fn(async () => false),
    clear: vi.fn(async () => true),
    stats: vi.fn(async () => null),
}));

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(async () => null),
    removeFromCache: vi.fn(),
    saveToCache: vi.fn(),
}));

vi.mock('@/services/audioCache', () => ({
    getCachedAudioBlob: vi.fn(async () => null),
    hasCachedAudio: vi.fn(async () => false),
    saveAudioBlob: vi.fn(),
    removeAudioBlob: vi.fn(async () => false),
}));

vi.mock('@/services/coverCache', () => ({
    getCachedCoverUrl: vi.fn(async () => null),
    hasCachedCover: vi.fn(async () => false),
    saveCoverBlob: vi.fn(),
}));

vi.mock('@/services/nativeMediaCache', () => ({ nativeMediaCache: nativeCache }));

const { getCachedSongAudioNativeUrl } = await import('@/services/onlineMusic/resourceCache');
const { getFromCache } = await import('@/services/db');
const { hasCachedAudio } = await import('@/services/audioCache');

const song: SongResult = {
    id: 'online-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'kugou', mediaId: 'online-song' },
};

const legacyNeteaseSong: SongResult = {
    ...song,
    id: 42,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42' },
};

const base = 'http://127.0.0.1:41234/media-cache/';

beforeEach(() => {
    vi.clearAllMocks();
    nativeCache.urlFor.mockResolvedValue(null);
    nativeCache.has.mockResolvedValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => { });
});

describe('getCachedSongAudioNativeUrl', () => {
    it('answers with the native URL of the current key when the copy is there', async () => {
        nativeCache.has.mockImplementation(async (key: string) => key === 'audio_online:kugou:online-song');
        nativeCache.urlFor.mockResolvedValue(base + 'current');

        await expect(getCachedSongAudioNativeUrl(song, 'high')).resolves.toBe(base + 'current');

        expect(nativeCache.has).toHaveBeenCalledWith('audio_online:kugou:online-song');
        expect(nativeCache.urlFor).toHaveBeenCalledWith('audio_online:kugou:online-song');
    });

    it('is a miss when there is no copy in the native cache', async () => {
        await expect(getCachedSongAudioNativeUrl(song, 'high')).resolves.toBeNull();
        expect(nativeCache.urlFor).not.toHaveBeenCalled();
    });

    it('passes over a copy fetched at another level, exactly as reading the bytes does', async () => {
        vi.mocked(getFromCache).mockResolvedValue('standard' as never);
        vi.mocked(hasCachedAudio).mockResolvedValue(true);
        nativeCache.has.mockResolvedValue(true);
        nativeCache.urlFor.mockResolvedValue(base + 'other-level');

        await expect(getCachedSongAudioNativeUrl(song, 'high')).resolves.toBeNull();
        expect(nativeCache.has).not.toHaveBeenCalled();
    });

    it('takes any level when none is asked for', async () => {
        nativeCache.has.mockResolvedValue(true);
        nativeCache.urlFor.mockResolvedValue(base + 'any-level');

        await expect(getCachedSongAudioNativeUrl(song)).resolves.toBe(base + 'any-level');
        expect(getFromCache).not.toHaveBeenCalled();
    });

    it('also finds a copy left under a legacy key', async () => {
        nativeCache.has.mockImplementation(async (key: string) => key === 'audio_42');
        nativeCache.urlFor.mockImplementation(async (key: string) => (key === 'audio_42' ? base + 'legacy' : null));

        await expect(getCachedSongAudioNativeUrl(legacyNeteaseSong)).resolves.toBe(base + 'legacy');

        expect(nativeCache.has.mock.calls.map(call => call[0])).toEqual([
            'audio_online:netease:42',
            'audio_42',
        ]);
    });
});

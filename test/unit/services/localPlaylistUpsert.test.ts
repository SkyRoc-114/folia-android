import { beforeEach, describe, expect, it, vi } from 'vitest';
import { upsertLocalPlaylistFromFile } from '@/services/localPlaylistService';
import { getFromCache, getLocalSongs, saveToCache } from '@/services/db';
import type { LocalPlaylist, LocalSong } from '@/types';

// test/unit/services/localPlaylistUpsert.test.ts — #866 歌单跟源：
// 同源 M3U 再导入时更新已有歌单而不是新建；名字/收藏/创建时间保留。
//
// 注意：getLocalPlaylists 在库里没有「收藏歌单」时会自动建一条并写回（系统固有行为），
// 所以 db mock 用内存 store 语义（写入可读回），断言都按「id 定位」而不是按位置/条数。

vi.mock('@/services/db', () => ({
    getFromCache: vi.fn(),
    getLocalSongs: vi.fn(),
    saveToCache: vi.fn(),
}));

const PLAYLIST_CACHE_KEY = 'local_playlists';

const song = (id: string): LocalSong => ({
    id,
    fileName: `${id}.mp3`,
    filePath: `Music/${id}.mp3`,
    title: id,
    titleOrigin: 'import',
    importedMetadata: { title: id, titleSource: 'filename', artistNames: [] },
    duration: 1000,
    fileSize: 1,
    fileLastModified: 1,
    mimeType: 'audio/mpeg',
    addedAt: 1,
    folderName: 'Music',
});

let store: Map<string, unknown>;

const seedPlaylists = (playlists: LocalPlaylist[]) => {
    store = new Map([[PLAYLIST_CACHE_KEY, playlists]]);
    vi.mocked(getFromCache).mockImplementation(async (key: string) => store.get(key));
    vi.mocked(saveToCache).mockImplementation(async (key: string, value: unknown) => {
        store.set(key, value);
    });
    // 修复逻辑（repairPlaylistSongIds）会把不在本地库里的歌清出歌单，给全量有效歌。
    vi.mocked(getLocalSongs).mockResolvedValue(['a', 'b', 'c', 'd', 'z'].map(song));
};

const storedPlaylists = (): LocalPlaylist[] => store.get(PLAYLIST_CACHE_KEY) as LocalPlaylist[];

describe('upsertLocalPlaylistFromFile (#866)', () => {
    beforeEach(() => {
        vi.mocked(getFromCache).mockReset();
        vi.mocked(saveToCache).mockReset();
        vi.mocked(getLocalSongs).mockReset();
    });

    it('creates a new playlist with sourcePath when nothing matches', async () => {
        seedPlaylists([]);
        const { playlist, updated } = await upsertLocalPlaylistFromFile('Mix', 'mix.m3u8', [song('a'), song('b')]);

        expect(updated).toBe(false);
        expect(playlist.name).toBe('Mix');
        expect(playlist.sourcePath).toBe('mix.m3u8');
        expect(playlist.songIds).toEqual(['a', 'b']);
        // 只有这一条名为 Mix 的：没有重复歌单。
        expect(storedPlaylists().filter(p => p.name === 'Mix')).toHaveLength(1);
    });

    it('updates the same-source playlist and keeps its name, favorite and createdAt', async () => {
        seedPlaylists([{
            id: 'p1',
            name: 'Mix',
            songIds: ['a'],
            createdAt: 111,
            updatedAt: 222,
            isFavorite: true,
            sourcePath: 'mix.m3u8',
        }]);

        const { playlist, updated } = await upsertLocalPlaylistFromFile('Mix Renamed By File', 'mix.m3u8', [song('c'), song('d')]);

        expect(updated).toBe(true);
        expect(playlist.id).toBe('p1');
        expect(playlist.name).toBe('Mix');
        expect(playlist.isFavorite).toBe(true);
        expect(playlist.createdAt).toBe(111);
        expect(playlist.songIds).toEqual(['c', 'd']);
        expect(playlist.sourcePath).toBe('mix.m3u8');
        // 仍是同一条记录：没有多出第二个歌单。
        expect(storedPlaylists().filter(p => p.name === 'Mix')).toHaveLength(1);
    });

    it('adopts a same-name playlist from an older import without sourcePath（旧版本兼容）', async () => {
        seedPlaylists([{
            id: 'legacy',
            name: 'Mix',
            songIds: ['a'],
            createdAt: 111,
            updatedAt: 222,
        }]);

        const { playlist, updated } = await upsertLocalPlaylistFromFile('Mix', 'mix.m3u8', [song('b')]);

        expect(updated).toBe(true);
        expect(playlist.id).toBe('legacy');
        expect(playlist.sourcePath).toBe('mix.m3u8');
        // legacy 被更新而不是复制；库里没有第二条同名歌单。
        const legacy = storedPlaylists().find(p => p.id === 'legacy');
        expect(legacy?.songIds).toEqual(['b']);
        expect(storedPlaylists().filter(p => p.name === 'Mix')).toHaveLength(1);
    });

    it('does not touch an unrelated playlist with a different name and source', async () => {
        seedPlaylists([{
            id: 'other',
            name: 'Road Trip',
            songIds: ['z'],
            createdAt: 111,
            updatedAt: 222,
            sourcePath: 'road.m3u8',
        }]);

        const { updated } = await upsertLocalPlaylistFromFile('Mix', 'mix.m3u8', [song('a')]);

        expect(updated).toBe(false);
        const other = storedPlaylists().find(p => p.id === 'other');
        expect(other?.songIds).toEqual(['z']);
        expect(storedPlaylists().filter(p => p.name === 'Mix')).toHaveLength(1);
    });
});

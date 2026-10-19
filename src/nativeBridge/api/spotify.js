// src/nativeBridge/api/spotify.js
//
// Spotify 的安卓侧桥：登录交给原生（SpotifyAuth.java 做 OAuth PKCE + 回环回调），令牌留在原生。
// 数据走 Spotify **官方 Web API**（api.spotify.com/v1）：桌面版走的 pathfinder 内网接口从
// 2026-10 起对第三方 OAuth 令牌一律回 403 Client/request not allowed，安卓只能走官方接口。
// 官方返回的形状与 pathfinder 不同，这里翻译成渲染层（spotifyNormalize.ts）读懂的形状，
// 渲染层的 provider / catalog / library 代码不用改。
//
// 没有官方接口的能力（Spotify 自己的音频、内置歌词）明确报 unsupported / 返回 null，不假装有。

import { noteLibraryStep } from './libraryTrace.js';

const API = 'https://api.spotify.com/v1';

/** 桥错误：code 用 ProviderErrorCode 的写法，message 是给人看的一句。 */
class SpotifyBridgeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SpotifyBridgeError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new SpotifyBridgeError(code, message); };

const nativePlugin = () => {
    if (typeof window === 'undefined') return null;
    const plugin = window.Capacitor?.Plugins?.FoliaNative;
    return plugin && typeof plugin.spotifyLoginStatus === 'function' ? plugin : null;
};

const plugin = () => nativePlugin() ?? fail('unavailable', 'Spotify requires the Android app');

const authStatus = async () => {
    const status = await plugin().spotifyLoginStatus();
    return status && typeof status === 'object' ? status : { signedIn: false };
};

const accessToken = async () => {
    const status = await authStatus();
    if (!status.signedIn) fail('auth-required', 'Spotify sign-in is required');
    const result = await plugin().spotifyAccessToken();
    const token = result && typeof result === 'object' ? result.token : result;
    if (typeof token !== 'string' || !token) fail('auth-required', 'Spotify sign-in is required');
    return token;
};

/** 一次官方 Web API 请求；`path` 是 /v1 之后的路径。 */
const web = async (path, { method = 'GET', body, query } = {}) => {
    const token = await accessToken();
    const url = new URL(API + (path.startsWith('/') ? path : `/${path}`));
    Object.entries(query ?? {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
    const response = await fetch(url.toString(), {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) fail('auth-required', 'Spotify sign-in is required');
    if (response.status === 403) fail('unavailable', 'Spotify refused the request (403)');
    if (response.status === 429) fail('unavailable', 'Spotify rate limited the request (429)');
    if (response.status === 404) return null;
    if (!response.ok) {
        let said = '';
        try { said = (await response.text()).slice(0, 160); } catch { said = ''; }
        fail(response.status >= 500 ? 'network' : 'unavailable', `Spotify refused the request (HTTP ${response.status})${said ? `: ${said}` : ''}`);
    }
    if (response.status === 204) return null;
    return response.json();
};

// ── 官方形状 → 渲染层读的 pathfinder 形状 ────────────────────────────────

const imageSources = images => (Array.isArray(images)
    ? images
        .filter(image => image && typeof image.url === 'string')
        .map(image => ({ url: image.url, width: typeof image.width === 'number' ? image.width : null }))
    : []);

const artistRowOf = artist => ({
    uri: `spotify:artist:${artist.id}`,
    profile: { name: artist.name ?? '' },
    visuals: { avatarImage: { sources: imageSources(artist.images) } },
});

const trackOf = track => ({
    __typename: 'Track',
    uri: `spotify:track:${track.id}`,
    name: track.name ?? '',
    artists: { items: (track.artists ?? []).map(artistRowOf) },
    albumOfTrack: track.album
        ? { uri: `spotify:album:${track.album.id}`, name: track.album.name ?? '', coverArt: { sources: imageSources(track.album.images) } }
        : undefined,
    duration: { totalMilliseconds: Number(track.duration_ms) || 0 },
});

const albumOf = (album, tracks) => ({
    __typename: 'Album',
    uri: `spotify:album:${album.id}`,
    name: album.name ?? '',
    coverArt: { sources: imageSources(album.images) },
    artists: { items: (album.artists ?? []).map(artistRowOf) },
    date: { isoString: album.release_date ?? '' },
    albumType: album.album_type ? String(album.album_type).toUpperCase() : undefined,
    ...(tracks === undefined ? {} : {
        tracksV2: {
            totalCount: Number(tracks.total) || (tracks.items ?? []).length,
            items: (tracks.items ?? []).map(track => ({ track: trackOf(track) })),
        },
    }),
});

const playlistOf = playlist => ({
    __typename: 'Playlist',
    uri: `spotify:playlist:${playlist.id}`,
    name: playlist.name ?? '',
    description: playlist.description ?? '',
    images: { items: (playlist.images ?? []).map(image => ({ sources: imageSources([image]) })) },
    ownerV2: { data: { name: playlist.owner?.display_name ?? playlist.owner?.id ?? '', username: playlist.owner?.id ?? '' } },
    content: { totalCount: Number(playlist.tracks?.total) || 0 },
    currentUserCapabilities: { canEditItems: playlist.collaborative === true || playlist.owner?.id === (playlist.__meId ?? '') },
});

const cardOf = (typename, data) => ({ content: { __typename: typename, data } });

const sectionOf = (uri, title, cards) => ({
    uri,
    data: { title: { transformedLabel: title } },
    sectionItems: { totalCount: cards.length, items: cards },
});

// ── 共享读取 ─────────────────────────────────────────────────────────────

let meCache = null;
const me = async () => {
    if (meCache) return meCache;
    const answer = await web('/me');
    if (!answer) fail('auth-required', 'Spotify sign-in is required');
    meCache = answer;
    return meCache;
};

const likedAnswer = tracks => ({
    me: {
        library: {
            tracks: {
                totalCount: Number(tracks.total) || (tracks.items ?? []).length,
                items: (tracks.items ?? []).map(row => ({ track: { _uri: row.track?.uri, data: trackOf(row.track) } })),
            },
        },
    },
});

const playlistAnswer = (playlist, tracks) => ({
    playlistV2: {
        ...playlistOf(playlist),
        content: {
            totalCount: Number(tracks?.total) || Number(playlist.tracks?.total) || 0,
            items: (tracks?.items ?? []).map(row => ({ itemV2: { data: row.track ? trackOf(row.track) : undefined } })),
        },
    },
});

// Spotify 没有「为一首歌生成的电台」官方接口；推荐接口能给出同风格的歌。这里用一个合成的
// playlist uri 顶替：请求这个 uri 的歌曲时转去 /recommendations。
const radioIds = new Map();

const syntheticRadioUri = seedId => {
    // 渲染层要求 playlist id 是 22 位 [0-9A-Za-z]。
    let id = `${seedId}`.replace(/[^0-9A-Za-z]/g, '').slice(0, 22);
    while (id.length < 22) id += 'x';
    radioIds.set(id, seedId);
    return `spotify:playlist:${id}`;
};

const radioTracks = async seedId => {
    const answer = await web('/recommendations', { query: { seed_tracks: seedId, limit: 50 } });
    const rows = (answer?.tracks ?? []).map(track => trackOf(track));
    return { totalCount: rows.length, items: rows.map(track => ({ track })) };
};

// ── 查询实现 ─────────────────────────────────────────────────────────────

const catalogHandlers = {
    async libraryV3(variables) {
        const kind = Array.isArray(variables.filters) ? String(variables.filters[0]) : 'Playlists';
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 20));
        const offset = Math.max(0, Number(variables.offset) || 0);
        if (kind === 'Albums') {
            const answer = await web('/me/albums', { query: { limit, offset } });
            return {
                me: {
                    libraryV3: {
                        totalCount: Number(answer?.total) || 0,
                        items: (answer?.items ?? []).map(row => ({ item: { data: albumOf(row.album) } })),
                    },
                },
            };
        }
        const account = await me();
        const answer = await web('/me/playlists', { query: { limit, offset } });
        return {
            me: {
                libraryV3: {
                    totalCount: Number(answer?.total) || 0,
                    items: (answer?.items ?? []).map(item => ({ item: { data: { ...playlistOf(item), __meId: account.id } } })),
                },
            },
        };
    },

    async fetchLibraryTracks(variables) {
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 50));
        const offset = Math.max(0, Number(variables.offset) || 0);
        const answer = await web('/me/tracks', { query: { limit, offset } });
        return likedAnswer(answer ?? {});
    },

    async fetchPlaylist(variables) {
        const uri = String(variables.uri ?? '');
        const id = uri.split(':').pop() ?? '';
        const limit = Math.max(1, Math.min(100, Number(variables.limit) || 100));
        const offset = Math.max(0, Number(variables.offset) || 0);
        const seed = radioIds.get(id);
        if (seed) {
            const tracks = await radioTracks(seed);
            return {
                playlistV2: {
                    __typename: 'Playlist',
                    uri,
                    name: 'Spotify Radio',
                    description: '',
                    images: { items: [] },
                    ownerV2: { data: { name: 'Spotify', username: 'spotify' } },
                    content: {
                        totalCount: tracks.totalCount,
                        items: tracks.items.slice(offset, offset + limit).map(row => ({ itemV2: { data: row.track } })),
                    },
                },
            };
        }
        const playlist = await web(`/playlists/${encodeURIComponent(id)}`);
        if (!playlist) fail('unavailable', 'Spotify has no such playlist');
        const tracks = await web(`/playlists/${encodeURIComponent(id)}/tracks`, { query: { limit, offset } });
        const account = await me();
        return playlistAnswer({ ...playlist, __meId: account.id }, tracks);
    },

    async getAlbum(variables) {
        const id = String(variables.uri ?? '').split(':').pop() ?? '';
        const offset = Math.max(0, Number(variables.offset) || 0);
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 50));
        const album = await web(`/albums/${encodeURIComponent(id)}`);
        if (!album) fail('unavailable', 'Spotify has no such album');
        // 官方专辑详情自带前 50 首；再往后单独翻页。
        const tracks = offset === 0
            ? { total: album.tracks?.total, items: album.tracks?.items ?? [] }
            : await web(`/albums/${encodeURIComponent(id)}/tracks`, { query: { limit, offset } });
        return { albumUnion: albumOf(album, tracks) };
    },

    async getTrack(variables) {
        const id = String(variables.uri ?? '').split(':').pop() ?? '';
        const track = await web(`/tracks/${encodeURIComponent(id)}`);
        if (!track) fail('unavailable', 'Spotify has no such track');
        const [first, ...rest] = track.artists ?? [];
        return {
            trackUnion: {
                ...trackOf(track),
                firstArtist: { items: first ? [artistRowOf(first)] : [] },
                otherArtists: { items: rest.map(artistRowOf) },
            },
        };
    },

    async queryArtistOverview(variables) {
        const id = String(variables.uri ?? '').split(':').pop() ?? '';
        const [artist, top, albums] = await Promise.all([
            web(`/artists/${encodeURIComponent(id)}`),
            web(`/artists/${encodeURIComponent(id)}/top-tracks`, { query: { market: 'from_token' } }).catch(() => null),
            web(`/artists/${encodeURIComponent(id)}/albums`, { query: { include_groups: 'album,single,compilation', limit: 50 } }).catch(() => null),
        ]);
        if (!artist) fail('unavailable', 'Spotify has no such artist');
        const rows = albums?.items ?? [];
        return {
            artistUnion: {
                ...artistRowOf(artist),
                __typename: 'Artist',
                discography: {
                    topTracks: { items: (top?.tracks ?? []).map(track => ({ track: trackOf(track) })) },
                    albums: { totalCount: rows.length },
                    singles: { totalCount: rows.filter(row => row.album_type !== 'album').length },
                },
            },
        };
    },

    async queryArtistDiscographyAll(variables) {
        const id = String(variables.uri ?? '').split(':').pop() ?? '';
        const offset = Math.max(0, Number(variables.offset) || 0);
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 50));
        const answer = await web(`/artists/${encodeURIComponent(id)}/albums`, {
            query: { include_groups: 'album,single,compilation', limit, offset },
        });
        return {
            artistUnion: {
                discography: {
                    all: {
                        totalCount: Number(answer?.total) || 0,
                        items: (answer?.items ?? []).map(album => ({ releases: { items: [albumOf(album)] } })),
                    },
                },
            },
        };
    },

    async searchTracks(variables) {
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 20));
        const offset = Math.max(0, Number(variables.offset) || 0);
        const answer = await web('/search', {
            query: { q: String(variables.searchTerm ?? ''), type: 'track,album,artist,playlist', limit, offset },
        });
        const tracks = answer?.tracks;
        return {
            searchV2: {
                tracksV2: {
                    totalCount: Number(tracks?.total) || 0,
                    items: (tracks?.items ?? []).map(track => ({ item: { data: trackOf(track) } })),
                },
                albumsV2: { items: (answer?.albums?.items ?? []).map(album => ({ item: { data: albumOf(album) } })) },
                artistsV2: { items: (answer?.artists?.items ?? []).map(artist => ({ item: { data: artistRowOf(artist) } })) },
                playlistsV2: { items: (answer?.playlists?.items ?? []).map(playlist => ({ item: { data: playlistOf(playlist) } })) },
            },
        };
    },

    async areEntitiesInLibrary(variables) {
        const uris = Array.isArray(variables.uris) ? variables.uris.map(String) : [];
        const saved = new Map();
        const asks = uris.map(async (uri, at) => {
            const [kind, , id] = uri.split(':');
            const path = kind === 'track' ? '/me/tracks/contains'
                : kind === 'album' ? '/me/albums/contains'
                    : kind === 'playlist' ? `/playlists/${encodeURIComponent(id)}/followers/contains`
                        : null;
            if (!path) return;
            const query = kind === 'playlist' ? { ids: id } : { ids: id };
            const answer = await web(path, { query }).catch(() => null);
            saved.set(at, Array.isArray(answer) ? Boolean(answer[0]) : false);
        });
        await Promise.all(asks);
        return { lookup: uris.map((_uri, at) => ({ data: { saved: saved.get(at) === true } })) };
    },

    // 探索页：官方接口没有 Spotify 首页那种「排好的一页」，用精选/新发行/你常听拼。
    async home() {
        const [featured, releases, playlists, topArtists] = await Promise.all([
            web('/browse/featured-playlists', { query: { limit: 10 } }).catch(() => null),
            web('/browse/new-releases', { query: { limit: 10 } }).catch(() => null),
            web('/me/playlists', { query: { limit: 10 } }).catch(() => null),
            web('/me/top/artists', { query: { limit: 10, time_range: 'medium_term' } }).catch(() => null),
        ]);
        const sections = [];
        if (featured?.playlists?.items?.length) {
            sections.push(sectionOf('spotify-featured', '为你精选', featured.playlists.items.map(playlist => cardOf('Playlist', playlistOf(playlist)))));
        }
        if (playlists?.items?.length) {
            sections.push(sectionOf('spotify-your-playlists', '你的歌单', playlists.items.map(playlist => cardOf('Playlist', playlistOf(playlist)))));
        }
        if (releases?.albums?.items?.length) {
            sections.push(sectionOf('spotify-new-releases', '新发行', releases.albums.items.map(album => cardOf('Album', albumOf(album)))));
        }
        if (topArtists?.items?.length) {
            sections.push(sectionOf('spotify-top-artists', '你常听的歌手', topArtists.items.map(artist => cardOf('Artist', artistRowOf(artist)))));
        }
        return { home: { sectionContainer: { sections: { items: sections } } } };
    },

    async homeSection(variables) {
        const uri = String(variables.uri ?? '');
        const home = await catalogHandlers.home();
        const sections = home.home.sectionContainer.sections.items;
        const found = sections.filter(section => section.uri === uri);
        return { homeSections: { sections: found.length ? found : sections.slice(0, 1) } };
    },

    async browsePage(variables) {
        const pagination = variables.sectionPagination ?? { offset: 0, limit: 20 };
        const offset = Math.max(0, Number(pagination.offset) || 0);
        const limit = Math.max(1, Math.min(20, Number(pagination.limit) || 20));
        const answer = await web('/me/playlists', { query: { limit, offset } });
        const items = (answer?.items ?? []).map(playlist => cardOf('Playlist', playlistOf(playlist)));
        return {
            browse: {
                sections: {
                    items: [{
                        uri: 'spotify-made-for-you',
                        data: { title: { transformedLabel: '为你而做' } },
                        sectionItems: { totalCount: Number(answer?.total) || items.length, items },
                    }],
                },
            },
        };
    },

    async queryWhatsNewFeed(variables) {
        const limit = Math.max(1, Math.min(50, Number(variables.limit) || 20));
        const offset = Math.max(0, Number(variables.offset) || 0);
        const answer = await web('/browse/new-releases', { query: { limit, offset } });
        return { whatsNewFeedItems: { items: (answer?.albums?.items ?? []).map(album => cardOf('Album', albumOf(album))) } };
    },
};

// ── 操作处理 ─────────────────────────────────────────────────────────────

let activeLogin = null;

const handlers = {
    async login_start() {
        const native = plugin();
        const key = `spotify-${Date.now()}`;
        activeLogin = { key, confirmed: false, failed: false };
        native.spotifyStartLogin().then(result => {
            if (activeLogin?.key !== key) return;
            if (result && result.signedIn) { activeLogin.confirmed = true; return; }
            activeLogin.failed = true;
            const reason = typeof result?.reason === 'string' && result.reason ? result.reason : 'failed';
            const detail = typeof result?.detail === 'string' && result.detail ? `: ${result.detail.slice(0, 180)}` : '';
            activeLogin.message = `Spotify sign-in failed (${reason})${detail}`;
        }).catch(error => {
            if (activeLogin?.key !== key) return;
            activeLogin.failed = true;
            activeLogin.message = error instanceof Error ? error.message : String(error);
        });
        return { key, expiresInMs: 3 * 60 * 1000 };
    },
    async login_open() { return true; },
    async login_check(params) {
        if (!activeLogin || activeLogin.key !== params.key) return { state: 'expired' };
        if (activeLogin.confirmed) return { state: 'confirmed' };
        const status = await authStatus();
        if (status.signedIn) { activeLogin.confirmed = true; return { state: 'confirmed' }; }
        if (activeLogin.failed) return { state: 'error', message: activeLogin.message || 'Spotify sign-in failed' };
        return { state: 'waiting' };
    },
    async login_cancel(params) {
        if (activeLogin?.key === params.key) activeLogin = null;
        const native = nativePlugin();
        if (native && typeof native.spotifyCancelLogin === 'function') await native.spotifyCancelLogin();
        return true;
    },
    async login_status() {
        const status = await authStatus();
        if (!status.signedIn) return null;
        try {
            const account = await me();
            return {
                id: account.id,
                nickname: account.display_name || account.id || 'Spotify',
                avatarUrl: imageSources(account.images)[0]?.url ?? '',
                vipType: account.product === 'premium' ? 1 : 0,
            };
        } catch (error) {
            noteLibraryStep('spotify', 'profile:error', { message: error instanceof Error ? error.message : String(error) });
            const user = status.user ?? {};
            return {
                id: typeof user.id === 'string' && user.id ? user.id : (typeof status.id === 'string' ? status.id : 'spotify'),
                nickname: typeof user.displayName === 'string' && user.displayName ? user.displayName : 'Spotify',
                avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
                vipType: user.product === 'premium' ? 1 : 0,
            };
        }
    },
    async logout() {
        activeLogin = null;
        meCache = null;
        await plugin().spotifyLogout();
        return true;
    },

    async query(params) {
        const name = String(params.name ?? '');
        const handler = catalogHandlers[name];
        if (!handler) fail('unsupported', `Unsupported Spotify query: ${name}`);
        const variables = params.variables && typeof params.variables === 'object' ? params.variables : {};
        return handler(variables);
    },

    async radio(params) {
        const id = String(params.id ?? '');
        if (!/^[0-9A-Za-z]{22}$/.test(id)) fail('invalid-response', 'Invalid Spotify track');
        return { uri: syntheticRadioUri(id) };
    },

    // Spotify 不在官方接口里给歌词；交给渲染层的跨源匹配。
    async lyrics() { return null; },

    // 安卓不能放 Spotify 音频（没有 librespot；官方接口也不给音频流）。
    async audio() { fail('unsupported', 'Spotify playback is not available on Android yet'); },
    async audio_kept() { return false; },
    async audio_keep() { return false; },

    async library(params) {
        const uri = String(params.uri ?? '');
        const match = /^spotify:(track|album|playlist):([0-9A-Za-z]{22})$/.exec(uri);
        if (!match || typeof params.saved !== 'boolean') fail('invalid-response', 'Invalid Spotify library change');
        const [, kind, id] = match;
        if (kind === 'track') {
            await web('/me/tracks', { method: params.saved ? 'PUT' : 'DELETE', body: { ids: [id] } });
        } else if (kind === 'album') {
            await web('/me/albums', { method: params.saved ? 'PUT' : 'DELETE', body: { ids: [id] } });
        } else if (params.saved) {
            const account = await me();
            const playlist = await web(`/playlists/${encodeURIComponent(id)}`);
            if (playlist?.owner?.id === account.id) fail('unsupported', "The playlist is the account's own");
            await web(`/playlists/${encodeURIComponent(id)}/followers`, { method: 'PUT', body: { public: false } });
        } else {
            await web(`/playlists/${encodeURIComponent(id)}/followers`, { method: 'DELETE' });
        }
        return true;
    },

    async playlist_edit(params) {
        const id = String(params.id ?? '');
        const ids = Array.isArray(params.tracks) ? [...new Set(params.tracks.map(String))] : [];
        if (!/^[0-9A-Za-z]{22}$/.test(id) || !['add', 'remove'].includes(params.action) || ids.length === 0) {
            fail('invalid-response', 'Invalid Spotify playlist change');
        }
        if (params.action === 'add') {
            await web(`/playlists/${encodeURIComponent(id)}/tracks`, {
                method: 'POST',
                body: { uris: ids.map(trackId => `spotify:track:${trackId}`) },
            });
        } else {
            await web(`/playlists/${encodeURIComponent(id)}/tracks`, {
                method: 'DELETE',
                body: { tracks: ids.map(trackId => ({ uri: `spotify:track:${trackId}` })) },
            });
        }
        return true;
    },

    async playlist_create(params) {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > 100) fail('invalid-response', 'Invalid Spotify playlist name');
        const account = await me();
        const made = await web(`/users/${encodeURIComponent(account.id)}/playlists`, {
            method: 'POST',
            body: { name, public: false },
        });
        if (!made?.uri) fail('invalid-response', 'Spotify did not name the new playlist');
        return { uri: made.uri };
    },
};

/** 原生桥的操作入口：返回数据，错误按 { code, message } 抛给 folia.js 的通用处理。 */
export async function handleSpotifyRequest(operation, params = {}) {
    if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, operation)) {
        fail('unsupported', 'Unsupported Spotify operation');
    }
    const name = operation === 'query' ? `query:${String(params?.name ?? '?')}` : operation;
    const startedAt = Date.now();
    noteLibraryStep('spotify', 'bridge:request', { operation: name });
    try {
        const data = await handlers[operation](params && typeof params === 'object' ? params : {});
        noteLibraryStep('spotify', 'bridge:result', { operation: name, ms: Date.now() - startedAt });
        return data;
    } catch (error) {
        if (error instanceof SpotifyBridgeError) {
            noteLibraryStep('spotify', 'bridge:error', { operation: name, ms: Date.now() - startedAt, code: error.code, message: error.message });
            throw error;
        }
        console.warn('[Spotify] request failed', error);
        noteLibraryStep('spotify', 'bridge:error', { operation: name, ms: Date.now() - startedAt, message: error instanceof Error ? error.message : String(error) });
        fail('network', error instanceof Error ? error.message : String(error));
    }
}

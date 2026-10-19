// src/nativeBridge/api/spotify.js
//
// Spotify 的安卓侧桥：登录交给原生（SpotifyAuth.java 做 OAuth PKCE + 回环回调），令牌留在原生，
// 这里只按操作名发请求。读取走 Spotify 应用自己用的两个服务（pathfinder 的固定查询名 + spclient），
// 写入走同一套 pathfinder 变更；移植自 electron/spotify/spotifyApiBridge.cjs，逻辑保持一致，
// 只是 Node 的 fetch/写文件换成了 WebView 的 fetch（经原生 HTTP 代理绕开 CORS）。
//
// 桌面版能放 Spotify 音频（librespot）；安卓没有这条通道，`audio`/`audio_kept`/`audio_keep` 明确
// 报 unsupported，播放侧按 capability 关掉，不假装能放。

const QUERIES = Object.freeze({
    home: '3357ffed7961629ba92b4e0a41514e4d5004a14355c964c23ce442205c9e44a1',
    homeSection: 'd62af2714f2623c923cc9eeca4b9545b4363abaa9188a9e94e2b63b823419a2c',
    browsePage: 'f5c4e6d668f5716464a231c1cc8b22c1cbf6ad68b09929fd7de813a30581298b',
    queryWhatsNewFeed: '3b53dede3c6054e8b7c962dd280eb6761c5d1c82b06b039f4110d76a62b4966b',
    libraryV3: '390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455',
    fetchLibraryTracks: '087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240',
    fetchPlaylist: 'cd2275433b29f7316176e7b5b5e098ae7744724e1a52d63549c76636b3257749',
    getAlbum: 'b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10',
    queryArtistOverview: '7f86ff63e38c24973a2842b672abe44c910c1973978dc8a4a0cb648edef34527',
    queryArtistDiscographyAll: '5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599',
    searchTracks: 'bc1ca2fcd0ba1013a0fc88e6cc4f190af501851e3dafd3e1ef85840297694428',
    getTrack: '612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294',
    areEntitiesInLibrary: '134337999233cc6fdd6b1e6dbf94841409f04a946c5c7b744b09ba0dfe5a85ed',
    profileAttributes: '53bcb064f6cd18c23f752bc324a791194d20df612d8e1239c735144ab0399ced',
});
const CHANGES = Object.freeze({
    addToLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    removeFromLibrary: '896ebcb47815681340860d121cb5d494e157e2a78d3950385cd54e0393c67148',
    addItemsToRootlist: 'bd9c5cae1ee80ebca05d7ed12fd394216f49a20ce72d9dc762868df0f14522ea',
    removeItemsFromRootlist: '3422f1866532820a1d8d0560f88542dbdbd35d0377ee5ecd49593590f5f1e86b',
    addToPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
    removeFromPlaylist: '47b2a1234b17748d332dd0431534f22450e9ecbb3d5ddcdacbd83368636a0990',
});
const QUERY_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const SPCLIENT_URL = 'https://spclient.wg.spotify.com';
const LIBRARY_URI = /^spotify:(track|album|playlist):[0-9A-Za-z]{22}$/;
const PLAYLIST_URI = /^spotify:playlist:[0-9A-Za-z]{22}$/;
const TRACK_ID = /^[0-9A-Za-z]{22}$/;
const LIST_ROWS = 500;
const LIST_MAX_REQUESTS = 40;
const MAX_SONGS_A_CHANGE = 100;
const MAX_NAME_LENGTH = 100;
const MAX_VARIABLES_LENGTH = 4096;
const RENDERER_QUERIES = Object.keys(QUERIES).filter(name => name !== 'profileAttributes');

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

const plugin = () => {
    const found = nativePlugin();
    return found ?? fail('unavailable', 'Spotify requires the Android app');
};

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

/** 带令牌的一次请求：Spotify 的 pathfinder / spclient 都从这里发。 */
const call = async (url, { method = 'GET', body, headers = {}, absent, token } = {}) => {
    const bearer = token ?? await accessToken();
    const response = await fetch(url, {
        method,
        headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN', ...headers, Authorization: `Bearer ${bearer}` },
        ...(body === undefined ? {} : { body }),
    });
    if (response.status === 404 && absent !== undefined) return absent;
    if (!response.ok) fail(response.status === 401 ? 'auth-required' : 'unavailable', 'Spotify refused the request');
    return response.json();
};

const ask = async (name, hash, variables, token) => {
    const answer = await call(QUERY_URL, {
        token,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variables, operationName: name, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const errors = Array.isArray(answer?.errors) ? answer.errors : [];
    return { data: answer?.data, refused: errors.length > 0, said: errors.map(error => error?.message).filter(Boolean).join(' | ') };
};

const query = async (name, variables, token) => {
    const { data, said } = await ask(name, QUERIES[name], variables, token);
    if (!data) fail('invalid-response', `Spotify did not answer the query: ${name}${said ? ` (${said.slice(0, 80)})` : ''}`);
    return data;
};

const change = async (name, variables) => {
    const { data, refused, said } = await ask(name, CHANGES[name], variables);
    const results = data && typeof data === 'object' ? Object.values(data) : [];
    if (refused || results.length === 0 || results.some(result => result === null)) {
        fail('unavailable', `Spotify refused the change: ${name}${said ? ` (${said.slice(0, 80)})` : ''}`);
    }
};

const playlistRows = async uri => {
    const rows = new Map();
    let offset = 0;
    for (let request = 0; request < LIST_MAX_REQUESTS; request += 1) {
        const { data, refused, said } = await ask('fetchPlaylist', QUERIES.fetchPlaylist, { uri, offset, limit: LIST_ROWS, enableWatchFeedEntrypoint: false });
        const list = data?.playlistV2;
        if (refused || !list) fail('invalid-response', `Spotify did not give the playlist whole: ${said || 'no data'}`);
        if (list.currentUserCapabilities?.canEditItems !== true) fail('unsupported', 'The account may not change the songs of this playlist');
        const items = list.content?.items;
        if (!Array.isArray(items)) fail('invalid-response', "Spotify did not give the playlist's rows");
        for (const item of items) {
            const song = item?.itemV2?.data?.uri;
            if (typeof song === 'string') rows.set(song, [...(rows.get(song) ?? []), ...(typeof item.uid === 'string' ? [item.uid] : [])]);
        }
        offset += items.length;
        const total = list.content.totalCount;
        if (items.length === 0 || (typeof total === 'number' && offset >= total)) return rows;
    }
    fail('unavailable', 'The playlist is too long to change from here');
};

const profileOf = profile => {
    const me = profile?.me?.profile;
    const pictures = Array.isArray(me?.avatar?.sources) ? me.avatar.sources : [];
    const largest = pictures.reduce((best, picture) => ((picture?.width ?? 0) > (best?.width ?? -1) ? picture : best), null);
    return {
        id: typeof me?.username === 'string' ? me.username : undefined,
        nickname: String(me?.name || 'Spotify'),
        avatarUrl: typeof largest?.url === 'string' ? largest.url : '',
    };
};

// 登录是「原生阻塞浏览器流程 + 这里轮询状态」：start 立刻返回 key，check 在看原生结果。
let activeLogin = null;

const loginState = async key => {
    if (!activeLogin || activeLogin.key !== key) return { state: 'expired' };
    const native = nativePlugin();
    if (!native) return { state: 'error', message: 'Spotify requires the Android app' };
    if (activeLogin.confirmed) return { state: 'confirmed' };
    const status = await authStatus();
    if (status.signedIn) {
        activeLogin.confirmed = true;
        return { state: 'confirmed' };
    }
    if (activeLogin.failed) {
        return { state: 'error', message: activeLogin.message || 'Spotify sign-in failed' };
    }
    return { state: 'waiting' };
};

const handlers = {
    async login_start() {
        const native = plugin();
        const key = `spotify-${Date.now()}`;
        activeLogin = { key, startedAt: Date.now(), confirmed: false, failed: false };
        // 原生在后台跑完整条浏览器登录；失败原因经 spotifyLoginStatus 读不到，只能在 check 里超时/取消。
        native.spotifyStartLogin().then(result => {
            if (activeLogin?.key !== key) return;
            if (result && result.signedIn) {
                activeLogin.confirmed = true;
                return;
            }
            activeLogin.failed = true;
            activeLogin.message = typeof result?.reason === 'string' ? result.reason : 'Spotify sign-in failed';
        }).catch(error => {
            if (activeLogin?.key !== key) return;
            activeLogin.failed = true;
            activeLogin.message = error instanceof Error ? error.message : String(error);
        });
        return { key, expiresInMs: 3 * 60 * 1000 };
    },
    async login_open() {
        // 原生在 login_start 里已经打开了浏览器。
        return true;
    },
    async login_check(params) {
        return loginState(String(params.key ?? ''));
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
        const user = status.user ?? {};
        return {
            id: typeof user.id === 'string' && user.id ? user.id : status.id,
            nickname: typeof user.displayName === 'string' && user.displayName ? user.displayName : 'Spotify',
            avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
            vipType: user.product === 'premium' ? 1 : 0,
        };
    },
    async logout() {
        activeLogin = null;
        await plugin().spotifyLogout();
        return true;
    },
    async query(params) {
        if (!RENDERER_QUERIES.includes(params.name)) fail('unsupported', 'Unsupported Spotify query');
        const variables = params.variables ?? {};
        if (typeof variables !== 'object' || Array.isArray(variables) || JSON.stringify(variables).length > MAX_VARIABLES_LENGTH) {
            fail('invalid-response', 'Invalid Spotify query');
        }
        return query(params.name, variables);
    },
    async radio(params) {
        if (typeof params.id !== 'string' || !TRACK_ID.test(params.id)) fail('invalid-response', 'Invalid Spotify track');
        const answer = await call(`${SPCLIENT_URL}/inspiredby-mix/v2/seed_to_playlist/spotify:track:${params.id}?response-format=json`, { absent: null });
        const uri = answer?.mediaItems?.[0]?.uri;
        return typeof uri === 'string' && uri.startsWith('spotify:playlist:') ? { uri } : null;
    },
    async lyrics(params) {
        if (typeof params.id !== 'string' || !TRACK_ID.test(params.id)) fail('invalid-response', 'Invalid Spotify track');
        const answer = await call(`${SPCLIENT_URL}/color-lyrics/v2/track/${params.id}?format=json&vocalRemoval=false&market=from_token`,
            { absent: null, headers: { 'app-platform': 'WebPlayer' } });
        const lines = Array.isArray(answer?.lyrics?.lines) ? answer.lyrics.lines : [];
        if (lines.length === 0) return null;
        return {
            timed: answer.lyrics.syncType === 'LINE_SYNCED',
            lines: lines.map(line => ({ startMs: Number(line?.startTimeMs) || 0, words: String(line?.words ?? '') })),
        };
    },
    async audio() {
        fail('unsupported', 'Spotify playback is not available on Android yet');
    },
    async audio_kept() { return false; },
    async audio_keep() { return false; },
    async library(params) {
        const kind = typeof params.uri === 'string' ? LIBRARY_URI.exec(params.uri)?.[1] : undefined;
        if (!kind || typeof params.saved !== 'boolean') fail('invalid-response', 'Invalid Spotify library change');
        if (kind === 'playlist') {
            const list = (await query('fetchPlaylist', { uri: params.uri, offset: 0, limit: 1, enableWatchFeedEntrypoint: false })).playlistV2;
            const owner = list?.ownerV2?.data?.username;
            if (typeof owner !== 'string' || !owner) fail('unsupported', 'Spotify did not say whose the playlist is');
            if (list.currentUserCapabilities?.canAdministratePermissions === true) fail('unsupported', "The playlist is the account's own");
            await change(params.saved ? 'addItemsToRootlist' : 'removeItemsFromRootlist', { uris: [params.uri] });
        } else {
            await change(params.saved ? 'addToLibrary' : 'removeFromLibrary', { libraryItemUris: [params.uri] });
        }
        return true;
    },
    async playlist_edit(params) {
        const uri = `spotify:playlist:${params.id}`;
        const ids = Array.isArray(params.tracks) ? [...new Set(params.tracks)] : [];
        if (!PLAYLIST_URI.test(uri) || !['add', 'remove'].includes(params.action) || ids.length === 0 || ids.length > MAX_SONGS_A_CHANGE
            || !ids.every(id => typeof id === 'string' && TRACK_ID.test(id))) {
            fail('invalid-response', 'Invalid Spotify playlist change');
        }
        const rows = await playlistRows(uri);
        const songs = ids.map(id => `spotify:track:${id}`);
        if (params.action === 'add') {
            const fresh = songs.filter(song => !rows.has(song));
            if (fresh.length > 0) {
                await change('addToPlaylist', { playlistItemUris: fresh, playlistUri: uri, newPosition: { moveType: 'BOTTOM_OF_PLAYLIST', fromUid: null } });
            }
        } else {
            const uids = songs.flatMap(song => rows.get(song) ?? []);
            if (uids.length > 0) await change('removeFromPlaylist', { playlistUri: uri, uids });
        }
        return true;
    },
    async playlist_create(params) {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name || name.length > MAX_NAME_LENGTH) fail('invalid-response', 'Invalid Spotify playlist name');
        const made = await call(`${SPCLIENT_URL}/playlist/v2/playlist?format=json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ops: [{ kind: 'UPDATE_LIST_ATTRIBUTES', updateListAttributes: { newAttributes: { values: { name } } } }] }),
        });
        if (typeof made?.uri !== 'string' || !PLAYLIST_URI.test(made.uri)) fail('invalid-response', 'Spotify did not name the new playlist');
        await change('addItemsToRootlist', { uris: [made.uri] });
        return { uri: made.uri };
    },
};

/** 原生桥的操作入口：返回数据，错误按 { code, message } 抛给 folia.js 的通用处理。 */
export async function handleSpotifyRequest(operation, params = {}) {
    if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, operation)) {
        fail('unsupported', 'Unsupported Spotify operation');
    }
    try {
        return await handlers[operation](params && typeof params === 'object' ? params : {});
    } catch (error) {
        if (error instanceof SpotifyBridgeError) throw error;
        console.warn('[Spotify] request failed', error);
        fail('network', error instanceof Error ? error.message : String(error));
    }
}

export { QUERIES, CHANGES };

import { create } from 'zustand';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import type { HomeViewTab, LocalSong, SongResult, UnifiedSong } from '../types';
import { DEFAULT_ONLINE_PROVIDER_ID } from '../types/onlineMusic';
import type { OnlineProviderId } from '../types/onlineMusic';
import {
    applyLocalLibraryEntityDisplay,
    buildUnifiedLocalSong,
    type LocalLibraryDisplayCatalog,
} from '../services/playbackAdapters';
import { omni } from '../services/onlineMusic/omni';
import { isLocalPlaybackSong, isNavidromePlaybackSong } from '../utils/appPlaybackGuards';
import { isNetworkOffline } from '../utils/networkStatus';

const LAST_HOME_VIEW_TAB_KEY = 'last_home_view_tab';
const DEFAULT_SEARCH_LIMIT = 30;
// searchError 的离线哨兵：显示层据此换成「未连接网络」文案，与真实的搜索失败（服务器/解析问题）区分开。
// 不用布尔字段是为了复用 searchError 的现有管线（空态/底部条都由它驱动），加字段要动 store、缓存与重置的全部路径。
export const SEARCH_OFFLINE_ERROR = 'offline';
export type SearchSource = OnlineProviderId | 'local' | 'navidrome';
export type SearchReturnView = 'home' | 'player';

type SearchExecutorDeps = {
    localSongs: LocalSong[];
    localLibraryCatalog?: LocalLibraryDisplayCatalog;
    t: (key: string, fallback?: string) => string;
};

type SearchExecutionResult = {
    results: UnifiedSong[];
    hasMore: boolean;
    nextOffset: number;
};

type SearchCacheEntry = {
    results: UnifiedSong[];
    offset: number;
    hasMore: boolean;
    scrollTop: number;
};

interface SearchNavigationState {
    homeViewTab: HomeViewTab;
    searchQuery: string;
    searchSourceTab: SearchSource;
    searchResults: UnifiedSong[] | null;
    searchReturnView: SearchReturnView;
    isSearchOpen: boolean;
    isSearching: boolean;
    isLoadingMore: boolean;
    searchError: string | null;
    requestId: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    scrollTop: number;
    searchCache: Record<string, SearchCacheEntry>;
    setHomeViewTab: (tab: HomeViewTab) => void;
    setSearchQuery: (query: string) => void;
    setSearchScrollTop: (scrollTop: number) => void;
    restoreSearch: (payload: { query: string; sourceTab: SearchSource; returnView?: SearchReturnView; }) => void;
    hideSearchOverlay: () => void;
    resetRuntime: (onlineProviderId?: OnlineProviderId) => void;
    followOnlineProvider: (providerId: OnlineProviderId) => void;
    submitSearch: (payload: { query?: string; sourceTab: SearchSource; deps: SearchExecutorDeps; returnView?: SearchReturnView; }) => Promise<boolean>;
    loadMoreSearchResults: (payload: { deps: SearchExecutorDeps; }) => Promise<void>;
}

const getSearchCacheKey = (query: string, sourceTab: SearchSource) => (
    `${sourceTab}:${query.trim().toLowerCase()}`
);

export const resolveSearchSource = (tab: HomeViewTab | SearchSource): SearchSource => {
    if (tab === 'local' || tab === 'navidrome') {
        return tab;
    }
    if (tab !== 'playlist' && tab !== 'albums' && tab !== 'radio' && tab !== 'explore') return tab as OnlineProviderId;
    return DEFAULT_ONLINE_PROVIDER_ID;
};

export const resolveCommandPaletteSearchSource = (
    currentSong: SongResult | null,
    searchSourceTab: SearchSource,
    activeOnlineProviderId: OnlineProviderId,
): SearchSource => {
    if (currentSong && isLocalPlaybackSong(currentSong)) return 'local';
    if (currentSong && isNavidromePlaybackSong(currentSong)) return 'navidrome';
    if (currentSong || searchSourceTab === DEFAULT_ONLINE_PROVIDER_ID) return activeOnlineProviderId;
    return searchSourceTab;
};

const mapLocalSongToUnifiedSong = (
    song: LocalSong,
    catalog?: LocalLibraryDisplayCatalog,
): UnifiedSong => applyLocalLibraryEntityDisplay(buildUnifiedLocalSong({
        localSong: song,
        matchedSong: null,
        coverUrl: song.useOnlineCover ? song.onlineMetadata?.coverUrl || null : null,
        preferOnlineMetadata: false,
    }), catalog);

const searchLocalSongs = (
    deps: SearchExecutorDeps,
    query: string,
): SearchExecutionResult => {
    const lowerQuery = query.toLowerCase();
    const results = deps.localSongs
        .filter(song => {
            const title = song.title.toLowerCase();
            const artist = [
                ...song.importedMetadata.artistNames,
                ...song.onlineMetadata?.artists.map(item => item.name) || [],
            ].join(' ').toLowerCase();
            const album = [song.importedMetadata.albumName, song.onlineMetadata?.album?.name]
                .filter(Boolean).join(' ').toLowerCase();
            return title.includes(lowerQuery) || artist.includes(lowerQuery) || album.includes(lowerQuery);
        })
        .map(song => mapLocalSongToUnifiedSong(song, deps.localLibraryCatalog));

    return {
        results,
        hasMore: false,
        nextOffset: results.length,
    };
};

const searchNavidromeSongs = async (query: string): Promise<SearchExecutionResult> => {
    const config = getNavidromeConfig();
    if (!config) {
        return { results: [], hasMore: false, nextOffset: 0 };
    }

    const response = await navidromeApi.search(config, query, 0, 0, DEFAULT_SEARCH_LIMIT);
    const results = (response.song || []).map(song => {
        const navidromeSong = navidromeApi.toNavidromeSong(config, song);
        return navidromeSong as UnifiedSong;
    });

    return {
        results,
        hasMore: false,
        nextOffset: results.length,
    };
};

const searchOnlineProviderSongs = async (
    providerId: OnlineProviderId,
    query: string,
    limit: number,
    offset: number,
): Promise<SearchExecutionResult> => {
    const page = await omni.searchProviderSongs(providerId, query, { limit, offset });
    return { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset };
};

const executeSearch = async (
    query: string,
    sourceTab: SearchSource,
    offset: number,
    limit: number,
    deps: SearchExecutorDeps
): Promise<SearchExecutionResult> => {
    if (sourceTab === 'local') {
        return searchLocalSongs(deps, query);
    }

    if (sourceTab === 'navidrome') {
        return searchNavidromeSongs(query);
    }

    return searchOnlineProviderSongs(sourceTab, query, limit, offset);
};

const getInitialHomeViewTab = (): HomeViewTab => {
    if (typeof window === 'undefined') {
        return 'playlist';
    }
    const savedTab = localStorage.getItem(LAST_HOME_VIEW_TAB_KEY);
    return savedTab === 'playlist' || savedTab === 'local' || savedTab === 'albums' || savedTab === 'navidrome' || savedTab === 'radio' || savedTab === 'explore'
        ? savedTab
        : 'playlist';
};

export const useSearchNavigationStore = create<SearchNavigationState>((set, get) => ({
    homeViewTab: getInitialHomeViewTab(),
    searchQuery: '',
    searchSourceTab: DEFAULT_ONLINE_PROVIDER_ID,
    searchResults: null,
    searchReturnView: 'home',
    isSearchOpen: false,
    isSearching: false,
    isLoadingMore: false,
    searchError: null,
    requestId: 0,
    offset: 0,
    limit: DEFAULT_SEARCH_LIMIT,
    hasMore: false,
    scrollTop: 0,
    searchCache: {},
    setHomeViewTab: (tab) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(LAST_HOME_VIEW_TAB_KEY, tab);
        }
        set({ homeViewTab: tab });
    },
    setSearchQuery: (query) => set({ searchQuery: query }),
    setSearchScrollTop: (scrollTop) => set(state => {
        const cacheKey = getSearchCacheKey(state.searchQuery, state.searchSourceTab);
        const cached = state.searchCache[cacheKey];
        return {
            scrollTop,
            searchCache: cached
                ? {
                    ...state.searchCache,
                    [cacheKey]: { ...cached, scrollTop },
                }
                : state.searchCache,
        };
    }),
    restoreSearch: ({ query, sourceTab, returnView = 'home' }) => set(state => {
        const cached = state.searchCache[getSearchCacheKey(query, sourceTab)];
        // 离线哨兵要跨过恢复路径活下来：首页搜索提交离线时，submitSearch 先置哨兵、随后 onSearchCommitted 压历史
        // 又立即触发本函数，无脑清 error 会把「未连接网络」洗成「未找到相关结果」。只有还是同一次尝试（同词同源）
        // 且此刻仍离线才保留——回网后再恢复就自然回落到缓存/空结果，后退返回的旧错误也照旧清掉。
        const keepOfflineSentinel = state.searchError === SEARCH_OFFLINE_ERROR
            && state.searchQuery === query
            && state.searchSourceTab === sourceTab
            && isNetworkOffline();
        return {
            searchQuery: query,
            searchSourceTab: sourceTab,
            searchReturnView: returnView,
            searchResults: cached?.results ?? null,
            offset: cached?.offset ?? 0,
            hasMore: cached?.hasMore ?? false,
            scrollTop: cached?.scrollTop ?? 0,
            searchError: keepOfflineSentinel ? SEARCH_OFFLINE_ERROR : null,
            isSearching: false,
            isLoadingMore: false,
            isSearchOpen: true,
        };
    }),
    hideSearchOverlay: () => set({ isSearchOpen: false, searchReturnView: 'home' }),
    resetRuntime: (onlineProviderId) => set(state => ({
        searchQuery: '',
        searchSourceTab: onlineProviderId ?? state.searchSourceTab,
        searchResults: null,
        searchReturnView: 'home',
        isSearchOpen: false,
        isSearching: false,
        isLoadingMore: false,
        searchError: null,
        requestId: state.requestId + 1,
        offset: 0,
        hasMore: false,
        scrollTop: 0,
    })),
    // The overlay's online source is the active provider. A switch moves it through resetRuntime, but
    // the active provider also changes without one (startup, session restore, a Folium mod source going
    // away), so this keeps it in step. Local and Navidrome are left alone, and the results stay: clearing
    // them is the switch's job.
    followOnlineProvider: (providerId) => set(state => (
        state.searchSourceTab === 'local' || state.searchSourceTab === 'navidrome' || state.searchSourceTab === providerId
            ? state
            : { searchSourceTab: providerId }
    )),
    submitSearch: async ({ query, sourceTab, deps, returnView = 'home' }) => {
        const trimmedQuery = (query ?? get().searchQuery).trim();
        if (!trimmedQuery) {
            return false;
        }

        // 离线预检：本地源不走网络，不受影响；在线源与 Navidrome 在断网时请求必然失败，
        // 直接给出离线态（isSearchOpen 照常打开，工作区显示「未连接网络」而不是转圈后报搜索失败）。
        if (sourceTab !== 'local' && isNetworkOffline()) {
            set({
                searchQuery: trimmedQuery,
                searchSourceTab: sourceTab,
                searchReturnView: returnView,
                isSearchOpen: true,
                isSearching: false,
                isLoadingMore: false,
                searchError: SEARCH_OFFLINE_ERROR,
                requestId: get().requestId + 1,
                searchResults: null,
                offset: 0,
                hasMore: false,
                scrollTop: 0,
            });
            return true;
        }

        const requestId = get().requestId + 1;
        set({
            searchQuery: trimmedQuery,
            searchSourceTab: sourceTab,
            searchReturnView: returnView,
            isSearchOpen: true,
            isSearching: true,
            isLoadingMore: false,
            searchError: null,
            requestId,
            searchResults: null,
            offset: 0,
            hasMore: false,
            scrollTop: 0,
        });

        try {
            const result = await executeSearch(trimmedQuery, sourceTab, 0, get().limit, deps);
            if (get().requestId !== requestId) {
                return true;
            }
            set(state => ({
                searchResults: result.results,
                hasMore: result.hasMore,
                offset: result.nextOffset,
                isSearching: false,
                searchCache: {
                    ...state.searchCache,
                    [getSearchCacheKey(trimmedQuery, sourceTab)]: {
                        results: result.results,
                        hasMore: result.hasMore,
                        offset: result.nextOffset,
                        scrollTop: 0,
                    },
                },
            }));
            return true;
        } catch (error) {
            console.error('[SearchStore] submitSearch failed:', error);
            if (get().requestId !== requestId) {
                return true;
            }
            set({
                searchResults: [],
                hasMore: false,
                offset: 0,
                isSearching: false,
                searchError: error instanceof Error ? error.message : 'search_failed',
            });
            return true;
        }
    },
    loadMoreSearchResults: async ({ deps }) => {
        const {
            searchQuery,
            searchSourceTab,
            searchResults,
            hasMore,
            isSearching,
            isLoadingMore,
            offset,
            limit,
        } = get();

        if (
            searchSourceTab === 'local'
            || searchSourceTab === 'navidrome'
            || !hasMore
            || isSearching
            || isLoadingMore
            || !searchQuery.trim()
        ) {
            return;
        }

        // 走到这里一定是在线源的加载更多：断网时不再发起注定失败的请求，把底部条换成离线文案。
        if (isNetworkOffline()) {
            set({ isLoadingMore: false, searchError: SEARCH_OFFLINE_ERROR });
            return;
        }

        const requestId = get().requestId;
        set({ isLoadingMore: true, searchError: null });

        try {
            const result = await executeSearch(searchQuery, searchSourceTab, offset, limit, deps);
            if (get().requestId !== requestId) {
                return;
            }
            set(state => {
                const results = [...(searchResults || []), ...result.results];
                return {
                    searchResults: results,
                    hasMore: result.hasMore,
                    offset: result.nextOffset,
                    isLoadingMore: false,
                    searchCache: {
                        ...state.searchCache,
                        [getSearchCacheKey(searchQuery, searchSourceTab)]: {
                            results,
                            hasMore: result.hasMore,
                            offset: result.nextOffset,
                            scrollTop: state.scrollTop,
                        },
                    },
                };
            });
        } catch (error) {
            console.error('[SearchStore] loadMoreSearchResults failed:', error);
            if (get().requestId === requestId) {
                set({
                    isLoadingMore: false,
                    searchError: error instanceof Error ? error.message : 'search_failed',
                });
            }
        }
    },
}));

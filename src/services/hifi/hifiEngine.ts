import type {
    HifiClockUpdate,
    HifiDevice,
    HifiEngineConfig,
    HifiEngineState,
    HifiErrorEvent,
    HifiInstallResult,
    HifiLoadRequest,
    HifiLoadResult,
    HifiRuntimeStatus,
} from '../../types/hifi';
import { createHifiEngineStore, useHifiEngineStore, type HifiEngineStore } from './hifiEngineStore';
import { createHifiSourceResponder, type HifiSourceResponder } from './hifiSourceResponder';

// src/services/hifi/hifiEngine.ts
// 渲染端的 HiFi 引擎客户端：包住 window.electron.hifi，把主进程推来的状态写进 useHifiEngineStore，把时钟、错误和状态
// 分发给订阅者，替源桥读本地文件。网页版没有这套接口，每个方法都回安全的默认值，不抛错。

export { useHifiEngineStore };
export type { HifiEngineStore, HifiEngineStoreState } from './hifiEngineStore';

export type HifiApi = NonNullable<NonNullable<Window['electron']>['hifi']>;

export type HifiEngine = {
    /** 这个客户端写的 store；单例写的就是 useHifiEngineStore。 */
    store: HifiEngineStore;
    /** 本地歌曲的 sourceKey → File；起播前在这里登记。 */
    responder: HifiSourceResponder;
    /** 订阅主进程的推送；重复调用不重复订阅。没有接口时返回 false。 */
    attach: () => boolean;
    /** 退订主进程的推送并忘掉已见过的 seq，测试用。 */
    detach: () => void;
    refreshRuntime: () => Promise<HifiRuntimeStatus | null>;
    detect: () => Promise<HifiRuntimeStatus | null>;
    install: () => Promise<HifiInstallResult | null>;
    cancelInstall: () => Promise<void>;
    pickRuntimePath: () => Promise<string | null>;
    configure: (config: HifiEngineConfig) => Promise<void>;
    listDevices: () => Promise<HifiDevice[]>;
    load: (request: HifiLoadRequest) => Promise<HifiLoadResult>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    seek: (positionSec: number) => Promise<void>;
    stop: () => Promise<void>;
    setLoopFile: (loop: boolean) => Promise<void>;
    preloadNext: (request: HifiLoadRequest) => Promise<boolean>;
    clearNext: () => Promise<void>;
    /** 主动拉一次引擎状态；比已收下的旧时返回已收下的那份。 */
    getSnapshot: () => Promise<HifiEngineState | null>;
    onState: (listener: (state: HifiEngineState) => void) => () => void;
    onClock: (listener: (update: HifiClockUpdate) => void) => () => void;
    onError: (listener: (event: HifiErrorEvent) => void) => () => void;
    /** 这首歌本次会话里 HiFi 起播失败过，之后都走 Web 引擎。 */
    isSongForcedWeb: (songKey: string) => boolean;
    markSongForcedWeb: (songKey: string) => void;
    clearForcedWeb: () => void;
};

type Listener<T> = (value: T) => void;

const getWindowHifiApi = (): HifiApi | undefined => (
    typeof window === 'undefined' ? undefined : window.electron?.hifi
);

const addListener = <T>(listeners: Set<Listener<T>>, listener: Listener<T>) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** 逐个通知订阅者；一个订阅者抛错不耽误其余的。 */
const notify = <T>(listeners: Set<Listener<T>>, value: T, label: string) => {
    listeners.forEach((listener) => {
        try {
            listener(value);
        } catch (error) {
            console.warn(`[HiFi] ${label} listener failed`, error);
        }
    });
};

const isLoadResult = (value: unknown): value is HifiLoadResult => (
    typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'
);

/** store 默认是新建的一份，测试互不干扰；单例传入 useHifiEngineStore。 */
export const createHifiEngine = (
    getApi: () => HifiApi | undefined = getWindowHifiApi,
    store: HifiEngineStore = createHifiEngineStore(),
): HifiEngine => {
    const stateListeners = new Set<Listener<HifiEngineState>>();
    const clockListeners = new Set<Listener<HifiClockUpdate>>();
    const errorListeners = new Set<Listener<HifiErrorEvent>>();
    const forcedWebSongs = new Set<string>();
    let unsubscribers: Array<() => void> | null = null;
    let lastSeq = Number.NEGATIVE_INFINITY;
    // 刚发出 load / preloadNext 时主进程的状态还没跟上，而起播那一下的时钟先到：这两首的时钟也放行。
    let requestedTrackKey: string | null = null;
    let requestedNextTrackKey: string | null = null;

    const responder = createHifiSourceResponder({
        respond: async (readId, response) => {
            await getApi()?.respondRead(readId, response);
        },
    });

    store.setState({ supported: Boolean(getApi()) });

    const openCircuit = () => {
        if (store.getState().circuitOpen) return;
        console.warn('[HiFi] circuit open: mpv kept failing, the rest of this session plays on the Web engine');
        store.setState({ circuitOpen: true });
    };

    /** 收下一份引擎状态；seq 不比上一份新的是乱序或重发，丢掉。 */
    const acceptState = (state: HifiEngineState) => {
        if (state.seq <= lastSeq) return;
        lastSeq = state.seq;
        if (state.circuitOpen) openCircuit();
        store.setState({ engine: state });
        notify(stateListeners, state, 'state');
    };

    const isClockForKnownTrack = ({ trackKey }: HifiClockUpdate) => {
        if (trackKey === null) return true;
        const engine = store.getState().engine;
        return trackKey === engine?.trackKey
            || trackKey === engine?.next?.trackKey
            || trackKey === requestedTrackKey
            || trackKey === requestedNextTrackKey;
    };

    const handleError = (event: HifiErrorEvent) => {
        console.warn('[HiFi] engine error', event);
        store.setState({ lastError: event });
        if (event.code === 'CIRCUIT_OPEN') openCircuit();
        notify(errorListeners, event, 'error');
    };

    /** 调一个主进程方法；没有接口或调用抛错时回 fallback，不往外抛。 */
    const invoke = async <T>(label: string, fallback: T, call: (api: HifiApi) => Promise<T>): Promise<T> => {
        const api = getApi();
        if (!api) return fallback;
        try {
            return await call(api);
        } catch (error) {
            console.warn(`[HiFi] ${label} failed`, error);
            return fallback;
        }
    };

    const keepRuntime = (runtime: HifiRuntimeStatus | null) => {
        if (runtime) store.setState({ runtime });
        return runtime;
    };

    const load = async (request: HifiLoadRequest): Promise<HifiLoadResult> => {
        const api = getApi();
        if (!api) return { ok: false, errorCode: 'UNSUPPORTED_PLATFORM' };
        requestedTrackKey = request.trackKey;
        let result: HifiLoadResult;
        try {
            const answer: unknown = await api.load(request);
            result = isLoadResult(answer) ? answer : { ok: false, errorCode: 'UNKNOWN' };
        } catch (error) {
            console.warn('[HiFi] load failed', error);
            result = { ok: false, errorCode: 'UNKNOWN' };
        }
        // 只记 trackKey 和来源种类：Navidrome 的 url 里带着凭据。
        const fields = { trackKey: request.trackKey, sourceKind: request.source.kind };
        if (result.ok) {
            acceptState(result.state);
            console.info('[HiFi] load ready', fields);
            return result;
        }
        if (result.detail === 'superseded') {
            console.info('[HiFi] load superseded by a newer one', fields);
            return result;
        }
        console.warn('[HiFi] load failed', { ...fields, errorCode: result.errorCode, detail: result.detail });
        if (result.errorCode === 'CIRCUIT_OPEN') openCircuit();
        store.setState({
            lastError: { code: result.errorCode, trackKey: request.trackKey, detail: result.detail, fatal: true },
        });
        return result;
    };

    return {
        store,
        responder,
        attach: () => {
            if (unsubscribers) return true;
            const api = getApi();
            store.setState({ supported: Boolean(api) });
            if (!api) return false;
            unsubscribers = [
                api.onState(acceptState),
                api.onClock((update) => {
                    if (isClockForKnownTrack(update)) notify(clockListeners, update, 'clock');
                }),
                api.onError(handleError),
                api.onInstallProgress((installProgress) => {
                    store.setState({ installProgress });
                }),
                api.onReadRequest((request) => {
                    void responder.handleRead(request);
                }),
            ];
            return true;
        },
        detach: () => {
            unsubscribers?.forEach(unsubscribe => unsubscribe());
            unsubscribers = null;
            lastSeq = Number.NEGATIVE_INFINITY;
        },
        refreshRuntime: async () => keepRuntime(await invoke('runtime status', null, api => api.getRuntimeStatus())),
        detect: async () => keepRuntime(await invoke('runtime detect', null, api => api.detectRuntime())),
        install: async () => {
            const result = await invoke<HifiInstallResult | null>('runtime install', null, api => api.installRuntime());
            keepRuntime(result?.status ?? null);
            return result;
        },
        cancelInstall: () => invoke('cancel install', undefined, api => api.cancelInstall()),
        pickRuntimePath: async () => (await invoke('pick runtime path', null, api => api.pickRuntimePath())) ?? null,
        configure: config => invoke('configure', undefined, api => api.configure(config)),
        listDevices: async () => {
            const devices = await invoke<HifiDevice[] | null>('list devices', null, api => api.listDevices());
            if (!Array.isArray(devices)) return [];
            store.setState({ devices });
            return devices;
        },
        load,
        play: () => invoke('play', undefined, api => api.play()),
        pause: () => invoke('pause', undefined, api => api.pause()),
        seek: positionSec => invoke('seek', undefined, api => api.seek(positionSec)),
        stop: () => {
            requestedTrackKey = null;
            requestedNextTrackKey = null;
            return invoke('stop', undefined, api => api.stop());
        },
        setLoopFile: loop => invoke('set loop-file', undefined, api => api.setLoopFile(loop)),
        preloadNext: async (request) => {
            if (getApi()) requestedNextTrackKey = request.trackKey;
            return (await invoke('preload next', false, api => api.preloadNext(request))) === true;
        },
        clearNext: () => {
            requestedNextTrackKey = null;
            return invoke('clear next', undefined, api => api.clearNext());
        },
        getSnapshot: async () => {
            const snapshot = await invoke<HifiEngineState | null>('snapshot', null, api => api.getSnapshot());
            if (!snapshot) return null;
            acceptState(snapshot);
            return store.getState().engine ?? snapshot;
        },
        onState: listener => addListener(stateListeners, listener),
        onClock: listener => addListener(clockListeners, listener),
        onError: listener => addListener(errorListeners, listener),
        isSongForcedWeb: songKey => forcedWebSongs.has(songKey),
        markSongForcedWeb: (songKey) => {
            if (forcedWebSongs.has(songKey)) return;
            forcedWebSongs.add(songKey);
            console.info('[HiFi] song falls back to the Web engine for this session', { songKey });
        },
        clearForcedWeb: () => {
            forcedWebSongs.clear();
        },
    };
};

export const hifiEngine = createHifiEngine(getWindowHifiApi, useHifiEngineStore);

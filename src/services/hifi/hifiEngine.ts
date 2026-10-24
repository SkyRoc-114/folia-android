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
    /** 和上一次发出的配置相同就不发；手动 mpv 路径变了，主进程收下后重新取运行时状态。 */
    configure: (config: HifiEngineConfig) => Promise<void>;
    listDevices: () => Promise<HifiDevice[]>;
    /** 取消的载入（见 isHifiLoadCancelled）不记 lastError；mpv 找不到、起不来或太旧时顺带刷新运行时状态。 */
    load: (request: HifiLoadRequest) => Promise<HifiLoadResult>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    seek: (positionSec: number) => Promise<void>;
    stop: () => Promise<void>;
    setLoopFile: (loop: boolean) => Promise<void>;
    preloadNext: (request: HifiLoadRequest) => Promise<boolean>;
    clearNext: () => Promise<void>;
    /** 主动拉一次引擎状态；seq 和已收下的相同也收（主进程拼快照不加 seq），更旧时返回已收下的那份。 */
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

/**
 * HifiLoadResult 失败时 detail 有两个值不算失败，是这次载入被取消了（errorCode 仍是 LOAD_FAILED）：
 * - 'superseded'：一次更新的 load 顶替了它；
 * - 'stopped'：还在载入时被 stop() 取消，比如路由守卫切去 Web 引擎。
 * 这两种不提示、不记 lastError、不让这首歌回落 Web。
 */
const CANCELLED_LOAD_DETAILS: Record<string, string> = {
    superseded: 'superseded by a newer one',
    stopped: 'cancelled by stop',
};

type CancelledLoadResult = Extract<HifiLoadResult, { ok: false }> & { detail: string };

export const isHifiLoadCancelled = (result: HifiLoadResult): result is CancelledLoadResult => (
    !result.ok && typeof result.detail === 'string' && Object.hasOwn(CANCELLED_LOAD_DETAILS, result.detail)
);

/** 这几种失败说明 mpv 本身不能用了（没找到、拉不起来、版本太旧）：运行时状态要重新取，路由才会及时改走 Web。 */
const RUNTIME_FAILURE_CODES: ReadonlySet<string> = new Set(['MPV_NOT_FOUND', 'MPV_SPAWN_FAILED', 'MPV_TOO_OLD']);

/** 两份配置对主进程是否一样；不开软件音量时 mpv 固定 100，音量不同也算一样。 */
const isSameEngineConfig = (a: HifiEngineConfig, b: HifiEngineConfig) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof HifiEngineConfig>);
    return [...keys].every(key => (
        Object.is(a[key], b[key]) || (key === 'volume' && !a.softwareVolume && !b.softwareVolume)
    ));
};

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
    // 最近一次发出（或正在发）的配置：桥在音量变化时也会推，一样的就不再走 IPC。
    let sentConfig: HifiEngineConfig | null = null;
    // 主进程现在按哪个手动 mpv 路径检测；undefined 表示不知道（还没发过，或上一次发送失败）。
    let sentMpvPath: string | null | undefined;

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

    /**
     * 收下主动拉来的快照。主进程拼快照时 seq 不加一，和已收下的相同是常态，而快照是更新的那份（比如暂停时 seek 过）：
     * 写进 store，但不再通知订阅者，同一个 seq 只通知一次（免得 'ended' 之类被处理两遍）。
     */
    const acceptSnapshot = (snapshot: HifiEngineState) => {
        if (snapshot.seq !== lastSeq) {
            acceptState(snapshot);
            return;
        }
        if (snapshot.circuitOpen) openCircuit();
        store.setState({ engine: snapshot });
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

    const refreshRuntime = async () => keepRuntime(await invoke('runtime status', null, api => api.getRuntimeStatus()));

    /**
     * 把设置推给主进程。和上一次发出的一样就跳过；手动 mpv 路径变了，等主进程收下后重新取运行时状态，
     * 否则 runtime.available 还停在旧路径的检测结果上，路由会一直按它走。
     */
    const configure = async (config: HifiEngineConfig) => {
        const api = getApi();
        if (!api) return;
        if (sentConfig && isSameEngineConfig(sentConfig, config)) return;
        const previousMpvPath = sentMpvPath;
        const sending = { ...config };
        sentConfig = sending;
        sentMpvPath = config.mpvPath;
        try {
            await api.configure(config);
        } catch (error) {
            console.warn('[HiFi] configure failed', error);
            // 主进程没收下：忘掉这份，下次同样的配置还会再发。
            if (sentConfig === sending) {
                sentConfig = null;
                sentMpvPath = undefined;
            }
            return;
        }
        if (config.mpvPath !== previousMpvPath) await refreshRuntime();
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
        if (isHifiLoadCancelled(result)) {
            console.info(`[HiFi] load ${CANCELLED_LOAD_DETAILS[result.detail]}`, fields);
            return result;
        }
        console.warn('[HiFi] load failed', { ...fields, errorCode: result.errorCode, detail: result.detail });
        if (result.errorCode === 'CIRCUIT_OPEN') openCircuit();
        store.setState({
            lastError: { code: result.errorCode, trackKey: request.trackKey, detail: result.detail, fatal: true },
        });
        if (RUNTIME_FAILURE_CODES.has(result.errorCode)) await refreshRuntime();
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
        refreshRuntime,
        detect: async () => keepRuntime(await invoke('runtime detect', null, api => api.detectRuntime())),
        install: async () => {
            const result = await invoke<HifiInstallResult | null>('runtime install', null, api => api.installRuntime());
            // 不管装没装成都换上新的运行时状态：主进程装完会重新检测并随结果带回；调用本身失败了就另外问一次。
            if (result?.status) keepRuntime(result.status);
            else await refreshRuntime();
            return result;
        },
        cancelInstall: () => invoke('cancel install', undefined, api => api.cancelInstall()),
        pickRuntimePath: async () => (await invoke('pick runtime path', null, api => api.pickRuntimePath())) ?? null,
        configure,
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
            acceptSnapshot(snapshot);
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

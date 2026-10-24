import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHifiEngine, hifiEngine, type HifiApi } from '@/services/hifi/hifiEngine';
import type {
    HifiClockUpdate,
    HifiEngineState,
    HifiErrorEvent,
    HifiInstallProgress,
    HifiLoadRequest,
    HifiReadRequest,
    HifiRuntimeStatus,
} from '@/types/hifi';

// test/unit/hifi/hifiEngine.test.ts
// 渲染端的 HiFi 引擎客户端：订阅只做一次、按 seq 丢旧状态、时钟只放行认得的曲目、读请求经真的 responder 回给主进程、
// 回落 Web 的歌记在会话里，没有 window.electron.hifi 时每个方法回安全的默认值。

const engineState = (overrides: Partial<HifiEngineState> = {}): HifiEngineState => ({
    status: 'playing',
    processRunning: true,
    trackKey: 'local:1#a',
    songKey: 'local:1',
    sourceKind: 'local',
    localSourceKey: 'source-a',
    durationSec: 200,
    positionSec: 0,
    paused: false,
    loopFile: false,
    audioParams: null,
    audioOutParams: null,
    currentAo: 'pipewire',
    audioDevice: 'auto',
    exclusive: true,
    spdif: null,
    volume: 100,
    track: null,
    next: null,
    errorCode: null,
    circuitOpen: false,
    seq: 1,
    ...overrides,
});

const runtimeStatus = (overrides: Partial<HifiRuntimeStatus> = {}): HifiRuntimeStatus => ({
    available: true,
    path: '/usr/bin/mpv',
    version: '0.41.0',
    source: 'system',
    errorCode: null,
    manualPathRejected: false,
    platform: 'linux',
    arch: 'x64',
    download: { supported: false, version: null, installedVersion: null, updateAvailable: false, installing: false },
    dopCapable: false,
    ...overrides,
});

const clock = (overrides: Partial<HifiClockUpdate> = {}): HifiClockUpdate => ({
    trackKey: 'local:1#a',
    positionSec: 1,
    paused: false,
    reason: 'tick',
    seq: 1,
    ...overrides,
});

const loadRequest = (trackKey: string): HifiLoadRequest => ({
    trackKey,
    songKey: trackKey.split('#')[0],
    source: { kind: 'local', sourceKey: 'source-a', size: 10, mimeType: 'audio/flac', fileName: 'song.flac' },
    startSec: 0,
    paused: true,
    loopFile: false,
});

/** 一份假的 window.electron.hifi：每个方法都是 vi.fn，onX 的回调存进 push 里由测试代主进程推送。 */
const makeApi = () => {
    const push: {
        state?: (state: HifiEngineState) => void;
        clock?: (update: HifiClockUpdate) => void;
        error?: (event: HifiErrorEvent) => void;
        installProgress?: (progress: HifiInstallProgress) => void;
        read?: (request: HifiReadRequest) => void;
    } = {};
    const unsubscribe = vi.fn();
    const subscribe = <T>(key: keyof typeof push) => vi.fn((callback: (value: T) => void) => {
        (push as Record<string, unknown>)[key] = callback;
        return unsubscribe;
    });
    const api = {
        getRuntimeStatus: vi.fn(async () => runtimeStatus()),
        detectRuntime: vi.fn(async () => runtimeStatus({ source: 'manual' })),
        pickRuntimePath: vi.fn(async () => '/opt/mpv/mpv'),
        installRuntime: vi.fn(async () => ({ ok: true, errorCode: null, status: runtimeStatus({ source: 'downloaded' }) })),
        cancelInstall: vi.fn(async () => undefined),
        configure: vi.fn(async () => undefined),
        listDevices: vi.fn(async () => [{ name: 'auto', description: 'Autoselect device', driver: 'auto', direct: false }]),
        load: vi.fn<HifiApi['load']>(async () => ({ ok: true, state: engineState({ status: 'paused', paused: true }) })),
        play: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
        seek: vi.fn(async (_positionSec: number) => undefined),
        stop: vi.fn(async () => undefined),
        setLoopFile: vi.fn(async (_loop: boolean) => undefined),
        preloadNext: vi.fn(async (_request: HifiLoadRequest) => true),
        clearNext: vi.fn(async () => undefined),
        getSnapshot: vi.fn<HifiApi['getSnapshot']>(async () => engineState()),
        respondRead: vi.fn<HifiApi['respondRead']>(async () => undefined),
        onState: subscribe<HifiEngineState>('state'),
        onClock: subscribe<HifiClockUpdate>('clock'),
        onError: subscribe<HifiErrorEvent>('error'),
        onInstallProgress: subscribe<HifiInstallProgress>('installProgress'),
        onReadRequest: subscribe<HifiReadRequest>('read'),
    } satisfies HifiApi;
    return { api, push, unsubscribe };
};

const setup = () => {
    const fake = makeApi();
    const engine = createHifiEngine(() => fake.api);
    return { ...fake, engine };
};

beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('hifi engine client', () => {
    it('subscribes once however many times attach runs, and again after detach', () => {
        const { api, engine, unsubscribe } = setup();

        expect(engine.store.getState().supported).toBe(true);
        expect(engine.attach()).toBe(true);
        expect(engine.attach()).toBe(true);
        for (const subscribe of [api.onState, api.onClock, api.onError, api.onInstallProgress, api.onReadRequest]) {
            expect(subscribe).toHaveBeenCalledTimes(1);
        }

        engine.detach();
        expect(unsubscribe).toHaveBeenCalledTimes(5);

        engine.attach();
        expect(api.onState).toHaveBeenCalledTimes(2);
    });

    it('keeps the newest state and drops ones whose seq is not newer', () => {
        const { push, engine } = setup();
        const seen = vi.fn();
        engine.onState(seen);
        engine.attach();

        push.state?.(engineState({ seq: 2, positionSec: 20 }));
        push.state?.(engineState({ seq: 1, positionSec: 10 }));
        push.state?.(engineState({ seq: 2, positionSec: 30 }));
        expect(engine.store.getState().engine?.positionSec).toBe(20);
        expect(seen).toHaveBeenCalledTimes(1);

        push.state?.(engineState({ seq: 3, circuitOpen: true }));
        expect(engine.store.getState().engine?.seq).toBe(3);
        expect(engine.store.getState().circuitOpen).toBe(true);
        expect(seen).toHaveBeenCalledTimes(2);
    });

    it('answers getSnapshot with the newer pushed state when the snapshot is older', async () => {
        const { api, push, engine } = setup();
        engine.attach();
        push.state?.(engineState({ seq: 5, positionSec: 50 }));
        api.getSnapshot.mockResolvedValueOnce(engineState({ seq: 4, positionSec: 40 }));

        expect((await engine.getSnapshot())?.seq).toBe(5);

        api.getSnapshot.mockResolvedValueOnce(engineState({ seq: 6, positionSec: 60 }));
        expect((await engine.getSnapshot())?.positionSec).toBe(60);
        expect(engine.store.getState().engine?.seq).toBe(6);
    });

    it('fans the clock out only for the current, next or just-requested track', async () => {
        const { api, push, engine } = setup();
        const ticks: Array<string | null> = [];
        const unsubscribeClock = engine.onClock(update => ticks.push(update.trackKey));
        engine.attach();
        push.state?.(engineState({ trackKey: 'local:1#a', next: { trackKey: 'local:2#b', songKey: 'local:2' } }));

        push.clock?.(clock({ trackKey: 'local:1#a' }));
        push.clock?.(clock({ trackKey: 'local:9#stale' }));
        push.clock?.(clock({ trackKey: null }));
        push.clock?.(clock({ trackKey: 'local:2#b' }));
        expect(ticks).toEqual(['local:1#a', null, 'local:2#b']);

        // 起播那一下的时钟比主进程的状态先到。
        let finishLoad: (value: Awaited<ReturnType<HifiApi['load']>>) => void = () => {};
        api.load.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
        const pending = engine.load(loadRequest('local:3#c'));
        push.clock?.(clock({ trackKey: 'local:3#c', reason: 'load' }));
        expect(ticks.at(-1)).toBe('local:3#c');
        finishLoad({ ok: true, state: engineState({ seq: 2, trackKey: 'local:3#c' }) });
        await pending;

        await engine.stop();
        push.clock?.(clock({ trackKey: 'local:2#b' }));
        expect(ticks).toHaveLength(4);

        unsubscribeClock();
        push.clock?.(clock({ trackKey: 'local:3#c' }));
        expect(ticks).toHaveLength(4);
    });

    it('reads a registered File for the bridge and replies through respondRead', async () => {
        const { api, push, engine } = setup();
        engine.attach();
        engine.responder.register('source-a', new File([Uint8Array.from([0, 1, 2, 3, 4, 5])], 'song.flac'));

        push.read?.({ readId: 'read-1', sourceKey: 'source-a', offset: 2, length: 3 });
        push.read?.({ readId: 'read-2', sourceKey: 'source-gone', offset: 0, length: 3 });

        await vi.waitFor(() => expect(api.respondRead).toHaveBeenCalledTimes(2));
        const replies = new Map(api.respondRead.mock.calls);
        const first = replies.get('read-1');
        expect(first?.status).toBe('ok');
        expect(first?.status === 'ok' ? Array.from(first.data) : []).toEqual([2, 3, 4]);
        expect(replies.get('read-2')).toEqual({ status: 'unknown-source' });
    });

    it('records pushed errors, fans them out and opens the circuit on CIRCUIT_OPEN', () => {
        const { push, engine } = setup();
        const errors = vi.fn();
        engine.onError(errors);
        engine.attach();

        const crash: HifiErrorEvent = { code: 'MPV_CRASHED', trackKey: 'local:1#a', fatal: true };
        push.error?.(crash);
        expect(engine.store.getState().lastError).toEqual(crash);
        expect(engine.store.getState().circuitOpen).toBe(false);

        push.error?.({ code: 'CIRCUIT_OPEN', trackKey: null, fatal: true });
        expect(engine.store.getState().circuitOpen).toBe(true);
        expect(errors).toHaveBeenCalledTimes(2);
    });

    it('applies a load result: the state on success, lastError and the circuit on failure', async () => {
        const { api, engine } = setup();

        await engine.load(loadRequest('local:1#a'));
        expect(engine.store.getState().engine?.status).toBe('paused');

        api.load.mockResolvedValueOnce({ ok: false, errorCode: 'LOAD_FAILED', detail: 'superseded' });
        await engine.load(loadRequest('local:1#b'));
        expect(engine.store.getState().lastError).toBeNull();

        api.load.mockResolvedValueOnce({ ok: false, errorCode: 'CIRCUIT_OPEN' });
        await engine.load(loadRequest('local:1#c'));
        expect(engine.store.getState().lastError).toMatchObject({ code: 'CIRCUIT_OPEN', trackKey: 'local:1#c', fatal: true });
        expect(engine.store.getState().circuitOpen).toBe(true);

        api.load.mockRejectedValueOnce(new Error('Error invoking remote method'));
        expect(await engine.load(loadRequest('local:1#d'))).toEqual({ ok: false, errorCode: 'UNKNOWN' });
    });

    it('keeps runtime, devices and install progress in the store', async () => {
        const { push, engine } = setup();
        engine.attach();

        expect((await engine.refreshRuntime())?.source).toBe('system');
        expect((await engine.detect())?.source).toBe('manual');
        expect((await engine.install())?.ok).toBe(true);
        expect(engine.store.getState().runtime?.source).toBe('downloaded');
        expect(await engine.pickRuntimePath()).toBe('/opt/mpv/mpv');

        expect(await engine.listDevices()).toHaveLength(1);
        expect(engine.store.getState().devices[0]?.name).toBe('auto');

        const progress: HifiInstallProgress = { phase: 'downloading', version: '0.41.0', receivedBytes: 1, totalBytes: 2, errorCode: null };
        push.installProgress?.(progress);
        expect(engine.store.getState().installProgress).toEqual(progress);
    });

    it('never throws from transport calls when the main process rejects', async () => {
        const { api, engine } = setup();
        const warn = vi.mocked(console.warn);
        const failure = new Error('ipc gone');
        for (const call of [api.play, api.pause, api.seek, api.stop, api.setLoopFile, api.clearNext, api.configure]) {
            call.mockRejectedValueOnce(failure);
        }
        api.preloadNext.mockRejectedValueOnce(failure);
        api.listDevices.mockRejectedValueOnce(failure);

        await expect(engine.play()).resolves.toBeUndefined();
        await expect(engine.pause()).resolves.toBeUndefined();
        await expect(engine.seek(12)).resolves.toBeUndefined();
        await expect(engine.stop()).resolves.toBeUndefined();
        await expect(engine.setLoopFile(true)).resolves.toBeUndefined();
        await expect(engine.clearNext()).resolves.toBeUndefined();
        await expect(engine.configure({ mpvPath: null, audioDevice: 'auto', exclusive: true, dsdMode: 'pcm', softwareVolume: false, volume: 100 })).resolves.toBeUndefined();
        await expect(engine.preloadNext(loadRequest('local:2#b'))).resolves.toBe(false);
        await expect(engine.listDevices()).resolves.toEqual([]);
        expect(warn).toHaveBeenCalledWith('[HiFi] play failed', failure);
        expect(api.seek).toHaveBeenCalledWith(12);
    });

    it('remembers songs that fell back to the Web engine until cleared', () => {
        const { engine } = setup();

        expect(engine.isSongForcedWeb('local:1')).toBe(false);
        engine.markSongForcedWeb('local:1');
        engine.markSongForcedWeb('local:1');
        expect(engine.isSongForcedWeb('local:1')).toBe(true);
        expect(engine.isSongForcedWeb('local:2')).toBe(false);

        engine.clearForcedWeb();
        expect(engine.isSongForcedWeb('local:1')).toBe(false);
    });

    it('returns safe defaults when window.electron.hifi is missing', async () => {
        const engine = createHifiEngine(() => undefined);

        expect(engine.attach()).toBe(false);
        expect(engine.store.getState().supported).toBe(false);
        expect(await engine.load(loadRequest('local:1#a'))).toEqual({ ok: false, errorCode: 'UNSUPPORTED_PLATFORM' });
        expect(await engine.listDevices()).toEqual([]);
        expect(await engine.getSnapshot()).toBeNull();
        expect(await engine.refreshRuntime()).toBeNull();
        expect(await engine.detect()).toBeNull();
        expect(await engine.install()).toBeNull();
        expect(await engine.pickRuntimePath()).toBeNull();
        expect(await engine.preloadNext(loadRequest('local:2#b'))).toBe(false);
        await expect(engine.play()).resolves.toBeUndefined();
        await expect(engine.pause()).resolves.toBeUndefined();
        await expect(engine.seek(3)).resolves.toBeUndefined();
        await expect(engine.stop()).resolves.toBeUndefined();
        expect(engine.store.getState().engine).toBeNull();
    });

    it('the singleton is inert without a window', async () => {
        expect(typeof window).toBe('undefined');
        expect(hifiEngine.attach()).toBe(false);
        expect(await hifiEngine.load(loadRequest('local:1#a'))).toEqual({ ok: false, errorCode: 'UNSUPPORTED_PLATFORM' });
    });
});

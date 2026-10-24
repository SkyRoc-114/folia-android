import type { LocalSong, SongResult } from '../../types';
import type { HifiEngineState, HifiLoadRequest, HifiLoadResult, HifiSourceRequest, PlaybackRoute } from '../../types/hifi';
import type { NavidromeSong } from '../../types/navidrome';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { setAudioSrc, setPlaybackRoute, usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { resolvePlaybackRoute } from './hifiEligibility';
import { hifiEngine, isHifiLoadCancelled, useHifiEngineStore } from './hifiEngine';
import { hifiMediaShim } from './hifiMediaShim';
import {
    claimHifiTrack,
    forgetUnclaimedUnless,
    installHifiRouteGuard,
    noteUnclaimedHifiTrack,
    withoutRouteGuard,
} from './hifiRouteGuard';
import { createSourceKey } from './hifiSourceResponder';
import { applyHifiClock, applyHifiEngineState } from './hifiTrackDriver';
import {
    clearHifiTrack,
    hifiPlaybackClock,
    isCurrentHifiAttempt,
    nextHifiAttempt,
    showHifiTrack,
    useHifiTrackStore,
    type HifiTrack,
} from './hifiTrackStore';
import { navidromeSourceSpec, readLocalSourceSpec } from './sourceSpec';

// src/services/hifi/hifiPlayback.ts
// HiFi 路线的数据流入口：判定一首歌走不走 mpv、起播（或接管窗口重建前还在放的那首，或停着的恢复先不载入）、装上推送驱动和路由守卫。
// 曲目 store、驱动、守卫和传输控制在相邻文件里，经这里导出；React 那一侧（自动播放、结束换歌、失败回落）在 useHifiPlaybackBridge。

export { getHifiPosition, hifiPlaybackClock, useHifiTrackStore } from './hifiTrackStore';
export type { HifiLoadState, HifiTrack, HifiTrackStoreState } from './hifiTrackStore';
export { isHifiRoute, leaveHifiRoute, releaseUnclaimedHifiTrack } from './hifiRouteGuard';
export { hifiTransport } from './hifiTransport';

export type HifiTrackSource =
    | { kind: 'local'; localSong: LocalSong; file: Blob }
    /** streamUrl 是 getStreamUrl(config, id, 'raw')，带着凭据：只交给主进程，不进日志。 */
    | { kind: 'navidrome'; carrier: NavidromeSong; streamUrl: string };

export type BeginHifiTrackOptions = {
    song: SongResult;
    source: HifiTrackSource;
    startSec: number;
    /** 只给恢复路径用：主进程里还在放同一首时接管它，不重新载入。 */
    adoptRunning?: boolean;
    /**
     * 只给恢复路径用：没能接管时先不载入（loadState 'deferred'），停着的恢复不去占输出设备；第一次播放、跳转或自动播放时
     * 由 loadDeferredHifiTrack 从那时的位置载入。
     */
    deferLoad?: boolean;
    /** 起播时 startPlay()（恢复时 startRestore()）给的答案，记在曲目上，见 HifiTrack.stillWanted。不给时一直答是。 */
    stillWanted?: () => boolean;
};

/** cancelled：载入被 stop 取消，但没有更新的起播顶替它。deferred：曲目摆好了，载入等第一次播放。 */
export type BeginHifiTrackOutcome = 'ready' | 'adopted' | 'deferred' | 'failed' | 'superseded' | 'cancelled';

/** 一首本地或 Navidrome 歌曲该走哪套引擎，按设置、运行时、熔断和本次会话的回落记录判定。 */
export const hifiRouteFor = (kind: 'local' | 'navidrome', songKey: string): PlaybackRoute => {
    const settings = useHifiSettingsStore.getState();
    const engine = useHifiEngineStore.getState();
    return resolvePlaybackRoute(kind, {
        supported: engine.supported,
        enabled: settings.enabled,
        navidromeEnabled: settings.navidrome,
        runtimeAvailable: engine.runtime?.available === true,
        circuitOpen: engine.circuitOpen,
        forcedWeb: hifiEngine.isSongForcedWeb(songKey),
    });
};

let installed = false;
let runtimeKnown: Promise<void> = Promise.resolve();

/**
 * 桥挂载时调用，重复调用无副作用：订阅主进程推送、接上时钟和 shim、装上路由守卫、取一次运行时状态，再取一份引擎快照，
 * 记下上一个窗口留下的那一首（没人接管就由路由守卫停掉）。
 */
export const installHifiPlayback = () => {
    if (installed) return;
    installed = true;
    hifiMediaShim.setClockReader(() => hifiPlaybackClock.read());
    hifiEngine.attach();
    hifiEngine.onState((state) => {
        forgetUnclaimedUnless(state.trackKey);
        applyHifiEngineState(state);
    });
    hifiEngine.onClock(applyHifiClock);
    installHifiRouteGuard();
    runtimeKnown = hifiEngine.refreshRuntime().then(() => undefined);
    void hifiEngine.getSnapshot().then(noteUnclaimedHifiTrack);
};

/** 第一次运行时状态问到之后 resolve；恢复路径先等它再判路由，免得启动时 runtime 还是 null 就判成 web。 */
export const whenHifiRuntimeKnown = () => {
    installHifiPlayback();
    return runtimeKnown;
};

const isLoopOne = () => (
    useAudioSettingsStore.getState().loopMode === 'one' && !usePlaybackStore.getState().isFmMode
);

// 被换下的曲目登记的文件：等下一次载入落定再撤，主进程换源那一下可能还在读旧的。
const retiredSourceKeys = new Set<string>();

const unregisterRetiredSources = () => {
    const keep = useHifiTrackStore.getState().current?.localSourceKey ?? null;
    retiredSourceKeys.forEach((sourceKey) => {
        if (sourceKey !== keep) hifiEngine.responder.unregister(sourceKey);
    });
    retiredSourceKeys.clear();
};

/** 后台读源格式，读完时这一次起播还算数才写进 store。 */
const loadSourceSpec = (attempt: number, source: HifiTrackSource) => {
    if (source.kind === 'navidrome') {
        useHifiTrackStore.setState({ sourceSpec: navidromeSourceSpec(source.carrier.navidromeData) });
        return;
    }
    void readLocalSourceSpec(source.file, source.localSong.fileName).then((sourceSpec) => {
        if (isCurrentHifiAttempt(attempt)) useHifiTrackStore.setState({ sourceSpec });
    });
};

const toSourceRequest = (source: HifiTrackSource, localSourceKey: string | null): HifiSourceRequest => {
    if (source.kind === 'local') {
        return {
            kind: 'local',
            sourceKey: localSourceKey ?? '',
            size: source.file.size,
            mimeType: source.file.type || source.localSong.mimeType || '',
            fileName: source.localSong.fileName,
        };
    }
    const { id, suffix } = source.carrier.navidromeData;
    return { kind: 'navidrome', url: source.streamUrl, fileName: suffix ? `${id}.${suffix}` : id };
};

type AdoptableState = HifiEngineState & { trackKey: string };

const canAdopt = (snapshot: HifiEngineState | null, songKey: string, source: HifiTrackSource): snapshot is AdoptableState => (
    snapshot !== null
    && snapshot.processRunning
    && snapshot.trackKey !== null
    && snapshot.songKey === songKey
    && (snapshot.status === 'playing' || snapshot.status === 'paused')
    && snapshot.sourceKind === source.kind
    && (source.kind !== 'local' || snapshot.localSourceKey !== null)
);

/** 接管主进程里还在放的同一首：把文件登记回原来的 sourceKey，时钟和 shim 照快照摆好，不重新载入。 */
const adoptRunningTrack = (
    attempt: number,
    snapshot: AdoptableState,
    { song, source, stillWanted }: { song: SongResult; source: HifiTrackSource; stillWanted: () => boolean },
    songKey: string,
) => {
    const localSourceKey = source.kind === 'local' ? snapshot.localSourceKey : null;
    if (source.kind === 'local' && localSourceKey) hifiEngine.responder.register(localSourceKey, source.file);
    claimHifiTrack(snapshot.trackKey);
    showHifiTrack(
        { trackKey: snapshot.trackKey, songKey, origin: source.kind, song, localSourceKey, stillWanted },
        { positionSec: snapshot.positionSec, paused: snapshot.paused, durationSec: snapshot.durationSec },
        { loadState: 'ready' },
    );
    applyHifiEngineState(snapshot);
    loadSourceSpec(attempt, source);
    console.info('[HiFi] adopted the track mpv is still playing', { trackKey: snapshot.trackKey, status: snapshot.status });
};

/** 一次要发给主进程的载入：哪一次起播的、哪一首、源在哪。延后的载入也是存成这个样子。 */
type HifiLoadJob = { attempt: number; track: HifiTrack; source: HifiTrackSource };

// 延后着的那一次载入（见 BeginHifiTrackOptions.deferLoad）；新的起播或真正载入时清掉。
let deferredJob: HifiLoadJob | null = null;

// 刚从 Web 引擎换过来的那几秒，输出设备可能还没被放开（AudioContext 挂起后，系统要过一会儿才关掉那条输出流）：
// 这段时间里载入报 DEVICE_BUSY 是暂时的，隔一会儿再试几次，再算失败。
const WEB_HANDOVER_WINDOW_MS = 6000;
const BUSY_RETRY_COUNT = 3;
const BUSY_RETRY_DELAY_MS = 1500;
// 上一次从有 Web 源的 Web 路线换到 HiFi 的时刻。
let webEngineLeftAt = Number.NEGATIVE_INFINITY;

const isDeviceBusy = (result: HifiLoadResult) => !result.ok && result.errorCode === 'DEVICE_BUSY';

const waitMs = (ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
});

/**
 * 把一次载入发给主进程，一律暂停着载入；刚离开 Web 引擎时的 DEVICE_BUSY 隔 1.5 秒再试，最多三次。结果按这次起播还算不算数
 * 写进 store：被顶替的什么都不写。
 */
const runHifiLoad = async ({ attempt, track, source }: HifiLoadJob, startSec: number): Promise<BeginHifiTrackOutcome> => {
    const request = (): HifiLoadRequest => ({
        trackKey: track.trackKey,
        songKey: track.songKey,
        source: toSourceRequest(source, track.localSourceKey),
        startSec,
        paused: true,
        loopFile: isLoopOne(),
    });
    let result = await hifiEngine.load(request());
    let retriesLeft = Date.now() - webEngineLeftAt <= WEB_HANDOVER_WINDOW_MS ? BUSY_RETRY_COUNT : 0;
    while (retriesLeft > 0 && isDeviceBusy(result) && isCurrentHifiAttempt(attempt)) {
        retriesLeft -= 1;
        await waitMs(BUSY_RETRY_DELAY_MS);
        if (!isCurrentHifiAttempt(attempt)) break;
        console.info('[HiFi] output device still busy right after the Web engine, loading again', {
            trackKey: track.trackKey,
            retry: BUSY_RETRY_COUNT - retriesLeft,
        });
        result = await hifiEngine.load(request());
    }
    if (!isCurrentHifiAttempt(attempt)) return 'superseded';
    unregisterRetiredSources();
    if (result.ok) {
        useHifiTrackStore.setState({ loadState: 'ready', loadError: null });
        // 载入结果里的状态和已推来的 seq 相同时不会再通知订阅者：这里补一次。
        const engine = useHifiEngineStore.getState().engine;
        if (engine) applyHifiEngineState(engine);
        return 'ready';
    }
    if (isHifiLoadCancelled(result)) {
        useHifiTrackStore.setState({ loadState: 'idle' });
        return 'cancelled';
    }
    useHifiTrackStore.setState({ loadState: 'failed', loadError: result.errorCode });
    return 'failed';
};

/**
 * 摆好一首延后载入的曲目：时钟停在恢复的位置，时长先取歌曲自己的，store 标成 'deferred'。主进程里还占着设备的别的曲目
 * （上一个窗口留下、没接管成的，或停在结尾的）一并停掉：这首停着的恢复不该让设备继续被占着。
 */
const deferHifiLoad = (job: HifiLoadJob, startSec: number, held: HifiEngineState | null) => {
    const durationSec = job.track.song.durationMs > 0 ? job.track.song.durationMs / 1000 : null;
    showHifiTrack(job.track, { positionSec: startSec, paused: true, durationSec }, { loadState: 'deferred' });
    if (durationSec !== null) hifiMediaShim.setDuration(durationSec);
    loadSourceSpec(job.attempt, job.source);
    unregisterRetiredSources();
    deferredJob = job;
    // 'starting'、'loading' 也算：被这次恢复顶替的上一次载入还在主进程里跑，落定了一样会占着设备。
    if (held && held.status !== 'idle' && held.status !== 'stopped') void hifiEngine.stop();
    console.info('[HiFi] restored paused, loading on the first play', { trackKey: job.track.trackKey, startSec });
};

/**
 * 发出延后着的那次载入：从时钟现在的位置（恢复的位置，或之后跳到的位置）暂停着载入；开不开播归桥的自动播放。
 * 当前曲目不是延后着的（已经在载入、换了歌、离开了路线）时什么都不做，返回 null。
 */
export const loadDeferredHifiTrack = async (): Promise<BeginHifiTrackOutcome | null> => {
    const job = deferredJob;
    const { current, loadState } = useHifiTrackStore.getState();
    if (!job || loadState !== 'deferred' || current?.trackKey !== job.track.trackKey || !isCurrentHifiAttempt(job.attempt)) return null;
    deferredJob = null;
    useHifiTrackStore.setState({ loadState: 'loading' });
    console.info('[HiFi] loading the restored track', { trackKey: job.track.trackKey });
    return runHifiLoad(job, hifiPlaybackClock.read());
};

/**
 * 在 HiFi 路线上起播一首：Web 源清空、路线切到 hifi、登记本地文件、后台读源格式，然后一律暂停着载入——开始播放归桥的
 * 自动播放。被更新的起播或离开路线顶替时，await 回来什么都不写。
 */
export const beginHifiTrack = async ({
    song,
    source,
    startSec,
    adoptRunning = false,
    deferLoad = false,
    stillWanted = () => true,
}: BeginHifiTrackOptions): Promise<BeginHifiTrackOutcome> => {
    const attempt = nextHifiAttempt();
    deferredJob = null;
    const songKey = getPlaybackSongKey(song);
    const previousSourceKey = useHifiTrackStore.getState().current?.localSourceKey;
    if (previousSourceKey) retiredSourceKeys.add(previousSourceKey);
    const before = usePlaybackStore.getState();
    if (before.playbackRoute === 'web' && before.audioSrc !== null) webEngineLeftAt = Date.now();
    withoutRouteGuard(() => {
        setAudioSrc(null);
        setPlaybackRoute('hifi');
    });

    let snapshot: HifiEngineState | null = null;
    if (adoptRunning) {
        clearHifiTrack({ loadState: 'loading' });
        snapshot = await hifiEngine.getSnapshot();
        if (!isCurrentHifiAttempt(attempt)) return 'superseded';
        if (canAdopt(snapshot, songKey, source)) {
            adoptRunningTrack(attempt, snapshot, { song, source, stillWanted }, songKey);
            return 'adopted';
        }
    }

    const trackKey = `${songKey}#${createSourceKey().slice(0, 12)}`;
    const localSourceKey = source.kind === 'local' ? createSourceKey() : null;
    if (source.kind === 'local' && localSourceKey) hifiEngine.responder.register(localSourceKey, source.file);
    const safeStartSec = Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
    const job: HifiLoadJob = { attempt, track: { trackKey, songKey, origin: source.kind, song, localSourceKey, stillWanted }, source };
    if (deferLoad) {
        deferHifiLoad(job, safeStartSec, snapshot ?? useHifiEngineStore.getState().engine);
        return 'deferred';
    }
    showHifiTrack(job.track, { positionSec: safeStartSec, paused: true, durationSec: null });
    loadSourceSpec(attempt, source);
    return runHifiLoad(job, safeStartSec);
};

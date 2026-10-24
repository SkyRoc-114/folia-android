import type { LocalSong, SongResult } from '../../types';
import type { HifiEngineState, HifiSourceRequest, PlaybackRoute } from '../../types/hifi';
import type { NavidromeSong } from '../../types/navidrome';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { setAudioSrc, setPlaybackRoute, usePlaybackStore } from '../../stores/usePlaybackStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { resolvePlaybackRoute } from './hifiEligibility';
import { hifiEngine, isHifiLoadCancelled, useHifiEngineStore } from './hifiEngine';
import { hifiMediaShim } from './hifiMediaShim';
import { installHifiRouteGuard, withoutRouteGuard } from './hifiRouteGuard';
import { createSourceKey } from './hifiSourceResponder';
import { applyHifiClock, applyHifiEngineState } from './hifiTrackDriver';
import {
    clearHifiTrack,
    hifiPlaybackClock,
    isCurrentHifiAttempt,
    nextHifiAttempt,
    showHifiTrack,
    useHifiTrackStore,
} from './hifiTrackStore';
import { navidromeSourceSpec, readLocalSourceSpec } from './sourceSpec';

// src/services/hifi/hifiPlayback.ts
// HiFi 路线的数据流入口：判定一首歌走不走 mpv、起播（或接管窗口重建前还在放的那首）、装上推送驱动和路由守卫。
// 曲目 store、驱动、守卫和传输控制在相邻文件里，经这里导出；React 那一侧（自动播放、结束换歌、失败回落）在 useHifiPlaybackBridge。

export { getHifiPosition, hifiPlaybackClock, useHifiTrackStore } from './hifiTrackStore';
export type { HifiLoadState, HifiTrack, HifiTrackStoreState } from './hifiTrackStore';
export { isHifiRoute, leaveHifiRoute } from './hifiRouteGuard';
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
};

/** cancelled：载入被 stop 取消，但没有更新的起播顶替它。 */
export type BeginHifiTrackOutcome = 'ready' | 'adopted' | 'failed' | 'superseded' | 'cancelled';

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

/** 桥挂载时调用，重复调用无副作用：订阅主进程推送、接上时钟和 shim、装上路由守卫、取一次运行时状态。 */
export const installHifiPlayback = () => {
    if (installed) return;
    installed = true;
    hifiMediaShim.setClockReader(() => hifiPlaybackClock.read());
    hifiEngine.attach();
    hifiEngine.onState(applyHifiEngineState);
    hifiEngine.onClock(applyHifiClock);
    installHifiRouteGuard();
    runtimeKnown = hifiEngine.refreshRuntime().then(() => undefined);
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
const adoptRunningTrack = (attempt: number, snapshot: AdoptableState, song: SongResult, songKey: string, source: HifiTrackSource) => {
    const localSourceKey = source.kind === 'local' ? snapshot.localSourceKey : null;
    if (source.kind === 'local' && localSourceKey) hifiEngine.responder.register(localSourceKey, source.file);
    showHifiTrack(
        { trackKey: snapshot.trackKey, songKey, origin: source.kind, song, localSourceKey },
        { positionSec: snapshot.positionSec, paused: snapshot.paused, durationSec: snapshot.durationSec },
        { loadState: 'ready' },
    );
    applyHifiEngineState(snapshot);
    loadSourceSpec(attempt, source);
    console.info('[HiFi] adopted the track mpv is still playing', { trackKey: snapshot.trackKey, status: snapshot.status });
};

/**
 * 在 HiFi 路线上起播一首：Web 源清空、路线切到 hifi、登记本地文件、后台读源格式，然后一律暂停着载入——开始播放归桥的
 * 自动播放。被更新的起播或离开路线顶替时，await 回来什么都不写。
 */
export const beginHifiTrack = async ({ song, source, startSec, adoptRunning = false }: BeginHifiTrackOptions): Promise<BeginHifiTrackOutcome> => {
    const attempt = nextHifiAttempt();
    const songKey = getPlaybackSongKey(song);
    const previousSourceKey = useHifiTrackStore.getState().current?.localSourceKey;
    if (previousSourceKey) retiredSourceKeys.add(previousSourceKey);
    withoutRouteGuard(() => {
        setAudioSrc(null);
        setPlaybackRoute('hifi');
    });

    if (adoptRunning) {
        clearHifiTrack({ loadState: 'loading' });
        const snapshot = await hifiEngine.getSnapshot();
        if (!isCurrentHifiAttempt(attempt)) return 'superseded';
        if (canAdopt(snapshot, songKey, source)) {
            adoptRunningTrack(attempt, snapshot, song, songKey, source);
            return 'adopted';
        }
    }

    const trackKey = `${songKey}#${createSourceKey().slice(0, 12)}`;
    const localSourceKey = source.kind === 'local' ? createSourceKey() : null;
    if (source.kind === 'local' && localSourceKey) hifiEngine.responder.register(localSourceKey, source.file);
    const safeStartSec = Number.isFinite(startSec) && startSec > 0 ? startSec : 0;
    showHifiTrack(
        { trackKey, songKey, origin: source.kind, song, localSourceKey },
        { positionSec: safeStartSec, paused: true, durationSec: null },
    );
    loadSourceSpec(attempt, source);

    const result = await hifiEngine.load({
        trackKey,
        songKey,
        source: toSourceRequest(source, localSourceKey),
        startSec: safeStartSec,
        paused: true,
        loopFile: isLoopOne(),
    });
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

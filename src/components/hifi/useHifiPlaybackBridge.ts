import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { PlayerState } from '../../types';
import type { SongResult, StageLoopMode } from '../../types';
import type { NextTrackOptions, PlaybackNavigationOptions } from '../../types/appPlayback';
import type { HifiErrorCode, HifiPlaybackStatus } from '../../types/hifi';
import { currentTime } from '../../stores/motionSignals';
import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { selectHifiEngineConfig, useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { setDuration, setPlayerState, startLoadingToPlay, usePlaybackStore } from '../../stores/usePlaybackStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { hifiEngine, useHifiEngineStore } from '../../services/hifi/hifiEngine';
import { hifiMediaShim } from '../../services/hifi/hifiMediaShim';
import {
    getHifiPosition,
    hifiPlaybackClock,
    hifiTransport,
    installHifiPlayback,
    isHifiRoute,
    loadDeferredHifiTrack,
    useHifiTrackStore,
    type HifiTrack,
} from '../../services/hifi/hifiPlayback';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// src/components/hifi/useHifiPlaybackBridge.ts
// HiFi 路线在 React 这一侧的接线：装上推送驱动、把设置和循环推给主进程、载入就绪后自动播放、引擎状态写回播放 store、
// 放完换下一首（队尾放开设备）、失败或关掉 HiFi 时让这首在 Web 引擎上接着放。传输控制和跳转用的两个函数也在这里。

type UseHifiPlaybackBridgeParams = {
    handleNextTrack: (options?: NextTrackOptions) => Promise<void> | void;
    playSong: (song: SongResult, queue?: SongResult[], isFmCall?: boolean, options?: PlaybackNavigationOptions) => Promise<void> | void;
    /** 起播时记下的“载入好就播”；自动播放用掉它，和 Web 引擎的自动播放是同一个 ref。 */
    shouldAutoPlayRef: MutableRefObject<boolean>;
    isLyricsLoading: boolean;
    effectiveLoopMode: StageLoopMode;
    isFmMode: boolean;
};

// 队尾停掉 mpv 之后，这一首再按播放要重放（mpv 里已经没有它了）：停的时候记下怎么重放；之后的跳转只改重放的起点。
let queueEndReplay: { trackKey: string; startAtSec: number; replay: (startAtSec: number) => void } | null = null;
// 熔断的提示整个会话只弹一次：之后的歌都走 Web 引擎，不会再有 HiFi 的失败。
let circuitToastShown = false;
// 桥挂载时交来的播放意图（和 Web 引擎的自动播放是同一个 ref），以及已经开播过（或恢复时决定停着）的那一首：
// 模块级的 resumeHifiPlayback / seekHifiRoute 也要用掉或补上这份意图。
const intent: { ref: MutableRefObject<boolean> | null; startedTrackKey: string | null } = { ref: null, startedTrackKey: null };

/**
 * 这一首第一次开播了（不管是谁按的）：用掉播放意图，之后歌词载完时的自动播放不会再把听的人按下的暂停顶掉。
 * 已经开播过的那一首再开播不碰意图：那时的意图（如果有）是之后一次播放的，比如正在取地址的在线歌曲。
 */
const spendPlayIntent = (trackKey: string) => {
    if (intent.startedTrackKey === trackKey) return;
    if (intent.ref) intent.ref.current = false;
    intent.startedTrackKey = trackKey;
};

const showCircuitOpenToast = (t: TFunction) => {
    if (circuitToastShown) return;
    circuitToastShown = true;
    setStatusMessage({ type: 'error', text: t('hifi.errors.CIRCUIT_OPEN') });
};

const isValidDuration = (durationSec: number | null): durationSec is number => (
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
);

/** 队尾停掉 mpv 后还等着重放的那一首，是当前曲目时才算。 */
const pendingQueueEndReplay = (trackKey: string | null | undefined) => (
    queueEndReplay && queueEndReplay.trackKey === trackKey ? queueEndReplay : null
);

/**
 * HiFi 路线上的“播放”。平常是让 mpv 接着放。队尾停掉 mpv 之后再按，交给 playSong 重放这一首：从头，或从停下后跳到的位置
 * （Web 引擎放完再按也是这样）。恢复时还没载入的那一首，这时才载入，载入好由自动播放开播。
 * 返回 true 表示接着放了，调用方照常把状态写成 PLAYING；false 表示状态由别处写（playSong，或载入好之后的自动播放）。
 */
export const resumeHifiPlayback = (): boolean => {
    const { current, loadState } = useHifiTrackStore.getState();
    const pending = pendingQueueEndReplay(current?.trackKey);
    if (pending) {
        queueEndReplay = null;
        pending.replay(pending.startAtSec);
        return false;
    }
    if (current && loadState === 'deferred') {
        if (intent.ref) intent.ref.current = true;
        intent.startedTrackKey = null;
        startLoadingToPlay();
        void loadDeferredHifiTrack();
        return false;
    }
    if (current) spendPlayIntent(current.trackKey);
    void hifiTransport.resume();
    return true;
};

/**
 * HiFi 路线上的跳转；不在 HiFi 路线上时返回 false，调用方走原来的路。进度条的 motion value 当场设好。
 * resume 为 true 时（进度条、歌词行点按，即 seekMainAudio）停着的歌顺带开始播，和它对 <audio> 的做法一样；方向键和遥控器的跳转不带它。
 * mpv 里没有这一首时（队尾停掉了，或恢复时还没载入）不发给 mpv：时钟停到目标，重放或载入从那里开始；没载入的那一首跳一下就载入。
 */
export const seekHifiRoute = (timeSec: number, { resume = false }: { resume?: boolean } = {}): boolean => {
    if (!isHifiRoute()) return false;
    if (!Number.isFinite(timeSec)) return true;
    const target = Math.max(0, timeSec);
    const { current, loadState } = useHifiTrackStore.getState();
    const pending = pendingQueueEndReplay(current?.trackKey);
    if (pending || loadState === 'deferred') {
        hifiPlaybackClock.sync({ positionSec: target, paused: true });
        hifiMediaShim.markSeeked();
        if (pending) pending.startAtSec = target;
        else if (!resume) void loadDeferredHifiTrack();
    } else {
        void hifiTransport.seek(target);
    }
    currentTime.set(target);
    if (resume && hifiTransport.isPaused() && resumeHifiPlayback()) setPlayerState(PlayerState.PLAYING);
    return true;
};

/** 这首歌在当前 store 里的那个对象（同一首歌恢复或补全过信息后是另一个对象），不是当前歌时用起播时的那个。 */
const liveSongOf = (track: HifiTrack): SongResult => {
    const song = usePlaybackStore.getState().currentSong;
    return song && getPlaybackSongKey(song) === track.songKey ? song : track.song;
};

/**
 * 让 playSong 再放这一首，按当前的队列和私人 FM，不跳到播放页。路线由它照常判：失败回落时这首已记成 forcedWeb、关掉 HiFi 时
 * 设置已经不让，都会走 Web 引擎；队尾重放时多半还是 HiFi。
 */
const replayOnPlaySong = (
    playSong: UseHifiPlaybackBridgeParams['playSong'],
    track: HifiTrack,
    label: string,
    options: PlaybackNavigationOptions = {},
) => {
    Promise.resolve(playSong(liveSongOf(track), [], usePlaybackStore.getState().isFmMode, { shouldNavigateToPlayer: false, ...options }))
        .catch(error => console.warn(`[HiFi] ${label} failed`, error));
};

// 挂在 App 里一次。每帧的值不经这里：时钟由 hifiPlayback 驱动，可视化桥逐帧读它。
export function useHifiPlaybackBridge({
    handleNextTrack,
    playSong,
    shouldAutoPlayRef,
    isLyricsLoading,
    effectiveLoopMode,
    isFmMode,
}: UseHifiPlaybackBridgeParams) {
    // Read here rather than passed in: store fields or i18n.
    const { t } = useTranslation();
    const playbackRoute = usePlaybackStore(state => state.playbackRoute);
    const trackKey = useHifiTrackStore(state => state.current?.trackKey ?? null);
    const loadState = useHifiTrackStore(state => state.loadState);
    const volume = useAudioSettingsStore(state => state.volume);
    const isMuted = useAudioSettingsStore(state => state.isMuted);
    const mpvPath = useHifiSettingsStore(state => state.mpvPath);
    const audioDevice = useHifiSettingsStore(state => state.audioDevice);
    const exclusive = useHifiSettingsStore(state => state.exclusive);
    const dsdMode = useHifiSettingsStore(state => state.dsdMode);
    const softwareVolume = useHifiSettingsStore(state => state.softwareVolume);
    const loopFile = effectiveLoopMode === 'one' && !isFmMode;

    // 推送回调里用的最新版本；渲染期不写 ref，放进 effect。
    const latestRef = useRef({ handleNextTrack, playSong, t, loopFile });
    useEffect(() => {
        latestRef.current = { handleNextTrack, playSong, t, loopFile };
    });

    // 排在自动播放之前：同一次提交里它先拿到意图的 ref。
    useEffect(() => {
        intent.ref = shouldAutoPlayRef;
        return () => {
            intent.ref = null;
            intent.startedTrackKey = null;
        };
    }, [shouldAutoPlayRef]);

    useEffect(() => {
        installHifiPlayback();
    }, []);

    // 应用音量原样交给选择器（它换成 mpv 的音量曲线），静音单独下发。和上一次一样的配置 hifiEngine.configure 自己会跳过，
    // 音量拖动时不会每一下都走 IPC。
    useEffect(() => {
        const settings = { mpvPath, audioDevice, exclusive, dsdMode, softwareVolume };
        void hifiEngine.configure(selectHifiEngineConfig(settings, volume, isMuted));
    }, [audioDevice, dsdMode, exclusive, isMuted, mpvPath, softwareVolume, volume]);

    // 换到 HiFi 的那一首随载入带上了 loop-file；这里只管在 HiFi 上改了循环（含进出私人 FM），以及接管时对齐一次。
    useEffect(() => {
        if (playbackRoute !== 'hifi') return;
        void hifiEngine.setLoopFile(loopFile);
    }, [loopFile, playbackRoute]);

    // 载入落定时再对一次：mpv 还在拉起时发的 setLoopFile 主进程只记下，随后被载入请求里的 loop-file 盖掉。
    useEffect(() => {
        if (playbackRoute !== 'hifi' || loadState !== 'ready' || !trackKey) return;
        const engine = useHifiEngineStore.getState().engine;
        const wanted = latestRef.current.loopFile;
        if (engine?.trackKey === trackKey && engine.loopFile !== wanted) void hifiEngine.setLoopFile(wanted);
    }, [loadState, playbackRoute, trackKey]);

    // 自动播放：和 usePlaybackAudioBridge 对 <audio> 的规则一样，歌词还在载入时先不用掉意图。没有意图就是恢复成暂停的样子。
    // 恢复时延后载入的那一首：有意图就现在载入（载入好了再走这里开播），没有就摆成停着的样子，等第一次播放或跳转。
    useEffect(() => {
        if (playbackRoute !== 'hifi' || !trackKey) return;
        if (loadState === 'deferred') {
            if (shouldAutoPlayRef.current) {
                void loadDeferredHifiTrack();
                return;
            }
            if (intent.startedTrackKey === trackKey) return;
            intent.startedTrackKey = trackKey;
            const durationSec = hifiPlaybackClock.state().durationSec;
            if (isValidDuration(durationSec) && usePlaybackStore.getState().duration !== durationSec) setDuration(durationSec);
            setPlayerState(PlayerState.PAUSED);
            return;
        }
        if (loadState !== 'ready' || intent.startedTrackKey === trackKey) return;
        if (shouldAutoPlayRef.current) {
            if (isLyricsLoading) return;
            spendPlayIntent(trackKey);
            void hifiTransport.resume();
            setPlayerState(PlayerState.PLAYING);
            return;
        }
        intent.startedTrackKey = trackKey;
        // 接管窗口重建前还在放的那首时，它可能本来就在放。
        setPlayerState(hifiTransport.isPaused() ? PlayerState.PAUSED : PlayerState.PLAYING);
    }, [isLyricsLoading, loadState, playbackRoute, shouldAutoPlayRef, trackKey]);

    // 引擎状态 → 播放 store、放完、失败。只在当前曲目的状态翻转时动作，同一状态的重复推送（音频参数变了之类）不动。
    useEffect(() => {
        let lastSeen: { trackKey: string; status: HifiPlaybackStatus } | null = null;
        // 已经交给 Web 引擎的那一首（失败回落，或关掉了 HiFi）：只交一次，只提示一次。
        let handedOverTrackKey: string | null = null;
        let endedTrackKey: string | null = null;

        /**
         * 把这一首挪到 Web 引擎上接着放：从 HiFi 现在的位置开始（队尾停下之后是重放的起点），在放或正要开播就接着放，
         * 停着就停着；不再弹“已载入”，挪走的原因那条提示留着。
         */
        const moveToWeb = (track: HifiTrack, label: string) => {
            const pending = pendingQueueEndReplay(track.trackKey);
            if (pending) queueEndReplay = null;
            const playing = usePlaybackStore.getState().playerState === PlayerState.PLAYING || !hifiMediaShim.paused;
            replayOnPlaySong(latestRef.current.playSong, track, label, {
                startAtSec: pending ? pending.startAtSec : getHifiPosition(),
                autoplay: !pending && (intent.ref?.current === true || playing),
                quietLoadedToast: true,
            });
        };

        /**
         * 回落：提示一次、记下这首本次会话走 Web，再让它在 Web 引擎上接着放。那之后又开始了一次播放（点了别的歌、换了下一首）
         * 就不重放：重放会把那次更新的播放顶掉。
         */
        const fail = (track: HifiTrack, code: HifiErrorCode) => {
            if (handedOverTrackKey === track.trackKey) return;
            handedOverTrackKey = track.trackKey;
            const { t: translate } = latestRef.current;
            if (code === 'CIRCUIT_OPEN' || useHifiEngineStore.getState().circuitOpen) showCircuitOpenToast(translate);
            else setStatusMessage({ type: 'error', text: translate(`hifi.errors.${code}`) });
            hifiEngine.markSongForcedWeb(track.songKey);
            if (track.stillWanted?.() === false) {
                console.warn('[HiFi] playback failed after a newer play started, the song is not replayed', { trackKey: track.trackKey, code });
                return;
            }
            console.warn('[HiFi] playback failed, the song plays on the Web engine', { trackKey: track.trackKey, code });
            moveToWeb(track, 'replay on the Web engine');
        };

        /** 放完：和 <audio> 的 onEnded 一样换下一首；队尾没有下一首时停掉 mpv，独占的设备当场放开。 */
        const end = async (track: HifiTrack) => {
            if (endedTrackKey === track.trackKey) return;
            endedTrackKey = track.trackKey;
            await latestRef.current.handleNextTrack({ allowStopOnMissing: true, shouldNavigateToPlayer: false });
            // 有下一首时 handleNextTrack 不等它载入就返回，那时曲目还是这一首；队尾的 stopAtQueueEnd 才把状态写成 IDLE。
            if (!isHifiRoute() || useHifiTrackStore.getState().current?.trackKey !== track.trackKey) return;
            if (usePlaybackStore.getState().playerState !== PlayerState.IDLE) return;
            queueEndReplay = {
                trackKey: track.trackKey,
                startAtSec: 0,
                replay: startAtSec => replayOnPlaySong(
                    latestRef.current.playSong,
                    track,
                    'replay after the queue end',
                    startAtSec > 0 ? { startAtSec } : {},
                ),
            };
            console.info('[HiFi] queue ended, mpv stopped to release the output device', { trackKey: track.trackKey });
            void hifiEngine.stop();
        };

        const sync = () => {
            const track = useHifiTrackStore.getState().current;
            const engine = useHifiEngineStore.getState().engine;
            if (!isHifiRoute() || !track || !engine || engine.trackKey !== track.trackKey) return;
            const playback = usePlaybackStore.getState();
            if (isValidDuration(engine.durationSec) && playback.duration !== engine.durationSec) {
                setDuration(engine.durationSec);
            }
            if (lastSeen?.trackKey === track.trackKey && lastSeen.status === engine.status) return;
            lastSeen = { trackKey: track.trackKey, status: engine.status };
            if (engine.status === 'error') {
                // 还在载入时的 'error' 归载入的结果管（刚离开 Web 引擎时的 DEVICE_BUSY 还在重试）；落定是失败时走 loadState。
                if (useHifiTrackStore.getState().loadState !== 'loading') fail(track, engine.errorCode ?? 'UNKNOWN');
            } else if (engine.status === 'ended') {
                end(track).catch(error => console.warn('[HiFi] moving on after the end failed', error));
            } else if (engine.status === 'playing') {
                spendPlayIntent(track.trackKey);
                if (playback.playerState !== PlayerState.PLAYING || playback.isLoadingToPlay) setPlayerState(PlayerState.PLAYING);
            } else if (engine.status === 'paused' && intent.startedTrackKey === track.trackKey) {
                if (playback.playerState === PlayerState.PLAYING) setPlayerState(PlayerState.PAUSED);
            }
        };

        const unsubscribeEngine = useHifiEngineStore.subscribe((state, previous) => {
            if (state.circuitOpen && !previous.circuitOpen) showCircuitOpenToast(latestRef.current.t);
            if (state.engine !== previous.engine) sync();
        });
        const unsubscribeTrack = useHifiTrackStore.subscribe((state, previous) => {
            if (state.current !== previous.current) sync();
            if (state.loadState === 'failed' && previous.loadState !== 'failed' && state.current && isHifiRoute()) {
                fail(state.current, state.loadError ?? 'LOAD_FAILED');
            }
        });
        // 载入失败只走上面的 loadState；这里是开播之后的致命错误（mpv 崩了、设备没了），没带 trackKey 的算当前这首。
        const unsubscribeError = hifiEngine.onError((event) => {
            const track = useHifiTrackStore.getState().current;
            if (!event.fatal || !track || !isHifiRoute()) return;
            if (event.trackKey !== null && event.trackKey !== track.trackKey) return;
            fail(track, event.code);
        });
        // 关掉 HiFi（或 Navidrome 不再走 HiFi）当场生效：这一首挪到 Web 引擎上接着放，路由守卫随之停掉 mpv、放开设备。
        // 不记 forcedWeb：再打开 HiFi，这首歌下次照样走 mpv。
        const unsubscribeSettings = useHifiSettingsStore.subscribe((state, previous) => {
            const track = useHifiTrackStore.getState().current;
            if (!track || !isHifiRoute() || handedOverTrackKey === track.trackKey) return;
            const switchedOff = (previous.enabled && !state.enabled)
                || (track.origin === 'navidrome' && previous.navidrome && !state.navidrome);
            if (!switchedOff || track.stillWanted?.() === false) return;
            handedOverTrackKey = track.trackKey;
            console.info('[HiFi] HiFi was switched off, the song moves to the Web engine', { trackKey: track.trackKey });
            moveToWeb(track, 'move to the Web engine');
        });
        return () => {
            unsubscribeEngine();
            unsubscribeTrack();
            unsubscribeError();
            unsubscribeSettings();
            queueEndReplay = null;
        };
    }, []);
}

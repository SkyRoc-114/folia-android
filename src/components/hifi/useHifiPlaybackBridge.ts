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
import { setDuration, setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { hifiEngine, useHifiEngineStore } from '../../services/hifi/hifiEngine';
import { hifiTransport, installHifiPlayback, isHifiRoute, useHifiTrackStore, type HifiTrack } from '../../services/hifi/hifiPlayback';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// src/components/hifi/useHifiPlaybackBridge.ts
// HiFi 路线在 React 这一侧的接线：装上推送驱动、把设置和循环推给主进程、载入就绪后自动播放、引擎状态写回播放 store、
// 放完换下一首（队尾放开设备）、失败时提示并让这首回到 Web 引擎。传输控制和跳转用的两个函数也在这里。

type UseHifiPlaybackBridgeParams = {
    handleNextTrack: (options?: NextTrackOptions) => Promise<void> | void;
    playSong: (song: SongResult, queue?: SongResult[], isFmCall?: boolean, options?: PlaybackNavigationOptions) => Promise<void> | void;
    /** 起播时记下的“载入好就播”；自动播放用掉它，和 Web 引擎的自动播放是同一个 ref。 */
    shouldAutoPlayRef: MutableRefObject<boolean>;
    isLyricsLoading: boolean;
    effectiveLoopMode: StageLoopMode;
    isFmMode: boolean;
};

// 队尾停掉 mpv 之后，这一首再按播放要从头重放（mpv 里已经没有它了）：停的时候记下怎么重放。
let queueEndReplay: { trackKey: string; replay: () => void } | null = null;
// 熔断的提示整个会话只弹一次：之后的歌都走 Web 引擎，不会再有 HiFi 的失败。
let circuitToastShown = false;

const showCircuitOpenToast = (t: TFunction) => {
    if (circuitToastShown) return;
    circuitToastShown = true;
    setStatusMessage({ type: 'error', text: t('hifi.errors.CIRCUIT_OPEN') });
};

const isValidDuration = (durationSec: number | null): durationSec is number => (
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
);

/**
 * HiFi 路线上的“播放”。平常是让 mpv 接着放；队尾停掉 mpv 之后再按，就交给 playSong 从头重放这一首（Web 引擎放完再按也是从头）。
 * 返回 true 表示接着放了，调用方照常把状态写成 PLAYING；false 表示交给了 playSong，状态由它写。
 */
export const resumeHifiPlayback = (): boolean => {
    const pending = queueEndReplay;
    if (pending && pending.trackKey === useHifiTrackStore.getState().current?.trackKey) {
        queueEndReplay = null;
        pending.replay();
        return false;
    }
    void hifiTransport.resume();
    return true;
};

/**
 * HiFi 路线上的跳转；不在 HiFi 路线上时返回 false，调用方走原来的路。进度条的 motion value 当场设好。
 * resume 为 true 时（进度条、歌词行点按，即 seekMainAudio）停着的歌顺带开始播，和它对 <audio> 的做法一样；方向键和遥控器的跳转不带它。
 */
export const seekHifiRoute = (timeSec: number, { resume = false }: { resume?: boolean } = {}): boolean => {
    if (!isHifiRoute()) return false;
    if (!Number.isFinite(timeSec)) return true;
    const target = Math.max(0, timeSec);
    void hifiTransport.seek(target);
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
 * 让 playSong 从头再放这一首，按当前的队列和私人 FM，不跳到播放页。路线由它照常判：失败回落时这首已记成 forcedWeb，
 * 会走 Web 引擎；队尾重放时多半还是 HiFi。
 */
const replayOnPlaySong = (playSong: UseHifiPlaybackBridgeParams['playSong'], track: HifiTrack, label: string) => {
    Promise.resolve(playSong(liveSongOf(track), [], usePlaybackStore.getState().isFmMode, { shouldNavigateToPlayer: false }))
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

    // 推送回调里用的最新版本；渲染期不写 ref，放进 effect。
    const latestRef = useRef({ handleNextTrack, playSong, t });
    useEffect(() => {
        latestRef.current = { handleNextTrack, playSong, t };
    });
    // 已经开播过（自动播放用掉了意图，或者恢复时决定停着）的那一首：之后引擎的暂停才写回 PAUSED。
    const startedTrackKeyRef = useRef<string | null>(null);

    useEffect(() => {
        installHifiPlayback();
    }, []);

    // 和上一次一样的配置 hifiEngine.configure 自己会跳过，音量拖动时不会每一下都走 IPC。
    useEffect(() => {
        const settings = { mpvPath, audioDevice, exclusive, dsdMode, softwareVolume };
        void hifiEngine.configure(selectHifiEngineConfig(settings, isMuted ? 0 : volume * 100));
    }, [audioDevice, dsdMode, exclusive, isMuted, mpvPath, softwareVolume, volume]);

    // 换到 HiFi 的那一首随载入带上了 loop-file；这里只管在 HiFi 上改了循环（含进出私人 FM），以及接管时对齐一次。
    const loopFile = effectiveLoopMode === 'one' && !isFmMode;
    useEffect(() => {
        if (playbackRoute !== 'hifi') return;
        void hifiEngine.setLoopFile(loopFile);
    }, [loopFile, playbackRoute]);

    // 自动播放：和 usePlaybackAudioBridge 对 <audio> 的规则一样，歌词还在载入时先不用掉意图。没有意图就是恢复成暂停的样子。
    useEffect(() => {
        if (playbackRoute !== 'hifi' || loadState !== 'ready' || !trackKey) return;
        if (startedTrackKeyRef.current === trackKey) return;
        if (shouldAutoPlayRef.current) {
            if (isLyricsLoading) return;
            shouldAutoPlayRef.current = false;
            startedTrackKeyRef.current = trackKey;
            void hifiTransport.resume();
            setPlayerState(PlayerState.PLAYING);
            return;
        }
        startedTrackKeyRef.current = trackKey;
        // 接管窗口重建前还在放的那首时，它可能本来就在放。
        setPlayerState(hifiTransport.isPaused() ? PlayerState.PAUSED : PlayerState.PLAYING);
    }, [isLyricsLoading, loadState, playbackRoute, shouldAutoPlayRef, trackKey]);

    // 引擎状态 → 播放 store、放完、失败。只在当前曲目的状态翻转时动作，同一状态的重复推送（音频参数变了之类）不动。
    useEffect(() => {
        let lastSeen: { trackKey: string; status: HifiPlaybackStatus } | null = null;
        let failedTrackKey: string | null = null;
        let endedTrackKey: string | null = null;

        /** 回落：提示一次、记下这首本次会话走 Web，再用 playSong 让它在 Web 引擎上重新放。 */
        const fail = (track: HifiTrack, code: HifiErrorCode) => {
            if (failedTrackKey === track.trackKey) return;
            failedTrackKey = track.trackKey;
            const { t: translate, playSong: replay } = latestRef.current;
            if (code === 'CIRCUIT_OPEN' || useHifiEngineStore.getState().circuitOpen) showCircuitOpenToast(translate);
            else setStatusMessage({ type: 'error', text: translate(`hifi.errors.${code}`) });
            hifiEngine.markSongForcedWeb(track.songKey);
            console.warn('[HiFi] playback failed, the song plays on the Web engine', { trackKey: track.trackKey, code });
            replayOnPlaySong(replay, track, 'replay on the Web engine');
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
                replay: () => replayOnPlaySong(latestRef.current.playSong, track, 'replay after the queue end'),
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
                fail(track, engine.errorCode ?? 'UNKNOWN');
            } else if (engine.status === 'ended') {
                end(track).catch(error => console.warn('[HiFi] moving on after the end failed', error));
            } else if (engine.status === 'playing') {
                if (playback.playerState !== PlayerState.PLAYING || playback.isLoadingToPlay) setPlayerState(PlayerState.PLAYING);
            } else if (engine.status === 'paused' && startedTrackKeyRef.current === track.trackKey) {
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
        return () => {
            unsubscribeEngine();
            unsubscribeTrack();
            unsubscribeError();
            queueEndReplay = null;
        };
    }, []);
}

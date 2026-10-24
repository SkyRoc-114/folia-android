import { create } from 'zustand';
import type { SongResult } from '../../types';
import type { HifiErrorCode, HifiSourceSpec } from '../../types/hifi';
import { createHifiClock, type HifiClockSync } from './hifiClock';
import { hifiMediaShim } from './hifiMediaShim';

// src/services/hifi/hifiTrackStore.ts
// HiFi 路线上的当前曲目：是哪一首、载入到哪一步、源是什么格式，以及按 mpv 推来的位置外推的播放时钟。只有 hifiPlayback 写它。

export type HifiTrack = {
    /** 这一次起播的键（songKey + 随机后缀）；接管窗口重建前的播放时是主进程那份的键。 */
    trackKey: string;
    songKey: string;
    origin: 'local' | 'navidrome';
    song: SongResult;
    /** 本地歌曲登记在 hifiEngine.responder 的键；Navidrome 为 null。 */
    localSourceKey: string | null;
};

export type HifiLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export type HifiTrackStoreState = {
    current: HifiTrack | null;
    loadState: HifiLoadState;
    /** loadState 为 'failed' 时的错误码。 */
    loadError: HifiErrorCode | null;
    /** 后台读出的源格式；还没读完或读不出时为 null。 */
    sourceSpec: HifiSourceSpec | null;
};

const EMPTY_TRACK_STATE: HifiTrackStoreState = { current: null, loadState: 'idle', loadError: null, sourceSpec: null };

export const useHifiTrackStore = create<HifiTrackStoreState>(() => ({ ...EMPTY_TRACK_STATE }));

/** mpv 位置的外推时钟：可视化、歌词和 shim 的 currentTime 都读它。 */
export const hifiPlaybackClock = createHifiClock();

export const getHifiPosition = () => hifiPlaybackClock.read();

// 每次起播或离开 HiFi 路线都换一个号；await 回来时号已不是自己的，说明被顶替了，什么都不写。
let attemptId = 0;

export const nextHifiAttempt = () => {
    attemptId += 1;
    return attemptId;
};

export const isCurrentHifiAttempt = (id: number) => id === attemptId;

/** 换上一首：时钟、shim 和 store 一起换，观察者不会在新歌上看到上一首残留的播放状态。 */
export const showHifiTrack = (
    track: HifiTrack,
    clock: HifiClockSync,
    patch: Partial<Omit<HifiTrackStoreState, 'current'>> = {},
) => {
    hifiPlaybackClock.sync(clock);
    hifiMediaShim.beginTrack(track.trackKey);
    useHifiTrackStore.setState({ ...EMPTY_TRACK_STATE, loadState: 'loading', ...patch, current: track });
};

/** 没有当前曲目了：时钟归零停住，shim 回到没有源的样子，store 清空。 */
export const clearHifiTrack = (patch: Partial<Omit<HifiTrackStoreState, 'current'>> = {}) => {
    hifiPlaybackClock.sync({ positionSec: 0, paused: true, durationSec: null });
    hifiMediaShim.reset();
    useHifiTrackStore.setState({ ...EMPTY_TRACK_STATE, ...patch });
};

export const isCurrentHifiTrackKey = (trackKey: string | null) => (
    trackKey !== null && trackKey === useHifiTrackStore.getState().current?.trackKey
);

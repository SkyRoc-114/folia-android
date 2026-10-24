// src/services/hifi/hifiClock.ts
// mpv 的位置只按约 4 Hz 推过来；这里记下最近一次的基准，逐帧按 performance.now() 外推，和 Stage 的外推时钟同一做法。

/**
 * 距上一次同步最多外推这么久（秒），约 4 个 250 ms 的 tick。mpv 在缓冲时主进程会报暂停，但那一下到之前、或者推送
 * 整个停了的时候，位置停在这里等下一次同步，而不是一路往前跑、等同步到了再往回跳：歌词和进度条不会跑到没放出来的地方，
 * 播放统计也不会多记没放的秒数。
 */
export const MAX_EXTRAPOLATION_SEC = 1;

export type HifiClockState = {
    baseSec: number;
    /** 基准对应的 performance.now()；暂停时为 null。 */
    startedAtMs: number | null;
    paused: boolean;
    /** 未知时为 null，外推就不按时长封顶（仍受 MAX_EXTRAPOLATION_SEC 限制）。 */
    durationSec: number | null;
};

export type HifiClockSync = {
    positionSec: number;
    paused: boolean;
    /** 省略时沿用上一次的时长，null 表示时长未知。 */
    durationSec?: number | null;
    nowMs?: number;
};

export type HifiClock = {
    sync: (update: HifiClockSync) => void;
    read: (nowMs?: number) => number;
    state: () => HifiClockState;
};

const normalizeDuration = (durationSec: number | null): number | null => (
    typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null
);

const clampToDuration = (timeSec: number, durationSec: number | null) => {
    const nonNegative = Math.max(timeSec, 0);
    return durationSec === null ? nonNegative : Math.min(nonNegative, durationSec);
};

export const createHifiClock = (): HifiClock => {
    let clock: HifiClockState = { baseSec: 0, startedAtMs: null, paused: true, durationSec: null };

    const sync = ({ positionSec, paused, durationSec, nowMs = performance.now() }: HifiClockSync) => {
        const nextDuration = durationSec === undefined ? clock.durationSec : normalizeDuration(durationSec);
        const safePosition = Number.isFinite(positionSec) ? positionSec : 0;
        clock = {
            baseSec: clampToDuration(safePosition, nextDuration),
            startedAtMs: paused ? null : nowMs,
            paused,
            durationSec: nextDuration,
        };
    };

    const read = (nowMs = performance.now()) => {
        if (clock.startedAtMs === null) return clampToDuration(clock.baseSec, clock.durationSec);
        const elapsedSec = Math.min(Math.max(0, (nowMs - clock.startedAtMs) / 1000), MAX_EXTRAPOLATION_SEC);
        return clampToDuration(clock.baseSec + elapsedSec, clock.durationSec);
    };

    return { sync, read, state: () => ({ ...clock }) };
};

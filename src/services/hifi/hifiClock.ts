// src/services/hifi/hifiClock.ts
// mpv 的位置只按约 4 Hz 推过来；这里记下最近一次的基准，逐帧按 performance.now() 外推，和 Stage 的外推时钟同一做法。

export type HifiClockState = {
    baseSec: number;
    /** 基准对应的 performance.now()；暂停时为 null。 */
    startedAtMs: number | null;
    paused: boolean;
    /** 未知时为 null，外推就不封顶。 */
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
        const elapsedSec = Math.max(0, (nowMs - clock.startedAtMs) / 1000);
        return clampToDuration(clock.baseSec + elapsedSec, clock.durationSec);
    };

    return { sync, read, state: () => ({ ...clock }) };
};

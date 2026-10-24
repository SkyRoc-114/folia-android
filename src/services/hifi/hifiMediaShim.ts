import { usePlaybackStore } from '../../stores/usePlaybackStore';

// src/services/hifi/hifiMediaShim.ts
// mpv 发声时给只读的观察者（Media Session、遥控器、听歌上报、Navidrome scrobble……）一个长得像 <audio> 的对象：
// 属性只读，事件按 HTML 媒体元素的顺序和节奏派发，状态由 HiFi 播放桥驱动。

/** 观察者从媒体元素上读的全部成员。 */
export type ObservedMedia = Pick<
    HTMLMediaElement,
    'currentTime' | 'duration' | 'paused' | 'ended' | 'playbackRate' | 'readyState' | 'currentSrc' | 'src' | 'addEventListener' | 'removeEventListener'
>;

/** 和原生元素一样约 4 Hz；两次之间的媒体时间差必须远小于听歌统计判定 seek 的 2 秒。 */
export const HIFI_TIMEUPDATE_INTERVAL_MS = 250;

const HIFI_SOURCE_PREFIX = 'hifi:';

export class HifiMediaShim extends EventTarget {
    private readClock: () => number;
    private trackKey: string | null = null;
    private durationSec = Number.NaN;
    private pausedFlag = true;
    private endedFlag = false;
    private metadataLoaded = false;
    /** mpv 到头后 time-pos 会变得不可用，结束时的位置记在这里。 */
    private endedAtSec: number | null = null;
    private timeupdateTimer: ReturnType<typeof setInterval> | null = null;

    constructor(readClock: () => number = () => 0) {
        super();
        this.readClock = readClock;
    }

    // 只有 getter：漏改的 `media.currentTime = x` 在严格模式下直接抛 TypeError，不会悄悄只改掉本地值。
    get currentTime(): number {
        if (this.trackKey === null) return 0;
        if (this.endedAtSec !== null) return this.endedAtSec;
        const timeSec = this.readClock();
        if (!Number.isFinite(timeSec) || timeSec <= 0) return 0;
        return Number.isFinite(this.durationSec) ? Math.min(timeSec, this.durationSec) : timeSec;
    }

    get duration(): number {
        return this.durationSec;
    }

    get paused(): boolean {
        return this.pausedFlag;
    }

    get ended(): boolean {
        return this.endedFlag;
    }

    get playbackRate(): number {
        return 1;
    }

    get readyState(): number {
        return this.metadataLoaded ? 1 : 0;
    }

    get currentSrc(): string {
        return this.trackKey === null ? '' : `${HIFI_SOURCE_PREFIX}${this.trackKey}`;
    }

    get src(): string {
        return this.currentSrc;
    }

    /** HiFi 播放桥把 hifiClock.read 接进来。 */
    setClockReader(readClock: () => number) {
        this.readClock = readClock;
    }

    /** 换到一首新歌：和原生换源一样，先回到未就绪、暂停、时长未知。 */
    beginTrack(trackKey: string) {
        this.stopTimeupdates();
        this.trackKey = trackKey;
        this.durationSec = Number.NaN;
        this.metadataLoaded = false;
        this.pausedFlag = true;
        this.endedFlag = false;
        this.endedAtSec = null;
    }

    /** 时长第一次可用时派发 durationchange 和 loadedmetadata；之后只有值变了才再派发 durationchange。 */
    setDuration(durationSec: number) {
        if (this.trackKey === null || !Number.isFinite(durationSec) || durationSec <= 0) return;
        if (this.metadataLoaded && durationSec === this.durationSec) return;
        this.durationSec = durationSec;
        this.fire('durationchange');
        if (!this.metadataLoaded) {
            this.metadataLoaded = true;
            this.fire('loadedmetadata');
        }
    }

    markPlaying() {
        if (this.trackKey === null) return;
        const wasPaused = this.pausedFlag;
        this.pausedFlag = false;
        this.endedFlag = false;
        this.endedAtSec = null;
        if (wasPaused) this.fire('play');
        this.fire('playing');
        this.startTimeupdates();
    }

    /** 按 HTML 的暂停步骤：paused 置真，补一次 timeupdate，再派发 pause。 */
    markPaused() {
        if (this.pausedFlag) return;
        this.stopTimeupdates();
        this.pausedFlag = true;
        this.fire('timeupdate');
        this.fire('pause');
    }

    markSeeked() {
        if (this.trackKey === null) return;
        this.endedFlag = false;
        this.endedAtSec = null;
        this.fire('timeupdate');
        this.fire('seeked');
    }

    /** 按 HTML 的结束顺序：最后一次 timeupdate，然后 paused / ended 置真，再派发 pause 和 ended。 */
    markEnded() {
        if (this.trackKey === null || this.endedFlag) return;
        this.stopTimeupdates();
        this.endedAtSec = Number.isFinite(this.durationSec) ? this.durationSec : this.currentTime;
        this.fire('timeupdate');
        const wasPaused = this.pausedFlag;
        this.pausedFlag = true;
        this.endedFlag = true;
        if (!wasPaused) this.fire('pause');
        this.fire('ended');
    }

    /** 离开 HiFi 路线或停掉播放：回到没有源的样子，不派发事件。 */
    reset() {
        this.stopTimeupdates();
        this.trackKey = null;
        this.durationSec = Number.NaN;
        this.metadataLoaded = false;
        this.pausedFlag = true;
        this.endedFlag = false;
        this.endedAtSec = null;
    }

    private fire(type: string) {
        this.dispatchEvent(new Event(type));
    }

    private startTimeupdates() {
        if (this.timeupdateTimer !== null) return;
        this.timeupdateTimer = setInterval(() => this.fire('timeupdate'), HIFI_TIMEUPDATE_INTERVAL_MS);
    }

    private stopTimeupdates() {
        if (this.timeupdateTimer === null) return;
        clearInterval(this.timeupdateTimer);
        this.timeupdateTimer = null;
    }
}

/** 全局只有一个 shim，观察者拿到的对象身份不随换歌变化。 */
export const hifiMediaShim = new HifiMediaShim();

/** 观察者该看的媒体：走 HiFi 时是 shim，否则是传入的 <audio>。 */
export const getObservedMedia = (fallback: HTMLAudioElement | null): ObservedMedia | null => (
    usePlaybackStore.getState().playbackRoute === 'hifi' ? hifiMediaShim : fallback
);

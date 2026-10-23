import { nativePlaybackEngine } from './nativePlaybackEngine';

// src/services/playbackEngine/nativeMediaFacade.ts
//
// 原生播放时 `<audio>` 元素是空的，但别处还有几处「听媒体事件」的老代码：
// 听歌打卡（usePlaybackReporter）、Navidrome scrobble、最近播放（useRecentPlaysRecorder）。
// 它们只用到 paused / ended / currentTime / duration 和少数几个事件，所以这里给它们一个
// 形状相同的替身：位置读引擎的插值时钟，事件由引擎事件转出来。
//
// 这样原生播放不用在「不砍功能」上打折，也不必把三个老调用点改成另一套接口。

type NativeMediaListener = () => void;

export class NativeMediaFacade {
    private listeners = new Map<string, Set<NativeMediaListener>>();
    private unsubscribe: (() => void) | null = null;
    private lastProgressAt = 0;

    get paused(): boolean {
        return !nativePlaybackEngine.isPlaying();
    }

    /** `ended` 只以事件形式到达；这里永远 false，避免调用方把它当成「已经播完」。 */
    get ended(): boolean {
        return false;
    }

    /** 插值后的播放位置（秒），与进度条、歌词读的是同一个数。 */
    get currentTime(): number {
        return nativePlaybackEngine.getPositionSec();
    }

    get duration(): number {
        return nativePlaybackEngine.getDurationSec();
    }

    addEventListener(type: string, listener: NativeMediaListener): void {
        let set = this.listeners.get(type);
        if (!set) {
            set = new Set();
            this.listeners.set(type, set);
        }
        set.add(listener);
        this.ensureSubscription();
    }

    removeEventListener(type: string, listener: NativeMediaListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    private emit(type: string): void {
        const set = this.listeners.get(type);
        if (!set) return;
        set.forEach(listener => {
            try {
                listener();
            } catch (error) {
                console.warn('[NativePlayer] media facade listener failed', error);
            }
        });
    }

    private ensureSubscription(): void {
        if (this.unsubscribe) return;
        this.unsubscribe = nativePlaybackEngine.subscribe(event => {
            switch (event.type) {
                case 'playing':
                    this.emit('play');
                    this.emit('playing');
                    break;
                case 'paused':
                    this.emit('pause');
                    break;
                case 'ended':
                    this.emit('ended');
                    break;
                case 'ready':
                    this.emit('durationchange');
                    break;
                case 'position': {
                    // 一秒一次就够：打卡只关心「听过多少」，高频转发只会多占主线程。
                    const now = Date.now();
                    if (now - this.lastProgressAt < 900) return;
                    this.lastProgressAt = now;
                    this.emit('timeupdate');
                    break;
                }
                default:
                    break;
            }
        });
    }
}

let facade: NativeMediaFacade | null = null;

/** 单例：三个老调用点共享同一份监听，不重复订阅引擎。 */
export const getNativeMediaFacade = (): NativeMediaFacade => {
    if (!facade) facade = new NativeMediaFacade();
    return facade;
};

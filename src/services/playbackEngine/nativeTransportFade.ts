import { useAudioSettingsStore } from '../../stores/useAudioSettingsStore';
import { nativePlaybackEngine } from './nativePlaybackEngine';

// src/services/playbackEngine/nativeTransportFade.ts
//
// Web Audio 那条路的淡入淡出挂在 `playbackFade` 的专用 GainNode 上；原生播放没有这张图，
// 所以这里用 JS 分几步写 `setVolume` 把同一个体验补回来：暂停前 ~150ms 淡出、恢复时淡入。
// 时长取现有淡入淡出的同一个区间（150ms），读的是同一个开关 `playbackFadeEnabled`。
//
// 每一步都是引擎的 `immediate` 写法：普通音量写入会按 60ms 合并，淡入淡出要的是真的落到
// 桥那头的六级音量，不是被合并掉的中间值。

const STEP_MS = 25;
const STEPS = 6;

/** 原生播放的淡入淡出总时长（毫秒）；6 步 × 25ms。 */
export const NATIVE_PLAYBACK_FADE_MS = STEP_MS * STEPS;

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/** 与 `playbackFade` 同形的一小组接口，测试可以直接驱动。 */
export class NativeTransportFade {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private generation = 0;
    private pendingPause: (() => void) | null = null;

    private isEnabled(): boolean {
        return useAudioSettingsStore.getState().playbackFadeEnabled;
    }

    isFadingOut(): boolean {
        return this.pendingPause !== null;
    }

    /** 取消挂起的暂停/淡出；返回是否真的取消了一个。 */
    cancelPendingPause(): boolean {
        const had = this.pendingPause !== null;
        this.pendingPause = null;
        this.generation += 1;
        this.clearTimer();
        return had;
    }

    /** 取消一切并保持当前音量（切歌、回落到网页路径时调用）。 */
    cancel(): void {
        this.pendingPause = null;
        this.generation += 1;
        this.clearTimer();
    }

    /**
     * 淡入到目标音量。返回 false 表示没有淡入（功能关着 / 原生手上没有歌），
     * 调用方按原来的方式直接设置音量即可。
     */
    fadeIn(getTargetVolume: () => number): boolean {
        this.cancel();
        if (!this.isEnabled() || !nativePlaybackEngine.ownsPlayback()) return false;
        const target = clamp01(getTargetVolume());
        const start = clamp01(nativePlaybackEngine.getVolume());
        if (Math.abs(target - start) < 0.01) {
            nativePlaybackEngine.setVolume(target, { immediate: true });
            return true;
        }
        const token = this.generation;
        let step = 0;
        const tick = () => {
            if (token !== this.generation) return;
            step += 1;
            const value = start + (target - start) * (step / STEPS);
            nativePlaybackEngine.setVolume(value, { immediate: true });
            if (step < STEPS) {
                this.timer = setTimeout(tick, STEP_MS);
            } else {
                this.timer = null;
            }
        };
        this.timer = setTimeout(tick, STEP_MS);
        return true;
    }

    /**
     * 淡出到静音后执行 `action`（真正暂停）。返回 false 表示没得淡（功能关着 / 没在播），
     * 调用方直接暂停。已经有一个挂起的暂停时返回 true（幂等）。
     */
    fadeOutThen(action: () => void): boolean {
        if (!this.isEnabled() || !nativePlaybackEngine.ownsPlayback() || !nativePlaybackEngine.isPlaying()) {
            return false;
        }
        if (this.pendingPause) return true;
        this.generation += 1;
        const token = this.generation;
        this.pendingPause = action;
        const start = clamp01(nativePlaybackEngine.getVolume());
        let step = 0;
        const tick = () => {
            if (token !== this.generation) return;
            step += 1;
            nativePlaybackEngine.setVolume(start * (1 - step / STEPS), { immediate: true });
            if (step < STEPS) {
                this.timer = setTimeout(tick, STEP_MS);
                return;
            }
            this.timer = null;
            const pending = this.pendingPause;
            this.pendingPause = null;
            pending?.();
        };
        this.timer = setTimeout(tick, STEP_MS);
        return true;
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

/** 全局只有一个原生播放器，所以也只有一个淡入淡出。 */
export const nativeTransportFade = new NativeTransportFade();

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// src/services/playbackEngine/nativePlayerPlugin.ts
// 原生播放内核的 JS 侧声明。与 android/.../player/FoliaNativePlayerPlugin.java 一一对应：
// 插件名（FoliaNativePlayer）、事件名（foliaNativePlayer）和字段名改一处两边都要改。
//
// 契约（Java 同事按这个实现）：
//   prepare({ url, startPositionMs, repeatMode }) / play() / pause() / stop()
//   seek({ positionMs }) / setVolume({ volume }) / setSpeed({ speed })
//   setSpectrumEnabled({ enabled }) / getSnapshot() / release()
//   事件 { type: 'ready'|'playing'|'paused'|'ended'|'position'|'buffering'|'error'|'idle',
//          positionMs, durationMs, message? }
//   频谱事件 { type: 'spectrum', bands: { bass, lowMid, mid, vocal, treble, power },
//              spectrum: number[128], sampleRate }

export type NativePlaybackEventType =
    | 'ready'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'position'
    | 'buffering'
    | 'error'
    | 'idle';

/** 与原生 `Visualizer` 对齐的频谱带，量纲 0..255（见 nativePlaybackEngine 的归一化）。 */
export type NativeAudioBands = {
    bass: number;
    lowMid: number;
    mid: number;
    vocal: number;
    treble: number;
    power: number;
};

export type NativePlaybackEvent = {
    type: NativePlaybackEventType;
    positionMs?: number;
    durationMs?: number;
    message?: string;
};

export type NativeSpectrumEvent = {
    type: 'spectrum';
    bands: NativeAudioBands;
    spectrum: number[];
    sampleRate?: number;
};

/** 插件推上来的全部事件：播放状态 + 频谱。 */
export type NativePlayerEvent = NativePlaybackEvent | NativeSpectrumEvent;

export type NativePlaybackSnapshot = {
    positionMs: number;
    durationMs: number;
    playing: boolean;
};

export interface FoliaNativePlayerPlugin {
    prepare(options: {
        url: string;
        /** 从哪一秒继续（切歌/回落交接时保留位置）。 */
        startPositionMs?: number | null;
        /** Player.REPEAT_MODE_OFF(0) / ONE(1) / ALL(2)，与 androidx.media3.common.Player 一致。 */
        repeatMode?: number | null;
    }): Promise<{ ok: boolean }>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seek(options: { positionMs: number }): Promise<void>;
    setVolume(options: { volume: number }): Promise<void>;
    setSpeed(options: { speed: number }): Promise<void>;
    setSpectrumEnabled(options: { enabled: boolean }): Promise<void>;
    getSnapshot(): Promise<NativePlaybackSnapshot>;
    release(): Promise<void>;
    addListener(
        eventName: 'foliaNativePlayer',
        listener: (event: NativePlayerEvent) => void,
    ): Promise<PluginListenerHandle>;
}

const FoliaNativePlayer = registerPlugin<FoliaNativePlayerPlugin>('FoliaNativePlayer');

/**
 * 这个插件是不是真的在。
 *
 * 不能用 `typeof FoliaNativePlayer?.play === 'function'` 判：registerPlugin() 给回来的是代理，
 * 方法名问过去永远是 function，原生侧一行没写也会返回 true。必须查原生上报的 pluginHeaders
 * （同步），否则会出现「开关开着、播放器其实不存在」的静默降级。
 */
export const isNativePlayerAvailable = (): boolean => {
    if (typeof Capacitor === 'undefined') return false;
    if (!Capacitor.isNativePlatform()) return false;
    return Capacitor.isPluginAvailable('FoliaNativePlayer');
};

/**
 * 跑在原生外壳里（Android App），与「插件已经注册」分开。
 *
 * 设置页那一行按这个显示：插件还没落地时也能先把开关摆出来，真机联调不用等 Java 那半边。
 */
export const isNativePlaybackShell = (): boolean => (
    typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform()
);

export const nativePlayer = {
    prepare: (options: Parameters<FoliaNativePlayerPlugin['prepare']>[0]) => FoliaNativePlayer.prepare(options),
    play: () => FoliaNativePlayer.play(),
    pause: () => FoliaNativePlayer.pause(),
    stop: () => FoliaNativePlayer.stop(),
    seek: (positionMs: number) => FoliaNativePlayer.seek({ positionMs }),
    setVolume: (volume: number) => FoliaNativePlayer.setVolume({ volume }),
    setSpeed: (speed: number) => FoliaNativePlayer.setSpeed({ speed }),
    setSpectrumEnabled: (enabled: boolean) => FoliaNativePlayer.setSpectrumEnabled({ enabled }),
    getSnapshot: () => FoliaNativePlayer.getSnapshot(),
    release: () => FoliaNativePlayer.release(),
    addListener: (listener: (event: NativePlayerEvent) => void) =>
        FoliaNativePlayer.addListener('foliaNativePlayer', listener),
};

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

// src/services/playbackEngine/nativePlayerPlugin.ts
// 原生播放内核的 JS 侧声明。与 android/.../player/FoliaNativePlayerPlugin.java 一一对应：
// 插件名（FoliaNativePlayer）、事件名（foliaNativePlayer）和字段名改一处两边都要改。
//
// 契约（Java 同事按这个实现）：
//   prepare({ url, startPositionMs, repeatMode }) / play() / pause() / stop()
//   seek({ positionMs }) / setVolume({ volume }) / setSpeed({ speed })
//   setSpectrumEnabled({ enabled }) / setDsp({ enabled, gains, effects, replayGainDb }) / getSnapshot() / release()
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

/** `setDsp` 的音效字段：与 utils/audioEffects.ts 的 AudioEffectSettings 一一对应（九个，顺序无关）。 */
export type NativeDspEffects = {
    highpass: number;
    lowpass: number;
    drive: number;
    crush: number;
    wow: number;
    noise: number;
    width: number;
    space: number;
    punch: number;
};

/**
 * 均衡器 + 音效的 DSP 参数，交给 Java 侧 ExoPlayer 的 AudioProcessor 链处理。
 *
 * 均衡器/音效打开时不再回落网页播放，靠的就是这条通道（见 nativeDsp.ts 与 useNativePlaybackRuntime.ts）。
 * 方法可重复调用、实时生效；ReplayGain 这一轮仍走网页回落，所以 `replayGainDb` 固定 0。
 */
export type NativeDspOptions = {
    /** Web 侧 audioEqualizerSettings.enabled；false 时 Java 旁路整条 DSP（参数照收）。 */
    enabled: boolean;
    /** 10 段 dB，顺序同 AUDIO_EQUALIZER_BANDS（31Hz … 16kHz）。 */
    gains: number[];
    effects: NativeDspEffects;
    /** 暂固定 0：原生 ReplayGain 还没做，RG 非 off 时整首回落网页。 */
    replayGainDb: number;
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
    setDsp(options: NativeDspOptions): Promise<void>;
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
    setDsp: (options: NativeDspOptions) => FoliaNativePlayer.setDsp(options),
    getSnapshot: () => FoliaNativePlayer.getSnapshot(),
    release: () => FoliaNativePlayer.release(),
    addListener: (listener: (event: NativePlayerEvent) => void) =>
        FoliaNativePlayer.addListener('foliaNativePlayer', listener),
};

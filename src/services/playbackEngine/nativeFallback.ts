import type { ReplayGainMode } from '../../types';

// src/services/playbackEngine/nativeFallback.ts
// 「这一首交给原生播放器，还是回落到 <audio>」的唯一判定，纯函数，便于把每种功能组合钉进单测。
//
// 规则只有一条：
//
//     nativeTakes = nativeActive && 源支持 && !webAudioOnlyFeatureActive
//
// nativeActive = 设置里开着原生播放 && 插件真的在（网页/桌面没有这个插件，永远 false）。
// webAudioOnlyFeatureActive = 均衡器（含 mod 曲线）/ 音效 / automix / ReplayGain 非 off /
// blob: 或 data: 源 —— 这些功能长在 Web Audio 图上，原生播放器给不了；不删功能，整首回 <audio>。

export type NativeFallbackReason =
    | 'native-disabled'
    | 'plugin-unavailable'
    | 'stage-playback'
    | 'empty-source'
    | 'blob-source'
    | 'data-source'
    | 'unsupported-source'
    | 'equalizer'
    | 'audio-effects'
    | 'automix'
    | 'replay-gain';

export type NativeTakeoverInput = {
    /** 设置里的「原生播放（实验）」开关。 */
    nativeEnabled: boolean;
    /** Capacitor.isPluginAvailable('FoliaNativePlayer')。 */
    pluginAvailable: boolean;
    source: string | null;
    /** 均衡器处理开没开（enabled）。 */
    equalizerEnabled: boolean;
    /** 有没有一条生效中的 mod 曲线（它同样长在 Web Audio 图上）。 */
    equalizerModCurveActive: boolean;
    /** 音效是不是中性（高/低通、动态、噪声、宽度……全在中位）。 */
    audioEffectsNeutral: boolean;
    automixEnabled: boolean;
    replayGainMode: ReplayGainMode;
    /** Now Playing / PlayerCap 这类外部播放接管时不碰本地播放器。 */
    stageActive?: boolean;
};

export type NativeTakeoverDecision = {
    /** 设置开着且插件在：原生路径「可用」，本首不一定接管。 */
    nativeActive: boolean;
    /** 这一首真的交给原生。 */
    takes: boolean;
    /** 不接管时是哪条规则挡住的；接管时为 null。 */
    reason: NativeFallbackReason | null;
};

/** 只挡原生、网页路径照常的「Web Audio 专属功能」。 */
export const resolveWebAudioOnlyFeature = (input: NativeTakeoverInput): NativeFallbackReason | null => {
    if (input.equalizerEnabled || input.equalizerModCurveActive) return 'equalizer';
    if (!input.audioEffectsNeutral) return 'audio-effects';
    if (input.automixEnabled) return 'automix';
    if (input.replayGainMode !== 'off') return 'replay-gain';
    return null;
};

export const resolveNativeTakeover = (input: NativeTakeoverInput): NativeTakeoverDecision => {
    if (!input.nativeEnabled) {
        return { nativeActive: false, takes: false, reason: 'native-disabled' };
    }
    if (!input.pluginAvailable) {
        return { nativeActive: false, takes: false, reason: 'plugin-unavailable' };
    }
    const nativeActive = true;
    if (input.stageActive) {
        return { nativeActive, takes: false, reason: 'stage-playback' };
    }
    if (!input.source) {
        return { nativeActive, takes: false, reason: 'empty-source' };
    }
    if (input.source.startsWith('blob:')) {
        return { nativeActive, takes: false, reason: 'blob-source' };
    }
    if (input.source.startsWith('data:')) {
        return { nativeActive, takes: false, reason: 'data-source' };
    }
    if (!/^(https?|content|file):\/\//.test(input.source)) {
        return { nativeActive, takes: false, reason: 'unsupported-source' };
    }
    const webAudioOnly = resolveWebAudioOnlyFeature(input);
    if (webAudioOnly) {
        return { nativeActive, takes: false, reason: webAudioOnly };
    }
    return { nativeActive, takes: true, reason: null };
};

/** 诊断里那行「本首是否接管」用的短语。 */
export const describeNativeTakeover = (decision: NativeTakeoverDecision): string => (
    decision.takes ? 'native' : `fallback:${decision.reason ?? 'unknown'}`
);

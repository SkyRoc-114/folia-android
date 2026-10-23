import type { ReplayGainMode } from '../../types';

// src/services/playbackEngine/nativeFallback.ts
// 「这一首交给原生播放器，还是回落到 <audio>」的唯一判定，纯函数，便于把每种功能组合钉进单测。
//
// 规则只有一条：
//
//     nativeTakes = nativeActive && 源支持 && !webPlaybackOnlyFeatureActive
//
// nativeActive = 设置里开着原生播放 && 插件真的在（网页/桌面没有这个插件，永远 false）。
// webPlaybackOnlyFeatureActive = automix / ReplayGain 非 off（源本身的 blob: / data: 另算）。
//
// 均衡器与音效**不在这里**：它们改由原生的 DSP 处理（nativeDsp.ts → FoliaNativePlayer.setDsp），
// 打开均衡器/音效不再把这一首打回网页。ReplayGain 这一轮还没做原生版、automix 的两套 deck 长在
// Web Audio 图上，所以这两项仍然整首回 <audio>。
//
// 顺序也是契约：同一首同时命中多个原因时，日志与诊断里出现的永远是表里靠前的那个。

export type NativeFallbackReason =
    | 'native-disabled'
    | 'plugin-unavailable'
    | 'stage-playback'
    | 'empty-source'
    | 'blob-source'
    | 'data-source'
    | 'unsupported-source'
    | 'automix'
    | 'replay-gain';

export type NativeTakeoverInput = {
    /** 设置里的「原生播放（实验）」开关。 */
    nativeEnabled: boolean;
    /** Capacitor.isPluginAvailable('FoliaNativePlayer')。 */
    pluginAvailable: boolean;
    source: string | null;
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

/**
 * 只挡原生、网页路径照常的功能：automix（两套 deck 在 Web Audio 图上）与 ReplayGain。
 * 均衡器/音效已经改走原生 DSP，不再出现在这里。
 */
export const resolveWebPlaybackOnlyFeature = (input: NativeTakeoverInput): NativeFallbackReason | null => {
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
    const webPlaybackOnly = resolveWebPlaybackOnlyFeature(input);
    if (webPlaybackOnly) {
        return { nativeActive, takes: false, reason: webPlaybackOnly };
    }
    return { nativeActive, takes: true, reason: null };
};

/** 诊断里那行「本首是否接管」用的短语。 */
export const describeNativeTakeover = (decision: NativeTakeoverDecision): string => (
    decision.takes ? 'native' : `fallback:${decision.reason ?? 'unknown'}`
);

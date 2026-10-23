import { AUDIO_EFFECT_CONTROLS, normalizeAudioEffects } from '../../utils/audioEffects';
import {
    AUDIO_EQUALIZER_BANDS,
    normalizeAudioEqualizerGains,
    type AudioEqualizerSettings,
} from '../../utils/audioEqualizer';
import {
    resolveHeardAudioEqualizerSettings,
    type AudioEqualizerModCurve,
} from '../../utils/audioEqualizerModCurve';
import type { NativeDspEffects, NativeDspOptions } from './nativePlayerPlugin';

// src/services/playbackEngine/nativeDsp.ts
// 「原生 DSP 该收到什么」的唯一算法：均衡器十段 + 九个音效，按 Java 的 setDsp 契约整理成纯数据。
//
// 原生接管时均衡器/音效不再回落到网页播放，就靠这里把**实际听到的那一组设置**交出去：
//   · mod 曲线生效（有曲线且没被挂起）→ 用曲线的 gains；否则用听众自己的 settings.gains
//   · enabled=false 也照发（Java 侧旁路整条链），这样打开/关闭都不用切歌
//   · replayGainDb 固定 0：原生 ReplayGain 还没做，RG 非 off 时整首回落（nativeFallback.ts）
//
// 纯函数，单测在 test/unit/playbackEngine/nativeDsp.test.ts。

/** Java 契约里的十段：数量与 AUDIO_EQUALIZER_BANDS 一致，顺序也一致。 */
export const NATIVE_DSP_GAIN_COUNT = AUDIO_EQUALIZER_BANDS.length;

/** 音效字段数：九个，与 Java 的 effects 对象一致。 */
export const NATIVE_DSP_EFFECT_COUNT = AUDIO_EFFECT_CONTROLS.length;

/** 只取 Java 认识的九个字段，并把缺失/越界值收回中位与量程内。 */
export const toNativeDspEffects = (effects: AudioEqualizerSettings['effects']): NativeDspEffects => (
    normalizeAudioEffects(effects)
);

/**
 * 把一组设置整理成可以过桥的 payload：十段、每段有限且夹在 ±12 dB，音效九个字段齐全。
 * 幂等：已经整理过的值再进来还是同一份数据（签名去重靠它）。
 */
export const normalizeNativeDspOptions = (options: NativeDspOptions): NativeDspOptions => ({
    enabled: Boolean(options.enabled),
    gains: normalizeAudioEqualizerGains(options.gains),
    effects: toNativeDspEffects(options.effects),
    replayGainDb: Number.isFinite(options.replayGainDb) ? options.replayGainDb : 0,
});

/**
 * 现在实际该发给原生的 DSP 设置。
 *
 * `curve`/`suspended` 与音频图用同一套规则（resolveHeardAudioEqualizerSettings）：
 * 有曲线且没挂起时十段来自曲线，音效仍是听众自己的；enabled 始终取听众自己的开关。
 */
export const buildNativeDspOptions = (
    settings: AudioEqualizerSettings,
    curve?: AudioEqualizerModCurve | null,
    suspended?: boolean,
): NativeDspOptions => {
    const heard = resolveHeardAudioEqualizerSettings(settings, curve, suspended);
    return normalizeNativeDspOptions({
        enabled: heard.enabled,
        gains: heard.gains,
        effects: heard.effects,
        replayGainDb: 0,
    });
};

/** 诊断里能放的那点摘要：不把十段和九个音效原样抄进报告。 */
export type NativeDspSummary = {
    enabled: boolean;
    /** 十段里不是 0 dB 的有几段。 */
    nonZeroBands: number;
    /** 十段里最大的一段（dB）。 */
    peakGainDb: number;
    /** 十段的平均值（dB）。 */
    averageGainDb: number;
    /** 九个音效里偏离中位的有几个。 */
    nonNeutralEffects: number;
    replayGainDb: number;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

export const summarizeNativeDsp = (options: NativeDspOptions): NativeDspSummary => {
    const gains = normalizeAudioEqualizerGains(options.gains);
    const effects = normalizeAudioEffects(options.effects);
    const total = gains.reduce((sum, gain) => sum + gain, 0);
    return {
        enabled: Boolean(options.enabled),
        nonZeroBands: gains.filter(gain => gain !== 0).length,
        peakGainDb: round1(gains.reduce((peak, gain) => Math.max(peak, gain), gains[0] ?? 0)),
        averageGainDb: round1(total / Math.max(1, gains.length)),
        nonNeutralEffects: AUDIO_EFFECT_CONTROLS.filter(control => effects[control.id] !== control.neutral).length,
        replayGainDb: Number.isFinite(options.replayGainDb) ? options.replayGainDb : 0,
    };
};

/** 一行日志/诊断用的短语：只有 enabled、段数、峰值/均值、音效个数与 RG。 */
export const describeNativeDsp = (options: NativeDspOptions): string => {
    const summary = summarizeNativeDsp(options);
    return `enabled=${summary.enabled ? 'on' : 'off'}`
        + ` bands=${NATIVE_DSP_GAIN_COUNT}`
        + ` nonzero=${summary.nonZeroBands}`
        + ` peak=${summary.peakGainDb.toFixed(1)}dB avg=${summary.averageGainDb.toFixed(1)}dB`
        + ` effects=${summary.nonNeutralEffects}/${NATIVE_DSP_EFFECT_COUNT}`
        + ` replayGain=${summary.replayGainDb}dB`;
};

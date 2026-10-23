import { describe, expect, it } from 'vitest';
import {
    describeNativeTakeover,
    resolveNativeTakeover,
    resolveWebPlaybackOnlyFeature,
    type NativeTakeoverInput,
} from '@/services/playbackEngine/nativeFallback';

// test/unit/playbackEngine/nativeFallback.test.ts
// 自动回落矩阵：原生播放只在「源吃得下 + 没有网页专属功能」时接管这一首。
// 均衡器与音效**不再**是回落原因（它们走原生 DSP，见 nativeDsp.test.ts）；
// 现在还会挡原生的只剩 automix 与 ReplayGain，以及源本身。

const base = (overrides: Partial<NativeTakeoverInput> = {}): NativeTakeoverInput => ({
    nativeEnabled: true,
    pluginAvailable: true,
    source: 'https://cdn.example.test/song.mp3',
    automixEnabled: false,
    replayGainMode: 'off',
    stageActive: false,
    ...overrides,
});

describe('native takeover decision', () => {
    it('takes a plain http source when nothing web-playback-only is on', () => {
        const decision = resolveNativeTakeover(base());

        expect(decision).toEqual({ nativeActive: true, takes: true, reason: null });
        expect(describeNativeTakeover(decision)).toBe('native');
    });

    it('reports the switch and the plugin separately', () => {
        expect(resolveNativeTakeover(base({ nativeEnabled: false }))).toEqual({
            nativeActive: false, takes: false, reason: 'native-disabled',
        });
        expect(resolveNativeTakeover(base({ pluginAvailable: false }))).toEqual({
            nativeActive: false, takes: false, reason: 'plugin-unavailable',
        });
    });

    it('never takes a stage playback or a source the player cannot open', () => {
        expect(resolveNativeTakeover(base({ stageActive: true })).reason).toBe('stage-playback');
        expect(resolveNativeTakeover(base({ source: null })).reason).toBe('empty-source');
        expect(resolveNativeTakeover(base({ source: 'blob:https://app.test/1234' })).reason).toBe('blob-source');
        expect(resolveNativeTakeover(base({ source: 'data:audio/mpeg;base64,AAAA' })).reason).toBe('data-source');
        expect(resolveNativeTakeover(base({ source: 'javascript:void(0)' })).reason).toBe('unsupported-source');
    });

    it('no longer falls back for the equalizer or the sound effects', () => {
        // 这两项现在由原生 DSP 处理（nativeDsp.ts → FoliaNativePlayer.setDsp）。判定入参里已经没有
        // 它们：下面这一行在类型层面就编译不过，是「别把旧字段加回来」的那道闸。
        // @ts-expect-error 均衡器不再是回落输入
        const legacy: NativeTakeoverInput = { ...base(), equalizerEnabled: true };
        expect(legacy.nativeEnabled).toBe(true);

        // 源吃得住时，剩下的组合就是接管：没有任何「听感设置」还能再挡住它。
        expect(resolveNativeTakeover(base({ automixEnabled: false, replayGainMode: 'off' })).takes).toBe(true);
    });

    it('still falls back for the features that only exist in web playback', () => {
        expect(resolveNativeTakeover(base({ automixEnabled: true })).reason).toBe('automix');
        expect(resolveNativeTakeover(base({ replayGainMode: 'track' })).reason).toBe('replay-gain');
        expect(resolveNativeTakeover(base({ replayGainMode: 'album' })).reason).toBe('replay-gain');
    });

    it('keeps replay gain off (the default) on the native path', () => {
        expect(resolveNativeTakeover(base({ replayGainMode: 'off' })).takes).toBe(true);
    });

    it('names one reason when several apply, and the source wins over the features', () => {
        // 同一个原因不会变来变去：矩阵里给出一个稳定的顺序，日志与诊断才对得上。
        expect(resolveNativeTakeover(base({ automixEnabled: true, replayGainMode: 'album' })).reason).toBe('automix');
        expect(resolveNativeTakeover(base({ source: 'blob:x', automixEnabled: true })).reason).toBe('blob-source');
        expect(resolveNativeTakeover(base({ source: 'data:audio/aac;base64,AA', replayGainMode: 'track' })).reason)
            .toBe('data-source');
    });

    it('reports the web-playback-only feature on its own', () => {
        expect(resolveWebPlaybackOnlyFeature(base())).toBeNull();
        expect(resolveWebPlaybackOnlyFeature(base({ automixEnabled: true }))).toBe('automix');
        expect(resolveWebPlaybackOnlyFeature(base({ replayGainMode: 'album' }))).toBe('replay-gain');
        expect(describeNativeTakeover(resolveNativeTakeover(base({ automixEnabled: true }))))
            .toBe('fallback:automix');
        expect(describeNativeTakeover(resolveNativeTakeover(base({ replayGainMode: 'track' }))))
            .toBe('fallback:replay-gain');
    });
});

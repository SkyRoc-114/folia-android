import { describe, expect, it } from 'vitest';
import {
    describeNativeTakeover,
    resolveNativeTakeover,
    resolveWebAudioOnlyFeature,
    type NativeTakeoverInput,
} from '@/services/playbackEngine/nativeFallback';

// test/unit/playbackEngine/nativeFallback.test.ts
// 自动回落矩阵：原生播放只在「源吃得下 + 没有 Web Audio 专属功能」时接管这一首。
// 每个组合都对应一个用户看得见的行为（均衡器还能听出变化 = 这一首确实回落了）。

const base = (overrides: Partial<NativeTakeoverInput> = {}): NativeTakeoverInput => ({
    nativeEnabled: true,
    pluginAvailable: true,
    source: 'https://cdn.example.test/song.mp3',
    equalizerEnabled: false,
    equalizerModCurveActive: false,
    audioEffectsNeutral: true,
    automixEnabled: false,
    replayGainMode: 'off',
    stageActive: false,
    ...overrides,
});

describe('native takeover decision', () => {
    it('takes a plain http source when nothing web-audio-only is on', () => {
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

    it('falls back for every web-audio-only feature', () => {
        expect(resolveNativeTakeover(base({ equalizerEnabled: true })).reason).toBe('equalizer');
        expect(resolveNativeTakeover(base({ equalizerModCurveActive: true })).reason).toBe('equalizer');
        expect(resolveNativeTakeover(base({ audioEffectsNeutral: false })).reason).toBe('audio-effects');
        expect(resolveNativeTakeover(base({ automixEnabled: true })).reason).toBe('automix');
        expect(resolveNativeTakeover(base({ replayGainMode: 'track' })).reason).toBe('replay-gain');
        expect(resolveNativeTakeover(base({ replayGainMode: 'album' })).reason).toBe('replay-gain');
    });

    it('keeps replay gain off (the default) on the native path', () => {
        expect(resolveNativeTakeover(base({ replayGainMode: 'off' })).takes).toBe(true);
    });

    it('names one reason when several apply, and the source wins over the features', () => {
        // 同一个原因不会变来变去：矩阵里给出一个稳定的顺序，日志与诊断才对得上。
        expect(resolveNativeTakeover(base({ equalizerEnabled: true, automixEnabled: true })).reason).toBe('equalizer');
        expect(resolveNativeTakeover(base({ automixEnabled: true, replayGainMode: 'album' })).reason).toBe('automix');
        expect(resolveNativeTakeover(base({ source: 'blob:x', equalizerEnabled: true })).reason).toBe('blob-source');
    });

    it('reports the web-audio-only feature on its own', () => {
        expect(resolveWebAudioOnlyFeature(base())).toBeNull();
        expect(resolveWebAudioOnlyFeature(base({ audioEffectsNeutral: false }))).toBe('audio-effects');
        expect(describeNativeTakeover(resolveNativeTakeover(base({ automixEnabled: true }))))
            .toBe('fallback:automix');
    });
});

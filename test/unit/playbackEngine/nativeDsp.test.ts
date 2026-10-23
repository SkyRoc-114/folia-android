import { describe, expect, it } from 'vitest';
import {
    buildNativeDspOptions,
    describeNativeDsp,
    normalizeNativeDspOptions,
    summarizeNativeDsp,
} from '@/services/playbackEngine/nativeDsp';
import { createNeutralAudioEffects } from '@/utils/audioEffects';
import type { AudioEqualizerSettings } from '@/utils/audioEqualizer';
import type { AudioEqualizerModCurve } from '@/utils/audioEqualizerModCurve';

// test/unit/playbackEngine/nativeDsp.test.ts
// 原生 DSP 的「该发什么」：mod 曲线优先、挂起时回到自己的十段、enabled=false 也照发、
// 十段永远齐全并夹在 ±12 dB。这些值直接决定原生播放器上听到的均衡器。

const ownGains = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const settings = (overrides: Partial<AudioEqualizerSettings> = {}): AudioEqualizerSettings => ({
    enabled: true,
    gains: [...ownGains],
    preset: 'custom1',
    effects: createNeutralAudioEffects(),
    customSlots: [],
    ...overrides,
});

const curve = (gains: number[]): AudioEqualizerModCurve => ({
    modId: 'test-mod',
    modName: 'Test Mod',
    gains,
    base: { preset: 'custom1', gains: [...ownGains], effects: createNeutralAudioEffects() },
});

describe('native DSP options', () => {
    it('carries the listener own ten gains and effects when no mod curve is heard', () => {
        const options = buildNativeDspOptions(settings());

        expect(options).toEqual({
            enabled: true,
            gains: [...ownGains],
            effects: createNeutralAudioEffects(),
            replayGainDb: 0,
        });
    });

    it('uses the mod curve gains while it is heard', () => {
        const modGains = [-2, -1, 0, 1, 2, 3, 2, 1, 0, -1];

        const options = buildNativeDspOptions(settings(), curve(modGains), false);

        expect(options.gains).toEqual(modGains);
        // 曲线只换 gains：音效仍是听众自己的。
        expect(options.effects).toEqual(createNeutralAudioEffects());
        expect(options.enabled).toBe(true);
    });

    it('goes back to the listener own gains when the curve is suspended', () => {
        const options = buildNativeDspOptions(settings(), curve([...Array(10)].map(() => 9)), true);

        expect(options.gains).toEqual(ownGains);
    });

    it('sends enabled=false instead of skipping, so the native chain can bypass', () => {
        const options = buildNativeDspOptions(settings({ enabled: false }));

        expect(options.enabled).toBe(false);
        expect(options.gains).toEqual(ownGains);
    });

    it('always sends ten bands, clamped to the UI range', () => {
        const options = buildNativeDspOptions(settings({ gains: [99, -99, 3] }));

        expect(options.gains).toHaveLength(10);
        expect(options.gains[0]).toBe(12);
        expect(options.gains[1]).toBe(-12);
        expect(options.gains[2]).toBe(3);
        expect(options.gains.slice(3)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('normalizes an untrusted payload: missing effects read neutral and a broken RG reads 0', () => {
        const options = normalizeNativeDspOptions({
            enabled: true,
            gains: [Number.NaN],
            effects: { highpass: 120, width: 99 } as never,
            replayGainDb: Number.NaN,
        });

        expect(options.gains).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        expect(options.effects.highpass).toBe(120);
        expect(options.effects.width).toBe(2);
        expect(options.effects.lowpass).toBe(20_000);
        expect(options.replayGainDb).toBe(0);
    });
});

describe('native DSP diagnostics summary', () => {
    it('summarizes bands and effects without copying all of them into the report', () => {
        const options = buildNativeDspOptions(settings({
            gains: [6, 0, 0, 0, 0, 0, 0, 0, 0, -2],
            effects: { ...createNeutralAudioEffects(), drive: 0.4 },
        }));

        expect(summarizeNativeDsp(options)).toEqual({
            enabled: true,
            nonZeroBands: 2,
            peakGainDb: 6,
            averageGainDb: 0.4,
            nonNeutralEffects: 1,
            replayGainDb: 0,
        });
        expect(describeNativeDsp(options)).toBe(
            'enabled=on bands=10 nonzero=2 peak=6.0dB avg=0.4dB effects=1/9 replayGain=0dB',
        );
    });
});

import { describe, expect, it } from 'vitest';
import { capMachiQualityForAndroid, capMachiTuningForAndroid } from '../../../src/utils/androidVisualizerPerfCap';
import { DEFAULT_MACHI_QUALITY, MACHI_QUALITY_PRESETS, type MachiQuality } from '../../../src/components/visualizer/machi/types';

// Android 兜底钳制（设计 §2.3）：Android 上町景画质钳到低档（MSAA 关、阴影/倒影关、bloom 关、
// 渲染分辨率不高于低档），adaptive 保留让上游的自动降档继续在帽下工作；桌面零改动。
// 雾笺无钳制：上游性能系列已把雾层压到 1/8 分辨率、双程序后台编译，没有独立画质档可钳。

describe('capMachiQualityForAndroid', () => {
    it('caps the default (high) quality to the low preset on Android and keeps adaptive', () => {
        const capped = capMachiQualityForAndroid(DEFAULT_MACHI_QUALITY);
        expect(capped).toEqual({ ...MACHI_QUALITY_PRESETS.low, adaptive: true });
    });

    it('never upgrades a user setting below the cap (0.5 render scale stays 0.5)', () => {
        const user: MachiQuality = { renderScale: 0.5, antialias: 'off', shadows: 'off', reflections: 'off', glow: false, adaptive: false };
        expect(capMachiQualityForAndroid(user)).toEqual(user);
    });

    it('keeps adaptive passthrough so the built-in degradation still works under the cap', () => {
        const user: MachiQuality = { ...MACHI_QUALITY_PRESETS.balanced, adaptive: true };
        const capped = capMachiQualityForAndroid(user);
        expect(capped.adaptive).toBe(true);
        expect(capped.antialias).toBe('off');
        expect(capped.renderScale).toBe(0.75);
    });

    it('clamps ssaa to off and high detail levels to off', () => {
        const user: MachiQuality = { renderScale: 1, antialias: 'ssaa', shadows: 'high', reflections: 'high', glow: true, adaptive: true };
        const capped = capMachiQualityForAndroid(user);
        expect(capped.antialias).toBe('off');
        expect(capped.shadows).toBe('off');
        expect(capped.reflections).toBe('off');
        expect(capped.glow).toBe(false);
    });
});

describe('capMachiTuningForAndroid', () => {
    it('returns the tuning untouched off Android', () => {
        const tuning = { quality: DEFAULT_MACHI_QUALITY, motion: true };
        expect(capMachiTuningForAndroid(tuning as never, false)).toBe(tuning);
    });

    it('caps only the quality slice on Android and keeps the rest of the tuning', () => {
        const tuning = { quality: DEFAULT_MACHI_QUALITY, motion: true, scene: 'konbini' };
        const capped = capMachiTuningForAndroid(tuning as never, true) as typeof tuning;
        expect(capped.motion).toBe(true);
        expect(capped.scene).toBe('konbini');
        expect(capped.quality).toEqual({ ...MACHI_QUALITY_PRESETS.low, adaptive: true });
    });

    it('returns the same object when already at or below the cap', () => {
        const tuning = { quality: { ...MACHI_QUALITY_PRESETS.low, adaptive: true } };
        expect(capMachiTuningForAndroid(tuning as never, true)).toBe(tuning);
    });
});

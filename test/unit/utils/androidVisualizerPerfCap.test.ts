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

// Folium 1.8（3b4f01a7）之后町景的 renderScale/antialias 可以是 'global'（跟随「性能与动效」的全局挡位）：
// 钳制前先 resolve 成数值/枚举再钳；全局挡位从 useVisualizerSettingsStore 读进来，缺省用默认挡位（1× + auto）。
describe('capMachiQualityForAndroid with global quality (Folium 1.8)', () => {
    it('resolves global fields above the cap down to the low preset', () => {
        const user: MachiQuality = { ...MACHI_QUALITY_PRESETS.high, adaptive: true };
        expect(user.renderScale).toBe('global');
        const capped = capMachiQualityForAndroid(user, { scale: 1.5, antialias: 'on' });
        expect(capped.renderScale).toBe(0.75);
        expect(capped.antialias).toBe('off');
        expect(capped.shadows).toBe('off');
        expect(capped.adaptive).toBe(true);
    });

    it('keeps a resolved global scale that is already under the cap (0.5 stays 0.5)', () => {
        const user: MachiQuality = { ...MACHI_QUALITY_PRESETS.high, adaptive: false };
        const capped = capMachiQualityForAndroid(user, { scale: 0.5, antialias: 'off' });
        expect(capped.renderScale).toBe(0.5);
        expect(capped.antialias).toBe('off');
    });

    it('resolves global antialias: auto/on mean the machi default (SMAA) and off means off', () => {
        const auto = capMachiQualityForAndroid({ ...MACHI_QUALITY_PRESETS.high, adaptive: false }, { scale: 0.5, antialias: 'auto' });
        expect(auto.antialias).toBe('off'); // auto → SMAA（样式默认）→ 钳到 off
        const on = capMachiQualityForAndroid({ ...MACHI_QUALITY_PRESETS.high, adaptive: false }, { scale: 0.5, antialias: 'on' });
        expect(on.antialias).toBe('off'); // on → SMAA → 钳到 off
        const off = capMachiQualityForAndroid({ ...MACHI_QUALITY_PRESETS.high, adaptive: false }, { scale: 0.5, antialias: 'off' });
        expect(off.antialias).toBe('off');
    });

    it('caps the high preset (global fields) with no explicit global quality passed', () => {
        const capped = capMachiQualityForAndroid({ ...MACHI_QUALITY_PRESETS.high, adaptive: true });
        expect(capped).toEqual({ ...MACHI_QUALITY_PRESETS.low, adaptive: true });
    });

    it('tuning-level cap also resolves global fields', () => {
        const tuning = { quality: { ...MACHI_QUALITY_PRESETS.high, adaptive: true }, motion: true };
        const capped = capMachiTuningForAndroid(tuning as never, true) as typeof tuning;
        expect(capped.quality.renderScale).toBe(0.75);
        expect(capped.quality.antialias).toBe('off');
    });
});

import { describe, expect, it } from 'vitest';
import {
    applyLyricRenderQuality,
    isLyricRenderQuality,
    legacyLyricResolution,
    resolveLyricRenderQuality,
} from '../../../src/utils/lyricRenderQuality';

// test/unit/utils/lyricRenderQuality.test.ts — #929 歌词画布渲染质量 resolver。

describe('lyricRenderQuality', () => {
    describe('isLyricRenderQuality', () => {
        it('accepts the four value labels and rejects everything else', () => {
            for (const value of ['auto', '1', '2', '3']) expect(isLyricRenderQuality(value)).toBe(true);
            for (const value of ['0', '4', '', 'AUTO', null, undefined, 2]) expect(isLyricRenderQuality(value)).toBe(false);
        });
    });

    describe('legacyLyricResolution（auto 档旧行为）', () => {
        it('1x screens stay at 1, fractional dpr ceil up, and everything caps at 2', () => {
            expect(legacyLyricResolution(1)).toBe(1);
            expect(legacyLyricResolution(1.25)).toBe(2);
            expect(legacyLyricResolution(1.5)).toBe(2);
            expect(legacyLyricResolution(2)).toBe(2);
            expect(legacyLyricResolution(3)).toBe(2);
        });

        it('degenerate inputs fall back to 1', () => {
            expect(legacyLyricResolution(0)).toBe(1);
            expect(legacyLyricResolution(-1)).toBe(1);
            expect(legacyLyricResolution(Number.NaN)).toBe(1);
        });
    });

    describe('resolveLyricRenderQuality', () => {
        it('auto keeps the legacy behavior', () => {
            expect(resolveLyricRenderQuality('auto', 1)).toBe(1);
            expect(resolveLyricRenderQuality('auto', 1.25)).toBe(2);
            expect(resolveLyricRenderQuality('auto', 3)).toBe(2);
        });

        it('fixed values win over dpr and clamp to >= 1', () => {
            expect(resolveLyricRenderQuality('1', 2)).toBe(1);
            expect(resolveLyricRenderQuality('2', 1)).toBe(2);
            expect(resolveLyricRenderQuality('3', 1)).toBe(3);
            expect(resolveLyricRenderQuality('3', 0)).toBe(3);
        });
    });

    describe('applyLyricRenderQuality', () => {
        it('auto delegates to the style-specific legacy fn（各风格旧行为不漂移）', () => {
            const latticeLegacy = (dpr: number) => Math.min(2, Math.max(1, Math.ceil(dpr)));
            const hanabiLegacy = (dpr: number) => Math.min(2, Math.max(1, dpr || 1));
            // 1.5 的 dpr：lattice 取 ceil=2，hanabi 保持 1.5 —— auto 必须保留这个差异。
            expect(applyLyricRenderQuality('auto', 1.5, latticeLegacy)).toBe(2);
            expect(applyLyricRenderQuality('auto', 1.5, hanabiLegacy)).toBe(1.5);
        });

        it('fixed values bypass the legacy fn', () => {
            expect(applyLyricRenderQuality('3', 1, () => 99)).toBe(3);
        });
    });
});

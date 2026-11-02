import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIBRARY_WALL_SEAM_DIRECTION,
    LIBRARY_WALL_PORTRAIT_QUERY,
    LIBRARY_WALL_SEAM_DIRECTIONS,
    LIBRARY_WALL_SEAM_ROW_NARROW_QUERY,
    isLibraryWallSeamDirection,
    normalizeLibraryWallSeamDirection,
    resolveLibraryWallSeamHorizontal,
    resolveLibraryWallSeamHorizontalForTouch,
} from '@/utils/libraryWallSeamDirection';

// test/unit/utils/libraryWallSeamDirection.test.ts
// bravais 信息条方向的取值规则：四个取值、默认自动、非法值回默认；自动时只有明显竖着的视口（高 ≥ 宽 × 1.1）开横条，
// 自动（反向）正好反过来。

/** 按 CSS 的 max-aspect-ratio 语义算这条查询在某个视口上命不命中（宽 / 高 ≤ 比值）。 */
const matchesPortraitQuery = (width: number, height: number) => {
    const ratio = /max-aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(LIBRARY_WALL_PORTRAIT_QUERY);
    if (!ratio) throw new Error('portrait query is not a max-aspect-ratio query');
    return width * Number(ratio[2]) <= height * Number(ratio[1]);
};

describe('libraryWallSeamDirection', () => {
    it('lists auto / auto-reverse / vertical / horizontal, defaults to auto and normalizes anything else to it', () => {
        expect(LIBRARY_WALL_SEAM_DIRECTIONS).toEqual(['auto', 'auto-reverse', 'vertical', 'horizontal']);
        expect(DEFAULT_LIBRARY_WALL_SEAM_DIRECTION).toBe('auto');
        expect(LIBRARY_WALL_SEAM_DIRECTIONS.every(isLibraryWallSeamDirection)).toBe(true);
        expect(normalizeLibraryWallSeamDirection('vertical')).toBe('vertical');
        for (const value of [undefined, null, '', 'Horizontal', 'sideways', 'autoReverse', 1, true]) {
            expect(normalizeLibraryWallSeamDirection(value)).toBe('auto');
        }
    });

    it('opens rows on portrait screens when automatic, on landscape ones when reversed, and follows a fixed choice otherwise', () => {
        expect(resolveLibraryWallSeamHorizontal('auto', true)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('auto', false)).toBe(false);
        expect(resolveLibraryWallSeamHorizontal('auto-reverse', true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontal('auto-reverse', false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('horizontal', false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontal('vertical', true)).toBe(false);
    });

    it('counts only clearly tall viewports as portrait, so near-square windows do not flip back and forth', () => {
        expect(matchesPortraitQuery(390, 844)).toBe(true);
        expect(matchesPortraitQuery(768, 1024)).toBe(true);
        expect(matchesPortraitQuery(1000, 1100)).toBe(true);
        expect(matchesPortraitQuery(1000, 1099)).toBe(false);
        expect(matchesPortraitQuery(900, 950)).toBe(false);
        expect(matchesPortraitQuery(1440, 900)).toBe(false);
        expect(matchesPortraitQuery(852, 393)).toBe(false);
    });

    it('falls back to the vertical spine on narrow touch viewports for both automatic modes, explicit row still wins', () => {
        // 宽度半边与 phone-fit / sheetPresentation 的 720 阈值一族。
        expect(LIBRARY_WALL_SEAM_ROW_NARROW_QUERY).toBe('(max-width: 719.98px)');
        // 手机竖屏：自动 / 自动（反向）都改走竖缝——compact 横条 44px 触点下约 650px，物理放不进手机宽度。
        expect(resolveLibraryWallSeamHorizontalForTouch('auto', true, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTouch('auto-reverse', true, true)).toBe(false);
        // 手机横屏（宽 640-719 也算窄）：自动本就走竖缝，自动（反向）的横条同样被兜底。
        expect(resolveLibraryWallSeamHorizontalForTouch('auto', false, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTouch('auto-reverse', false, true)).toBe(false);
        // 显式选择仍尊重：横向照开、竖向照竖。
        expect(resolveLibraryWallSeamHorizontalForTouch('horizontal', true, true)).toBe(true);
        expect(resolveLibraryWallSeamHorizontalForTouch('vertical', true, true)).toBe(false);
        // 非触屏窄视口（桌面窄窗）：维持原判定，行为零变化。
        expect(resolveLibraryWallSeamHorizontalForTouch('auto', true, false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontalForTouch('auto-reverse', false, false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontalForTouch('horizontal', true, false)).toBe(true);
    });
});

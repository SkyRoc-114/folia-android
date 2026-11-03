import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LIBRARY_WALL_SEAM_DIRECTION,
    LIBRARY_WALL_PORTRAIT_QUERY,
    LIBRARY_WALL_SEAM_DIRECTIONS,
    LIBRARY_WALL_SEAM_TABLET_MIN_QUERY,
    LIBRARY_WALL_SEAM_TABLET_TALL_QUERY,
    isLibraryWallSeamDirection,
    normalizeLibraryWallSeamDirection,
    resolveLibraryWallSeamHorizontal,
    resolveLibraryWallSeamHorizontalForTablet,
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

    // 平板双栏（fork 增量）：触屏平板上两种「自动」一律开竖缝（墙分成左右两部分），显式「横向」仍尊重；
    // 手机与非触屏走上游原语义。
    it('splits touch tablets into two panes with a vertical seam on both autos, while phones and desktops keep the upstream semantics', () => {
        expect(LIBRARY_WALL_SEAM_TABLET_MIN_QUERY).toBe('(min-width: 720px)');
        expect(LIBRARY_WALL_SEAM_TABLET_TALL_QUERY).toBe('(min-height: 720px)');
        // 触屏平板：两种自动两种朝向都开竖缝；显式横向仍开横条；显式竖缝不变。
        expect(resolveLibraryWallSeamHorizontalForTablet('auto', true, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('auto', false, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('auto-reverse', true, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('auto-reverse', false, true)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('horizontal', true, true)).toBe(true);
        expect(resolveLibraryWallSeamHorizontalForTablet('vertical', false, true)).toBe(false);
        // 手机（短边 < 720）与非触屏：原语义，零变化。
        expect(resolveLibraryWallSeamHorizontalForTablet('auto', true, false)).toBe(true);
        expect(resolveLibraryWallSeamHorizontalForTablet('auto', false, false)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('auto-reverse', true, false)).toBe(false);
        expect(resolveLibraryWallSeamHorizontalForTablet('horizontal', true, false)).toBe(true);
    });
});

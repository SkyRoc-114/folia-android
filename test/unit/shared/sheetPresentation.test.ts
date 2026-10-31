import { describe, expect, it } from 'vitest';
import {
    pagerSwipeDecision,
    sheetDragDecision,
    sheetPresentation,
} from '../../../src/components/shared/sheetPresentation';

// src/components/shared/sheetPresentation.test.ts（位于 test/unit/shared/，按仓库惯例镜像 src）
// 弹窗窗口呈现与手势决策的纯函数。呈现按视口事实（触摸指针/竖屏/宽度）定，不挂任何设置；
// 拖拽决策管 Sheet 下拉关闭，翻页决策管登录窗与入门向导的横滑。

describe('sheetPresentation', () => {
    it('触摸+竖屏+窄宽 → bottom', () => {
        expect(sheetPresentation({ coarse: true, portrait: true, width: 360 })).toBe('bottom');
        expect(sheetPresentation({ coarse: true, portrait: true, width: 719.5 })).toBe('bottom');
    });

    it('宽 ≥ 720（平板/折叠内屏）→ card', () => {
        expect(sheetPresentation({ coarse: true, portrait: true, width: 720 })).toBe('card');
        expect(sheetPresentation({ coarse: true, portrait: true, width: 1280 })).toBe('card');
    });

    it('横屏 → card（矮窗贴底没有可看内容）', () => {
        expect(sheetPresentation({ coarse: true, portrait: false, width: 700 })).toBe('card');
    });

    it('细指针（桌面，哪怕窗口很窄）→ card，上游观感不变', () => {
        expect(sheetPresentation({ coarse: false, portrait: true, width: 360 })).toBe('card');
        expect(sheetPresentation({ coarse: false, portrait: false, width: 360 })).toBe('card');
    });
});

describe('sheetDragDecision', () => {
    const viewportH = 800;
    const far = Math.max(120, viewportH * 0.2); // 160

    it('快速轻扫（fling）→ dismiss', () => {
        expect(sheetDragDecision({ dy: 40, vy: 0.6, viewportH, closeBlocked: false })).toBe('dismiss');
        expect(sheetDragDecision({ dy: 4, vy: 2, viewportH, closeBlocked: false })).toBe('dismiss');
    });

    it('慢速拖过距离阈值（max(120, 20%视高)）→ dismiss', () => {
        expect(sheetDragDecision({ dy: far, vy: 0.1, viewportH, closeBlocked: false })).toBe('dismiss');
        expect(sheetDragDecision({ dy: far - 1, vy: 0.1, viewportH, closeBlocked: false })).toBe('restore');
    });

    it('慢速小位移 → restore', () => {
        expect(sheetDragDecision({ dy: 60, vy: 0.2, viewportH, closeBlocked: false })).toBe('restore');
        expect(sheetDragDecision({ dy: 0, vy: 0, viewportH, closeBlocked: false })).toBe('restore');
    });

    it('向上拖（dy ≤ 0）→ restore', () => {
        expect(sheetDragDecision({ dy: -30, vy: 0.9, viewportH, closeBlocked: false })).toBe('restore');
        expect(sheetDragDecision({ dy: 0, vy: 0.9, viewportH, closeBlocked: false })).toBe('restore');
    });

    it('closeBlocked（closeDisabled）恒 restore，fling 也不放走', () => {
        expect(sheetDragDecision({ dy: far + 10, vy: 3, viewportH, closeBlocked: true })).toBe('restore');
        expect(sheetDragDecision({ dy: 40, vy: 0.9, viewportH, closeBlocked: true })).toBe('restore');
    });

    it('视口很矮时阈值取下限 120px', () => {
        expect(sheetDragDecision({ dy: 120, vy: 0.1, viewportH: 400, closeBlocked: false })).toBe('dismiss');
        expect(sheetDragDecision({ dy: 119, vy: 0.1, viewportH: 400, closeBlocked: false })).toBe('restore');
    });
});

describe('pagerSwipeDecision', () => {
    const width = 360;
    // 三页的中间页：两个方向都翻得动。
    const base = { width, page: 1, count: 3, canGo: (to: number) => to >= 0 && to < 3 };

    it('横滑过距离阈值 → 翻页：向左滑（dx<0）去下一页 +1，向右滑去上一页 -1', () => {
        expect(pagerSwipeDecision({ ...base, dx: -width * 0.25, dy: 0, vx: 0 })).toBe(1);
        expect(pagerSwipeDecision({ ...base, dx: width * 0.25, dy: 0, vx: 0 })).toBe(-1);
        expect(pagerSwipeDecision({ ...base, dx: -width * 0.25 + 1, dy: 0, vx: 0 })).toBe(0);
    });

    it('快速 flick（|vx| 达标）位移不到也翻页', () => {
        expect(pagerSwipeDecision({ ...base, dx: -30, dy: 0, vx: -0.8 })).toBe(1);
        expect(pagerSwipeDecision({ ...base, dx: 30, dy: 0, vx: 0.8 })).toBe(-1);
    });

    it('位移方向与结束速度相反（矛盾手势）→ 0，不赌方向', () => {
        expect(pagerSwipeDecision({ ...base, dx: -30, dy: 0, vx: 0.8 })).toBe(0);
        expect(pagerSwipeDecision({ ...base, dx: 200, dy: 0, vx: -2 })).toBe(0);
    });

    it('纵向意图让位（轴锁）：|dy| > |dx| → 0，体层滚动优先；小纵向漂移不拦横滑', () => {
        expect(pagerSwipeDecision({ ...base, dx: -10, dy: 60, vx: 0 })).toBe(0);
        expect(pagerSwipeDecision({ ...base, dx: -width, dy: 40, vx: -2 })).toBe(1);
    });

    it('越界不翻：第 0 页不再向右，最后一页不再向左', () => {
        expect(pagerSwipeDecision({ ...base, page: 0, dx: width * 0.4, dy: 0, vx: 0 })).toBe(0);
        expect(pagerSwipeDecision({ ...base, page: 2, dx: -width * 0.4, dy: 0, vx: 0 })).toBe(0);
    });

    it('canGo 假 → 0（调用方的业务闸门，如登录窗未选平台进不了登录画）', () => {
        expect(pagerSwipeDecision({
            ...base, page: 0, dx: -width * 0.4, dy: 0, vx: 0,
            canGo: (to) => to !== 1,
        })).toBe(0);
    });

    it('没动 → 0', () => {
        expect(pagerSwipeDecision({ ...base, dx: 0, dy: 0, vx: 0 })).toBe(0);
    });
});

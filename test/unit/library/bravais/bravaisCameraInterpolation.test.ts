import { describe, expect, it } from 'vitest';
import { advanceShownCenter, isShownSettled } from '@/library/suites/bravais/bravaisCameraInterpolation';
import type { WallViewCenter } from '@/components/wall/wallView';

// test/unit/library/bravais/bravaisCameraInterpolation.test.ts
// #843：拖动 bravais 墙时相机的 transform 只在 pointermove 到达时同步写，高刷屏上一帧拿到的位移忽大忽小。
// 修法 = 目标（target，真源 center）与显示（shown）分离，rAF 里指数逼近。这里只测逼近与收敛判定这两个纯函数；
// 写入节奏在 useBravaisCamera 的 rAF 循环里，不经过 React，自动化断言落在纯函数上。

describe('advanceShownCenter', () => {
    it('moves the shown center toward the target and never past it', () => {
        const target: WallViewCenter = { x: 100, y: -40 };
        const first = advanceShownCenter({ x: 0, y: 0 }, target, 16);
        expect(first.x).toBeGreaterThan(0);
        expect(first.x).toBeLessThan(target.x);
        expect(first.y).toBeLessThan(0);
        expect(first.y).toBeGreaterThan(target.y);
    });

    it('decays exponentially: each equal step closes a constant fraction of what is left', () => {
        const target: WallViewCenter = { x: 64, y: 0 };
        let shown: WallViewCenter = { x: 0, y: 0 };
        const fractions: number[] = [];
        let left = 64;
        for (let step = 0; step < 6; step += 1) {
            shown = advanceShownCenter(shown, target, 8);
            fractions.push((left - (target.x - shown.x)) / left);
            left = target.x - shown.x;
        }
        for (let i = 1; i < fractions.length; i += 1) {
            expect(fractions[i]).toBeCloseTo(fractions[0], 5);
        }
        // tau = 8ms、dt = 8ms：每步走掉剩下的 ~63.2%（1 - e^-1）。
        expect(fractions[0]).toBeCloseTo(1 - Math.exp(-1), 3);
    });

    it('closes more per step the longer the frame took', () => {
        const target: WallViewCenter = { x: 100, y: 100 };
        const short = advanceShownCenter({ x: 0, y: 0 }, target, 4);
        const long = advanceShownCenter({ x: 0, y: 0 }, target, 32);
        expect(Math.abs(long.x - target.x)).toBeLessThan(Math.abs(short.x - target.x));
    });

    it('stays put when the frame took no time or the target is already shown', () => {
        const target: WallViewCenter = { x: 30, y: -12 };
        expect(advanceShownCenter(target, target, 16)).toEqual(target);
        expect(advanceShownCenter({ x: 1, y: 2 }, { x: 5, y: 6 }, 0)).toEqual({ x: 1, y: 2 });
    });
});

describe('isShownSettled', () => {
    it('settles when both axes are under half a device pixel', () => {
        // scale 2、dpr 2：一个世界单位是 4 个设备像素，差 0.1 世界单位 = 0.4 设备像素 → 收敛。
        expect(isShownSettled({ x: 10.1, y: 20.05 }, { x: 10, y: 20 }, 2, 2)).toBe(true);
        // 差 0.2 世界单位 = 0.8 设备像素 → 还差着。
        expect(isShownSettled({ x: 10.2, y: 20 }, { x: 10, y: 20 }, 2, 2)).toBe(false);
    });

    it('judges in device pixels, so a zoomed-out or low-dpr wall settles on coarser world deltas', () => {
        // scale 0.5、dpr 1：1 世界单位 = 0.5 设备像素，差 0.9 世界单位也够不到半像素。
        expect(isShownSettled({ x: 10.9, y: 0 }, { x: 10, y: 0 }, 0.5, 1)).toBe(true);
        // scale 4、dpr 3：0.05 世界单位 = 0.6 设备像素，不算收拢。
        expect(isShownSettled({ x: 0.05, y: 0 }, { x: 0, y: 0 }, 4, 3)).toBe(false);
    });
});

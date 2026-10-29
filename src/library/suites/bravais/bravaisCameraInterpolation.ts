import type { WallViewCenter } from '../../../components/wall/wallView';

// src/library/suites/bravais/bravaisCameraInterpolation.ts
// #843：拖动 bravais 墙时，相机的 transform 原来在每次 pointermove 到达时同步写（useBravaisCamera 的
// moveTo），位置序列按事件到达时刻排布、不按帧；高刷屏上事件间隔抖动（p50 6.5ms / p95 16.8ms），
// 每帧拿到的位移忽大忽小，看起来一顿一顿。修法与上游 issue 建议的第二档一致：真源 center 只当目标值，
// 显示值 shown 在 rAF 里按指数逼近目标（tau 越小跟得越紧），输出仍走 formatWorldTransform 的整设备
// 像素吸附。两个纯函数放在这里，rAF 循环在 useBravaisCamera。

/** 一帧内 shown 向 target 逼近一步：shown += (target - shown) * (1 - e^(-dt/tau))。 */
export const advanceShownCenter = (
    shown: WallViewCenter,
    target: WallViewCenter,
    dtMs: number,
    tauMs = 8,
): WallViewCenter => {
    if (!(dtMs > 0) || !Number.isFinite(dtMs)) return shown;
    // dt 远大于 tau 时按 1 - e^(-dt/tau) 收（封顶 1，不越过目标）。
    const t = 1 - Math.exp(-dtMs / Math.max(tauMs, 0.001));
    return {
        x: shown.x + (target.x - shown.x) * t,
        y: shown.y + (target.y - shown.y) * t,
    };
};

/**
 * shown 离 target 双轴都不到半个设备像素：再写一帧也是同一个吸附后的整数像素，可以收拢
 * （snap 到 target、停循环）。世界坐标差按 scale * dpr 换算成设备像素判断。
 */
export const isShownSettled = (
    shown: WallViewCenter,
    target: WallViewCenter,
    scale: number,
    devicePixelRatio: number,
): boolean => {
    const unitsPerPixel = (Number.isFinite(scale) && scale > 0 ? scale : 1)
        * (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1);
    return Math.abs(target.x - shown.x) * unitsPerPixel < 0.5
        && Math.abs(target.y - shown.y) * unitsPerPixel < 0.5;
};

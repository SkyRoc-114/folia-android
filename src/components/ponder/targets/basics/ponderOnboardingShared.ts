import { PONDER_ONBOARDING_GEOMETRY as O } from '../../surfaces/basics/onboarding.geometry';
import { FINE_POINTER_QUERY } from '../../../../hooks/useSupportsFinePointer';
import { useHidDevicesStore } from '../../../../stores/useHidDevicesStore';
import type { PonderAnchorSource, PonderRelativeRect, PonderSurfaceKind } from '../../../../types/ponder';

// src/components/ponder/targets/basics/ponderOnboardingShared.ts
// 入门那一族目标共用的锚点。
//
// 文件名不是 *.target.ts：注册表用 glob 收目标，共用件混进去会被当成一个缺 default export
// 的目标直接抛错。

/**
 * 触屏分镜还是桌面分镜（纯选择器，直测）。
 *
 * 触屏没有悬停，也没有键盘：Ctrl+G、长按 G、Ctrl+K 这些按键演示在手机上讲不通，
 * 各章换成灯泡和触屏入口（见各 target 里成对的 steps）。键鼠接入（物理键盘或鼠标任一）
 * 时触屏机也能按到真键 —— 分镜跟着换回桌面那套；全拔出回触屏。
 */
export const selectOnboardingTouchStoryboard = (coarsePointer: boolean, hidConnected: boolean): boolean => (
    coarsePointer && !hidConnected
);

/**
 * 运行时读：触屏分镜要不要演。细指针在（鼠标接着）或键鼠接入（store 由插件事件维护）
 * 都算桌面 —— 同一台机器上不会一边出悬停胶囊、一边又演触屏动作。
 *
 * 各 target 的场景对象用 getter 在每次编译分镜时读这里（PonderStage 只在进场景时
 * compilePonderScene），拔插键鼠后下一次进教程就换分镜。node / 无 matchMedia 环境
 * （vitest 是 node）落回桌面分镜 —— T5 起既有断言全按桌面分镜写，这条约定不能破。
 */
export const onboardingUsesTouchStoryboard = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    const coarsePointer = !window.matchMedia(FINE_POINTER_QUERY).matches;
    return selectOnboardingTouchStoryboard(coarsePointer, useHidDevicesStore.getState().hidConnected);
};

/** startsHidden 给那些「按了键才出现」的面：一进场就摆着的话，字幕在讲一件已经发生的事。 */
export const onboardingSurface = (
    labelKey: string,
    surfaceKind: PonderSurfaceKind,
    startsHidden = false,
): Record<string, PonderAnchorSource> => ({
    page: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.15, width: 0.56, height: 0.5, anchorX: 'center' },
        role: 'surface',
        surfaceKind,
        labelKey,
        startsHidden,
    },
});

const onIllustration = (rect: PonderRelativeRect, labelKey: string): PonderAnchorSource => (
    { kind: 'relative', from: 'page', rect, role: 'region', labelKey }
);

/** 那张讲思索本身的示意图，加上图里三处可以被指到的东西。 */
export const ONBOARDING_ILLUSTRATION: Record<string, PonderAnchorSource> = {
    ...onboardingSurface('ponder.anchors.onboarding.page', 'ponder-onboarding'),
    component: onIllustration(O.cardC, 'ponder.anchors.onboarding.component'),
    capsule: onIllustration(O.capsule, 'ponder.anchors.onboarding.capsule'),
    touchBulb: onIllustration(O.touchBulb, 'ponder.anchors.onboarding.touchBulb'),
};

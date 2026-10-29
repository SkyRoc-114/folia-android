import { PONDER_ONBOARDING_GEOMETRY as O } from '../../surfaces/basics/onboarding.geometry';
import { FINE_POINTER_QUERY } from '../../../../hooks/useSupportsFinePointer';
import type { PonderAnchorSource, PonderRelativeRect, PonderSurfaceKind } from '../../../../types/ponder';

// src/components/ponder/targets/basics/ponderOnboardingShared.ts
// 入门那一族目标共用的锚点。
//
// 文件名不是 *.target.ts：注册表用 glob 收目标，共用件混进去会被当成一个缺 default export
// 的目标直接抛错。

/**
 * 入门分镜要不要演触屏那一套。触屏没有悬停，也没有键盘：Ctrl+G、长按 G、Ctrl+K
 * 这些按键演示在手机上讲不通，各章换成灯泡和触屏入口（见各 target 里成对的 steps）。
 *
 * 注册表启动时把目标全部 eager 求值一遍，这里同样只判一次 —— 和 useSupportsFinePointer
 * 用同一个查询，保证同一台机器上不会一边出悬停胶囊、一边又演鼠标动作。node 环境（测试）
 * 没有 window，落回桌面分镜，让既有断言继续成立。
 */
export const ONBOARDING_TOUCH = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && !window.matchMedia(FINE_POINTER_QUERY).matches;

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

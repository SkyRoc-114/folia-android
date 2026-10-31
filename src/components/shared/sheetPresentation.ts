export type SheetPresentation = 'bottom' | 'card';

// src/components/shared/sheetPresentation.ts
// 弹窗「独立窗口」呈现与两个手势的决策，全是纯函数：呈现按视口事实（触摸指针/竖屏/宽度）定，
// 不挂 phone-fit 之类的设置——安卓手机默认安装就是 bottom 呈现，桌面一行不变。
// 阈值都导出：单测锁边界，调参不用翻实现。

/** bottom 呈现的最大视宽：手机竖屏（含折叠机内屏），再宽就是平板，回 card。 */
export const SHEET_BOTTOM_MAX_WIDTH = 720;

/** 下拉 dismiss 的 fling 速度阈值（px/ms）：Material 手感的轻扫。 */
export const DRAG_DISMISS_VELOCITY = 0.5;
/** 下拉 dismiss 的位移下限（px）：矮视口上按比例算不出量。 */
export const DRAG_DISMISS_DISTANCE_MIN = 120;
/** 下拉 dismiss 的位移按视高的比例。 */
export const DRAG_DISMISS_DISTANCE_RATIO = 0.2;

/** 横滑翻页按轨道宽度算的 commit 距离比例。 */
export const PAGER_COMMIT_RATIO = 0.25;
/** 横滑翻页的 flick 速度阈值（px/ms）。 */
export const PAGER_FLICK_VELOCITY = 0.5;

/**
 * 这一块屏幕上弹窗该是什么窗口：'bottom' = 安卓竖屏手机（贴底全宽、顶圆角、把手、自底滑入）；
 * 'card' = 其余一切（桌面、窄桌面窗、平板、横屏），上游原样。
 */
export const sheetPresentation = ({ coarse, portrait, width }: {
    coarse: boolean;
    portrait: boolean;
    width: number;
}): SheetPresentation => (
    coarse && portrait && width < SHEET_BOTTOM_MAX_WIDTH ? 'bottom' : 'card'
);

/** 下拉 dismiss 的位移阈值：视高的两成，矮视口取 120px 下限。 */
export const dragDismissDistance = (viewportH: number): number => (
    Math.max(DRAG_DISMISS_DISTANCE_MIN, viewportH * DRAG_DISMISS_DISTANCE_RATIO)
);

/**
 * Sheet 下拉松手的去向。dy ≥ 0 才谈 dismiss（向上拖回弹）；fling 直接走，
 * 慢拖要过距离阈值；closeDisabled（closeBlocked）和真实 Escape 被拦时一样不放行。
 */
export const sheetDragDecision = ({ dy, vy, viewportH, closeBlocked }: {
    dy: number;
    vy: number;
    viewportH: number;
    closeBlocked: boolean;
}): 'dismiss' | 'restore' => {
    if (closeBlocked) return 'restore';
    if (dy <= 0) return 'restore';
    if (vy >= DRAG_DISMISS_VELOCITY) return 'dismiss';
    return dy >= dragDismissDistance(viewportH) ? 'dismiss' : 'restore';
};

/**
 * 横滑翻页松手的去向：+1 下一页、-1 上一页、0 不动。
 * 轴锁：纵向位移盖过横向就是体层在滚，不翻页；小纵向漂移不拦横滑。
 * 距离（≥ 1/4 宽）或 flick（|vx| 达标且确实动了）都算过线；
 * 净位移与结束速度方向相反的矛盾手势不赌方向；
 * 越界与调用方的业务闸门（canGo，如登录窗没选平台进不了登录画）都翻不动。
 */
export const pagerSwipeDecision = ({ dx, dy, vx, width, page, count, canGo }: {
    dx: number;
    dy: number;
    vx: number;
    width: number;
    page: number;
    count: number;
    canGo?: (to: number) => boolean;
}): -1 | 0 | 1 => {
    if (Math.abs(dy) > Math.abs(dx)) return 0;
    // 意图方向：净位移定大方向，结束速度反着它就当没看懂。
    const fromDx: -1 | 0 | 1 = dx < 0 ? 1 : dx > 0 ? -1 : 0;
    const fromVx: -1 | 0 | 1 = vx < 0 ? 1 : vx > 0 ? -1 : 0;
    if (fromDx === 0) return 0;
    if (fromVx !== 0 && fromVx !== fromDx) return 0;
    const byDistance = Math.abs(dx) >= width * PAGER_COMMIT_RATIO;
    const byFlick = Math.abs(vx) >= PAGER_FLICK_VELOCITY;
    if (!byDistance && !byFlick) return 0;
    const to = page + fromDx;
    if (to < 0 || to > count - 1) return 0;
    if (canGo && !canGo(to)) return 0;
    return fromDx;
};

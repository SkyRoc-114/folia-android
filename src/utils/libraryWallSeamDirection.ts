// src/utils/libraryWallSeamDirection.ts
// bravais 信息条的方向偏好（纯数据，叶子层）：竖向（从块与块之间的竖缝裂开）、横向（从块行之间的横缝裂开）、自动（按
// 视口的宽高比：竖着的屏幕用横条，横着的用竖缝）、自动（反向）（同一个判断，结果反过来：竖着的屏幕用竖缝，横着的用横条）。
// store、设置分区、命令面板与 stage 共用这一份。
// 两种「自动」只看视口形状，不判断是不是手机：竖着拿的平板、拉成竖长条的桌面窗口一样算竖着的屏幕。高至少是宽的 1.1 倍才算竖着，
// 接近方形的窗口在拖动时不会来回换方向。

export type LibraryWallSeamDirection = 'auto' | 'auto-reverse' | 'vertical' | 'horizontal';

/** 设置分区与命令面板列出的顺序。 */
export const LIBRARY_WALL_SEAM_DIRECTIONS: readonly LibraryWallSeamDirection[] = Object.freeze(['auto', 'auto-reverse', 'vertical', 'horizontal'] as const);

export const DEFAULT_LIBRARY_WALL_SEAM_DIRECTION: LibraryWallSeamDirection = 'auto';

export const isLibraryWallSeamDirection = (value: unknown): value is LibraryWallSeamDirection => (
    value === 'auto' || value === 'auto-reverse' || value === 'vertical' || value === 'horizontal'
);

/** 存储或导入的取值：认识的原样返回，其余回默认（自动）。 */
export const normalizeLibraryWallSeamDirection = (value: unknown): LibraryWallSeamDirection => (
    isLibraryWallSeamDirection(value) ? value : DEFAULT_LIBRARY_WALL_SEAM_DIRECTION
);

/** 各取值的界面名与说明（设置分区、命令面板 picker、导入确认框共用）。 */
export const LIBRARY_WALL_SEAM_DIRECTION_TEXT: Readonly<Record<LibraryWallSeamDirection, { label: string; description: string }>> = Object.freeze({
    auto: { label: 'options.bravaisSeamDirectionAuto', description: 'options.bravaisSeamDirectionAutoDesc' },
    'auto-reverse': { label: 'options.bravaisSeamDirectionAutoReverse', description: 'options.bravaisSeamDirectionAutoReverseDesc' },
    vertical: { label: 'options.bravaisSeamDirectionVertical', description: 'options.bravaisSeamDirectionVerticalDesc' },
    horizontal: { label: 'options.bravaisSeamDirectionHorizontal', description: 'options.bravaisSeamDirectionHorizontalDesc' },
});

/** 「竖着的屏幕」：高 ≥ 宽 × 1.1（宽高比 ≤ 10 / 11）。 */
export const LIBRARY_WALL_PORTRAIT_QUERY = '(max-aspect-ratio: 10/11)';

/** 「触屏窄视口」的宽度半边：宽 < 720（短边阈值与 phone-fit / sheetPresentation 一族一致）。 */
export const LIBRARY_WALL_SEAM_ROW_NARROW_QUERY = '(max-width: 719.98px)';

/** 此刻信息条该不该横着开：自动时竖着的屏幕横着开，自动（反向）时横着的屏幕横着开。 */
export const resolveLibraryWallSeamHorizontal = (direction: LibraryWallSeamDirection, portrait: boolean): boolean => {
    if (direction === 'auto') return portrait;
    if (direction === 'auto-reverse') return !portrait;
    return direction === 'horizontal';
};

/**
 * 生效的横条判定（触屏窄视口兜底）：compact 横条一行要放下折叠 + 五个一级页签 + 账户 + 搜索 / 设置 / 队列 / 更多 +
 * 展开，44px 触点下约 650px——手机宽度物理不可满足，退让链到底后页签被压进零宽滚动段不可点、行还溢出右缘
 * （纯几何，与 headless 伪影无关）。触屏窄视口（coarse + 宽 < 720，`narrowTouch` 由调用侧按两个媒体查询合成）
 * 上两种「自动」一律改走竖排书脊（竖缝里页签竖排、工具成格，44px 触点规则两变体都覆盖）；用户显式选
 * 「横向」仍尊重其选择（对齐 phone-fit「显式优先」的原则）。
 */
export const resolveLibraryWallSeamHorizontalForTouch = (
    direction: LibraryWallSeamDirection,
    portrait: boolean,
    narrowTouch: boolean,
): boolean => {
    if (!narrowTouch) return resolveLibraryWallSeamHorizontal(direction, portrait);
    return direction === 'horizontal';
};

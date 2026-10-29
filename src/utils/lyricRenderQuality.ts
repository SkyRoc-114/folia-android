// 歌词画布渲染质量（#929）：把散在各风格里的 `min(2, max(1, dpr))` 收拢成一个宿主设置。
// 这里只放纯函数与类型，不 import store —— 各 runtime/组件自行读 useLyricSettingsStore
// 再传进来，保证本文件可单测、也无循环依赖。

/** auto = 维持旧行为（随 devicePixelRatio，钳 1..2）；1/2/3 = 固定倍率。 */
export type LyricRenderQuality = 'auto' | '1' | '2' | '3';

export const LYRIC_RENDER_QUALITY_VALUES: readonly LyricRenderQuality[] = ['auto', '1', '2', '3'];

export const DEFAULT_LYRIC_RENDER_QUALITY: LyricRenderQuality = 'auto';

export const isLyricRenderQuality = (value: unknown): value is LyricRenderQuality =>
    typeof value === 'string' && (LYRIC_RENDER_QUALITY_VALUES as readonly string[]).includes(value);

/** 旧行为：1 倍屏给 1，2 倍及以上给 2（ceil 后钳 1..2）。 */
export const legacyLyricResolution = (devicePixelRatio: number): number =>
    Math.min(2, Math.max(1, Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.ceil(devicePixelRatio) : 1));

/**
 * 歌词图层最终渲染倍率。
 * - 'auto'：维持旧行为（分数字屏向上取整，钳 1..2）；
 * - '1'/'2'/'3'：固定倍率，钳到 ≥1（不设上限：4K 大屏用户可显式选 3，
 *   纹理上限由各消费方（如字形图集的 maxCanvasPx）自行裁剪）。
 */
export const resolveLyricRenderQuality = (quality: LyricRenderQuality, devicePixelRatio: number): number => {
    if (quality === 'auto') return legacyLyricResolution(devicePixelRatio);
    const fixed = Number.parseInt(quality, 10);
    return Number.isFinite(fixed) && fixed > 0 ? fixed : 1;
};

/**
 * 各风格的接入口：auto 时保留该风格原有的 resolution 计算（各处细节略有差异——
 * lattice 用 ceil、hanabi/lumiere 不取整——不去强行统一，避免「自动」档行为漂移）；
 * 固定档统一走 resolveLyricRenderQuality。
 */
export const applyLyricRenderQuality = (
    quality: LyricRenderQuality,
    devicePixelRatio: number,
    legacy: (dpr: number) => number,
): number => (quality === 'auto' ? legacy(devicePixelRatio) : resolveLyricRenderQuality(quality, devicePixelRatio));

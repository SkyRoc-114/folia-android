// src/utils/androidVisualizerPerfCap.ts
// Android 上町景（machi）的画质钳制兜底（设计 docs/plans/2026-10-31-…-design.md §2.3）：
// Android WebView 跑不动桌面档的重 pass，生效值一律钳到「低档」（MSAA/抗锯齿关、阴影倒影关、
// bloom 关、渲染分辨率不高于低档），adaptive 保留——上游的帧时降档继续在帽之下工作。
// 桌面零改动（cap=false 原样返回）。雾笺不钳：上游性能系列已把雾层压到 1/8 分辨率、双程序后台
// 编译，没有独立画质档可钳；WebGL2 不可用时组件自己退回只显示当前句。
// 钳的是「生效值」不是存储值：用户设置原样保留，桌面上仍按用户选择跑。

import { MACHI_QUALITY_PRESETS, MACHI_RENDER_SCALES, type MachiQuality, type MachiTuning } from '../components/visualizer/machi/types';

const LOW = MACHI_QUALITY_PRESETS.low;

/** 域内取不高于上限的最大档（MACHI_RENDER_SCALES 是降序枚举）；上限来自「用户档与低档取小」。 */
const cappedRenderScale = (quality: MachiQuality): MachiQuality['renderScale'] => {
    const limit = Math.min(quality.renderScale, LOW.renderScale);
    return Math.max(...MACHI_RENDER_SCALES.filter(scale => scale <= limit));
};

/** 已在帽下（不高于低档）就不另建对象，调用方 useMemo 可以靠同一引用免掉无谓的重建。 */
const atOrBelowCap = (quality: MachiQuality): boolean => (
    quality.renderScale <= LOW.renderScale
    && quality.antialias === 'off'
    && quality.shadows === 'off'
    && quality.reflections === 'off'
    && !quality.glow
);

/** 把一套町景画质钳到 Android 帽（低档）之下；不高于帽的原样返回同一引用。 */
export const capMachiQualityForAndroid = (quality: MachiQuality): MachiQuality => {
    if (atOrBelowCap(quality)) return quality;
    const capped: MachiQuality = {
        renderScale: cappedRenderScale(quality),
        antialias: 'off',
        shadows: 'off',
        reflections: 'off',
        glow: false,
        // 保留用户的 adaptive 选择：帽下的自动降档在低端机上正是救命的
        adaptive: quality.adaptive,
    };
    return capped;
};

/** 钳町景整套 tuning 的 quality 切片，其余字段原样保留；off-Android 或已在帽下返回同一引用。 */
export const capMachiTuningForAndroid = <T extends MachiTuning>(tuning: T, cap: boolean): T => {
    if (!cap) return tuning;
    const capped = capMachiQualityForAndroid(tuning.quality);
    if (capped === tuning.quality) return tuning;
    return { ...tuning, quality: capped };
};

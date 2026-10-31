// src/utils/androidVisualizerPerfCap.ts
// Android 上町景（machi）的画质钳制兜底（设计 docs/plans/2026-10-31-…-design.md §2.3）：
// Android WebView 跑不动桌面档的重 pass，生效值一律钳到「低档」（MSAA/抗锯齿关、阴影倒影关、
// bloom 关、渲染分辨率不高于低档），adaptive 保留——上游的帧时降档继续在帽之下工作。
// 桌面零改动（cap=false 原样返回）。雾笺不钳：上游性能系列已把雾层压到 1/8 分辨率、双程序后台
// 编译，没有独立画质档可钳；WebGL2 不可用时组件自己退回只显示当前句。
// 钳的是「生效值」不是存储值：用户设置原样保留，桌面上仍按用户选择跑。
// Folium 1.8（3b4f01a7）之后 renderScale/antialias 可以是 'global'（跟随「性能与动效」的全局挡位，
// 见 utils/lyricRenderQuality.ts）：钳制前先按全局挡位 resolve 成数值/枚举（全局 on/auto 对町景就是
// SMAA、off 就是 off），再走原来的帽；resolve 后已在帽下的值原样生效。

import { MACHI_QUALITY_PRESETS, MACHI_RENDER_SCALES, type MachiAntialias, type MachiQuality, type MachiRenderScale, type MachiTuning } from '../components/visualizer/machi/types';
import { DEFAULT_LYRIC_RENDER_QUALITY, type LyricRenderQuality } from './lyricRenderQuality';

const LOW = MACHI_QUALITY_PRESETS.low;

/**町景的 renderScale/antialias 里的 'global' 按全局挡位 resolve 成数值/枚举；其余字段原样。 */
const resolveMachiQuality = (quality: MachiQuality, global: LyricRenderQuality | undefined): Pick<MachiQuality, 'renderScale' | 'antialias'> => {
    const g = global ?? DEFAULT_LYRIC_RENDER_QUALITY;
    const renderScale: MachiRenderScale = quality.renderScale === 'global' ? g.scale : quality.renderScale;
    // 上游约定（machi/types.ts）：全局挡位的抗锯齿「开/自动」就是 SMAA（町景原来的默认），「关」就是关。
    const antialias: MachiAntialias = quality.antialias === 'global'
        ? (g.antialias === 'off' ? 'off' : 'smaa')
        : quality.antialias;
    return { renderScale, antialias };
};

/** 域内取不高于上限的最大档（MACHI_RENDER_SCALES 是降序枚举，取第一个命中）；上限来自「用户档与低档取小」。 */
const cappedRenderScale = (renderScale: MachiRenderScale): MachiRenderScale => {
    const limit = Math.min(renderScale, LOW.renderScale);
    for (const scale of MACHI_RENDER_SCALES) {
        if (scale <= limit) return scale;
    }
    return LOW.renderScale;
};

/** 已在帽下（不高于低档）就不另建对象，调用方 useMemo 可以靠同一引用免掉无谓的重建。 */
const atOrBelowCap = (quality: Pick<MachiQuality, 'renderScale' | 'antialias' | 'shadows' | 'reflections' | 'glow'>): boolean => (
    quality.renderScale <= LOW.renderScale
    && quality.antialias === 'off'
    && quality.shadows === 'off'
    && quality.reflections === 'off'
    && !quality.glow
);

/** 把一套町景画质钳到 Android 帽（低档）之下；不高于帽的原样返回同一引用；'global' 字段先按全局挡位 resolve。 */
export const capMachiQualityForAndroid = (quality: MachiQuality, global?: LyricRenderQuality): MachiQuality => {
    const { renderScale, antialias, ...rest } = quality.renderScale === 'global' || quality.antialias === 'global'
        ? { ...quality, ...resolveMachiQuality(quality, global) }
        : quality;
    const resolved = { renderScale, antialias, ...rest };
    if (atOrBelowCap(resolved)) return quality.renderScale === 'global' || quality.antialias === 'global' ? resolved : quality;
    const capped: MachiQuality = {
        renderScale: cappedRenderScale(renderScale),
        antialias: 'off',
        shadows: 'off',
        reflections: 'off',
        glow: false,
        // 保留用户的 adaptive 选择：帽下的自动降档在低端机上正是救命的；revision 是存档标记，不属于生效值
        adaptive: quality.adaptive,
    };
    return capped;
};

/** 钳町景整套 tuning 的 quality 切片，其余字段原样保留；off-Android 或已在帽下返回同一引用。 */
export const capMachiTuningForAndroid = <T extends MachiTuning>(tuning: T, cap: boolean, global?: LyricRenderQuality): T => {
    if (!cap) return tuning;
    const capped = capMachiQualityForAndroid(tuning.quality, global);
    if (capped === tuning.quality) return tuning;
    return { ...tuning, quality: capped };
};

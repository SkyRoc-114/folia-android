# 实施计划：Folium 1.8 批次（町景性能 + 歌词渲染质量 + mod API）

> **For implementer:** cherry-pick 类验收 =「上游绿→本线绿」；适配类任务严格 TDD（先红后绿）。每任务绿了立刻 commit。
> **设计:** `docs/plans/2026-10-31-folium-1-8-render-quality-design.md`（判定矩阵/交互分析必读）。
> **发版:** v0.7.22-android.292。

## Task 1: cherry-pick Folium 1.8（`3b4f01a7`，111 文件）

`git cherry-pick -x 3b4f01a7`。冲突处理原则：**上游完整实现取代我们 d9796d6a 简版**（fume/hanabi×3/lumiere×2/lyricRenderQuality.ts 全取上游侧）；i18n×4 手工合两侧键（上游新键 + 我们 Android 键共存）；`storedSettingsPins` 快照冲突按 `test/unit/visualizer/storedSettingsPins.test.ts` 重生成校验。
验证：`npx vitest run test/unit/visualizer/lyricRenderQuality.test.ts test/unit/visualizer/machi/ test/unit/visualizer/canvasStyleRenderOverride.test.ts test/unit/visualizer/storedSettingsPins.test.ts` + `pkill -f GradleDaemon; NODE_OPTIONS=--max-old-space-size=2560 npx tsc --noEmit --skipLibCheck` 0 错。
注意：此任务后 `androidVisualizerPerfCap.ts` 会**类型报错**（`'global'` 不可比较）——Task 3 修复，此处 tsc 报错若仅限该文件则记录并放行（Task 2 同理），其余文件必须 0 错。

## Task 2: cherry-pick 导出/心象 fix（`a390a45b`）与雾笺画布（`c56bf8ec`）

顺序 `git cherry-pick -x a390a45b` → `git cherry-pick -x c56bf8ec`（前者依赖 Task 1，后者独立）。
验证：`npx vitest run test/unit/visualizer/`（machiQuality/degradeStatus/nebbiaTuning 等随批落地全绿）。

## Task 3: 钳制层 `'global'` 适配（TDD）

**Files:** Modify `src/utils/androidVisualizerPerfCap.ts`、Test `test/unit/utils/androidVisualizerPerfCap.test.ts`
**Steps:**
1. 红：新用例——`renderScale:'global'` + 全局挡位 `{scale:1.5, antialias:'on'}` 时钳制应输出 `0.75/off`（resolve 后钳）；`'global'` + 全局 `{scale:0.5, antialias:'auto'}`（低于帽）时钳制应输出 `0.5` 且 antialias 按町景默认语义关；high preset 全 `'global'` 字段不崩。
2. 绿：钳制入口先 `resolveLyricRenderQuality(global, override)` 把町景 quality 的 `'global'` 归一成数值/枚举再走原钳制逻辑；`atOrBelowCap` 用归一值比较。
3. 既有 7 例不回归。

## Task 4: 旧 `lyrics_antialias` 退役迁移（TDD）

**Files:** Modify `src/stores/useVisualizerSettingsStore.ts`（或其 persistence 层，上游全局挡位所在地）、`src/stores/useLyricSettingsStore.ts`（删字段）、`src/components/modal/settings/pages/LyricsPage.tsx`（删旧行）、`src/components/app/lattice/lyrics/useLatticeLyricCanvas.ts` + `createLatticeLyricRuntime.ts`（桥接新挡位）、store 契约快照、Test
**Steps:**
1. 红：迁移用例——存了 `lyrics_antialias=true` 时读 `lyric_render_quality` 应得 `{scale:1, antialias:'on'}`；false/未设得默认 `{scale:1, antialias:'auto'}`；迁移后旧键清除。
2. 绿：读取归一化处一次性换算（风格同上游 revision）；lattice 的 antialias 改 `resolveLyricAntialias(global.antialias, true)`（lattice 画布原来 MSAA 默认开——待核 d9796d6a 前行为，以原样为 styleDefault）。
3. LyricsPage 旧开关行删；i18n 旧键（`options.lyricAntialiasToggle` 等，按实况）若上游无对应清理则保留无害或删除。
4. `useLyricSettingsStore` 删 `lyricAntialias` 字段 + 契约快照更新。

## Task 5: 全量验证

1. `tsc --noEmit --skipLibCheck` 0 错（含 electron/mod 7 文件与 folium.d.ts）。
2. `npx vitest run test/unit/` 全量（存量失败白名单：ytmProvider:813）。
3. `git diff 3450fff9..HEAD -- android/` 空（壳零改动）。
4. 四语言渲染质量键齐全（`lyricRenderScale/lyricAntialias` 等，grep）。

## Task 6: 发版 v0.7.22-android.292

1. MERGE-STATE 追加本批记录（含旧键迁移说明）。
2. `package.json`/`package-lock.json` → `0.7.22-android.292`，release commit。
3. tag `v0.7.22-android.292` + push（android-0.7.22、main 不动——main 已重锚定为声明式，发布线推进不必再动 main；meta 随 android 推）。
4. CI：android-pre-release 绿 + 三格式 APK assets 齐全。

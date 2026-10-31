# 设计：Folium 1.8 批次跟进（町景性能 + 歌词画布渲染质量 + mod API）

> **上游范围**：v0.7.25 之后 main 合入的 3 个有效提交（`3b4f01a7` Folium 1.8 大提交、`a390a45b`、`c56bf8ec`），随 `20c3ecd0..c56bf8ec`（含 2 个 `[skip ci]` 代码地图 chore 跳过）。
> **用户指令**：「查看它干什么的再合理迁移（注意android背景）」——本文即"它干了什么"的拆解与 Android 适配判定。
> **发版**：v0.7.22-android.292。

## 1. 上游做了什么（三提交拆解）

### `3b4f01a7` Folium 1.8（111 文件，+3470/-788）

**① 町景切换不卡主线程（#962，machi 域 14 文件 +546/-78）**
- 根因：`renderer.compile()` 渲染目标为 null 时编的是上屏 sRGB+色调映射变体，场景实际画进 HDR 后处理目标，首帧主线程同步重编全部着色器（冷缓存 ~1.6s）
- 修法：`engine/programWarmup.ts`（新）按真实渲染目标预编主场景/倒影/后处理，交 `KHR_parallel_shader_compile` 后台编，编好再画第一帧；建场景分段让出主线程；换场景黑场等编译再淡入；车的裁切挪进车自己的着色器（clippingPlanes 变体预编不到）；生产构建关逐程序取日志
- 实测：冷启动主线程任务 1.8s → 50–85ms；换场景 0.4–1s → 57–67ms
- 稳态开销：干地面无雨跳过水洼/倒影/雨点着色；便利店阴影图隔段重画；去每帧分配；静态合批不算矩阵
- **自动降级顺序改**：先退景深、超采样、几何边缘 MSAA → 再退倒影、辉光、分辨率、后期抗锯齿 → 阴影最后；面板显示当前降了几档（degradeStatus.ts 新）
- **类型变化**：`MachiQuality.renderScale/antialias` 新增 `'global'` 取值（跟随全局挡位）；`MACHI_QUALITY_PRESETS.high` 两项改 `'global'`；存档 revision 机制（无 revision 的旧档归一化为跟随全局）

**② 歌词画布渲染质量（#929 完整版，核心 `utils/lyricRenderQuality.ts` 新 64 行纯函数）**
- 全局挡位 `lyric_render_quality = {scale: 0.5|0.75|1|1.5|2, antialias: auto|on|off}` 存 `useVisualizerSettingsStore`，auto=各样式原样
- 10 样式（花火/绘光/商籁/凝彩/镜台/钟摆/雾笺/浮名/心象/莫奈）tuning 各加 `LyricRenderOverride {scale:'global'|倍数, antialias:'global'|on|off}`，设置面板加「渲染」组默认跟随全局
- 町景两项加「跟随全局」，旧存档默认值迁移成跟随全局；雾笺原分辨率滑块换成共用设置（旧值换算最接近倍数）；花火字形图集上限按超采样放大
- 接线：GraphicsPage「性能与动效」全局挡位 + 命令面板入口；像素密度 = 样式默认密度 × scale，上限 3

**③ Folium mod API（桌面 mod 系统，7 文件）**
- `folium.visualizer.getRenderQuality/setRenderQuality` + `visualizer.renderQualityChanged` 事件 + 新权限 `visualizer.renderQuality`
- `electron/modSystem/{approval.cjs,foliumShared.json}`、`mods/{folium.d.ts,README.md}`、`docs/folium/{api.md,contributing.md}`、`dev/folium/api-docs.mjs`——全为修改非新增

### `a390a45b` fix（11 文件）：视频导出固定按 1× 画（不受渲染质量挡位影响）；心象「默认」不再重置面板上没有的项。依赖 ①② 的 lyricRenderQuality。

### `c56bf8ec` fix（1 文件）：雾笺按排版尺寸量画布，预览里笔画粗细生效（#963）。

## 2. 与我们线的关键交互（侦察实证）

| 交互点 | 事实 | 判定 |
|---|---|---|
| **钳制层 vs `'global'`** | `androidVisualizerPerfCap.ts` 直接 `Math.min(quality.renderScale, LOW.renderScale)` / `<=` 比较——`'global'` 值会让 `Math.min` 产出 NaN、比较恒 false | 🔴 **必须适配**：钳制前先把 `'global'` resolve 成全局挡位实际值（`resolveLyricRenderQuality`），再钳低档；`MACHI_QUALITY_PRESETS.high` 现在含 `'global'`，`atOrBelowCap` 同理 |
| **旧 #929 实现（d9796d6a，.288 自 main 线迁入）** | `lyrics_antialias` 布尔（useLyricSettingsStore）+ LyricsPage 开关行 + lattice（bravais 歌词层）读写；花火/浮名/绘光的简版接线。上游 3b4f01a7 是同一 issue 的完整版（挡位+样式覆盖） | 🔁 **退役并入上游版**：①存档迁移：旧 `lyrics_antialias=true` → 全局挡位 `{scale:1, antialias:'on'}`（一次性，读取时换算，风格同上游 revision 归一化）；false/未设 → 默认 auto ②LyricsPage 旧开关行删除 ③lattice 不在上游 10 样式清单（bravais 墙歌词是本 fork 特性域），其 antialias 读写改接新全局挡位（`resolveLyricAntialias(global.antialias, true)`，等价桥接）④花火/浮名/绘光旧接线在 cherry-pick 冲突解决时以上游版为准 |
| **useLyricSettingsStore.lyricAntialias 字段** | 退役后 store 保留死字段还是删 | 删字段（store 契约快照同步更新，上游 pin 快照本来就要合） |
| **mod API 7 文件** | Android 无 Electron mod 系统；但文件是 fork 树的一部分，tsc 检查 folium.d.ts 自洽；Android 构建链（vite build:capacitor）不含 electron/ 代码 | 📦 **随树全收保持零分叉**（.290 批次原则：文件不分叉，行为不适用处自然不触发）；等价实现=无必要（mod API 只在 Electron 主进程注册） |
| **两个 chore（fa9522d4/d695db52）** | chore(dev) 代码地图 [skip ci] | ⏭️ 跳过（.290 惯例） |
| **machi 新降级顺序 vs 钳制层** | 上游降级顺序改在 engine/quality.ts（adaptive 内部机制）；钳制层钳的是生效值入口，帽下让 adaptive 工作 | ✅ 钳制入口不变，只需适配 `'global'` resolve；新降级顺序在帽下自动生效（Android 反而受益） |
| **花火字形图集上限按超采样放大** | glyphs.ts 冲突文件之一 | ✅ 直接适用（低端机超采样默认 1 不触发） |

## 3. cherry-pick 顺序与冲突预案

```
1. cherry-pick -x 3b4f01a7   （Folium 1.8）
   预期冲突（我们 d9796d6a 改过 ∩ 上游也改）：fume/useFumeCanvasStage、hanabi/VisualizerHanabi、
   hanabi/createHanabiPixiRuntime、hanabi/text/glyphs、lumiere/VisualizerLumiere、lumiereRuntimeTuning、
   utils/lyricRenderQuality.ts、i18n×4、storedSettingsPins 快照
   策略：以上游版为准（完整实现取代简版）；i18n 手工合两侧键；快照按 pin 测试重生成校验
2. cherry-pick -x a390a45b   （依赖 1）
3. cherry-pick -x c56bf8ec   （独立，nebbia 1 文件）
4. feat(android): 钳制层 'global' 适配（TDD：'global'→resolve→钳制；high preset 含 global 的归一）
5. feat(stores): lyrics_antialias 退役迁移（TDD：旧 true→{scale:1,antialias:'on'}；lattice 桥接；LyricsPage 行删；store 字段删）
6. 全量验证：tsc 0 错；unit 全量（新 machi degradeStatus/quality 测试 + lyricRenderQuality 62 例 + canvasStyleRenderOverride 等 24 测试文件随 1 落地）；androidVisualizerPerfCap 7 例改写后仍绿；build:capacitor 不做（无壳改动）
7. 发版 .292 + MERGE-STATE + tag + push + CI 三 APK
```

## 4. Android 背景总结（用户要求）

- 町景冷启动/换场景卡顿的修法全部是 WebGL/浏览器层（KHR_parallel_shader_compile、fenceSync、分段让出主线程），Android WebView (Chromium) 原生支持——**手机 GPU 弱，收益比桌面更大**
- 渲染质量挡位给了 Android 用户官方的降载入口（0.5×/0.75× 分辨率 + 关抗锯齿），与我们的钳制层互补：钳制层兜底默认安全，挡位给用户自调
- mod API 是唯一 Android 不可用部分，随树全收不碰行为

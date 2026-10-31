# 实施计划：雾笺窗外场景批次跟进（上游 scenery-toggles + cold-start）

> **For implementer:** 迁移类任务以「上游绿→本线绿」为验收；上游带测试的提交随 pick 落地即测。每个任务绿了立刻 commit。
> **Goal:** 跟进 folia-major 在 v0.7.25 之后的两条未合并工作线（`feat/nebbia-scenery-toggles` 4 提交 + `perf/nebbia-cold-start-no-gpu-wait` 1 提交，共 5 个非合并提交），全部迁入发布线，一版发 v0.7.22-android.291。
> **Architecture:** 发布线 `android-0.7.22` 逐提交 `cherry-pick -x`（保留来源）；nebbia 目录与本线零差异（就是 v0.7.25 final-state），预期近乎干净；冲突预计集中在 i18n 四语言与 `storedSettingsPins.test.ts.snap`。
> **Tech Stack:** React + TS + WebGL2（纯 web 层，无原生/壳改动）；vitest（测试）。
> **上游状态（2026-10-31）:** `upstream/main` HEAD = `20c3ecd0 release: v0.7.25`（无 v0.7.26）；两条线均未合并、无 PR 信息可用（匿名 API 限流），合并后若有增量按 MERGE-STATE 观察项跟进。

---

## 0. 上游提交清单与 Android 适配性判定

| # | 上游 SHA | 标题 | Android 判定 | 依据 |
|---|---|---|---|---|
| 1 | `69f9fd16` | 雾笺 窗外各样单独开关，窗外的雨可斜着、竖直或不下 | ✅ 直接适用 | 纯设置面板 + uniforms + GLSL + i18n，无宿主依赖 |
| 2 | `37bcf576` | 雾笺 窗外可换成共用背景，播放页透明时透出桌面 | ✅ 核心适用 / 透明路径平台性不触发 | 见下方专项判定 |
| 3 | `5a382dd7` | 雾笺 透明时雾色跟主题日夜，水珠折射街景 | ✅ 直接适用 | 着色器/逻辑，仅在 seeThrough 时生效 |
| 4 | `6c9e40d7` | 节拍时钟只算画出来的背景的节拍效果 | ✅ 直接适用 | 通用 fix（beatClockTargets/definition/useBeatFxTrack），零平台依赖 |
| 5 | `15152f2c` | 雾笺 冷启动不再让主线程等 GPU 进程编着色器 | ✅ 直接适用且更利好 Android | 纯 WebGL2：预设画布尺寸 + 5760² 面积帽 + fenceSync 栅栏；Android WebView 即 Chromium，KHR_parallel_shader_compile 可用；手机 GPU 冷编更慢，收益更大 |

### 2 号提交「播放页透明透出桌面」专项判定

链路（已逐点核实）：
```
transparentPlayerBackground / enablePlayerPageNativeBlur（usePlayerChromeSettingsStore，Android 版同名 store 同样存在）
  → isPlayerPageTransparent（App.tsx:1580，纯 web 层）
  → background.transparent（useVisualizerRendererModel.ts:139）
  → nebbiaSeesThrough()（nebbiaBehind.ts）→ seeThrough 画布
```

- **核心新功能（窗外=共用背景，`tuning.behind === 'backdrop'`）**：纯 web 层，Android 全量可用，是本批主体验。
- **「播放页透明透出桌面」路径（`background?.transparent`）**：依赖宿主窗口透明（Electron / OBS 网页源）。Android Capacitor WebView 不透明是**存量基线**——现状开「透明播放页」透出的就是 WebView 底色。迁移后该路径在 Android 的行为与存量一致（无新错误），`nebbiaSeesThrough` 的 transparent 分支自然不产生额外问题。
- **等价实现结论：不引入 Android 壳改动**。Web 层代码原样迁移（保持与上游零分叉，便于后续跟进）；「把 WebView 真透明透出系统壁纸」涉及 Activity windowIsTranslucent + WebView setBackgroundColor + 层级/性能风险，超出本批，不在 Android 承诺的功能面里（上游该能力本就标注 OBS/桌面场景）。记录到 MERGE-STATE 观察项。

## 1. 冲突预案

- nebbia/**、beatClock*、useBeatFxTrack、definition.ts：本线与 upstream/main **零差异**，预期干净。
- `src/i18n/locales/*.ts`：本线多出 Android 特有键（快捷键显示等）；上游每提交插 2~12 行新键。冲突时以上游 hunk 语义为准手工合入，保持两侧键共存；vi 键位沿用上游原文。
- `test/unit/__snapshots__/storedSettingsPins.test.ts.snap`：上游每提交 +44/-44（settings pin 快照）。冲突时手工合并：保留本线 Android pin 项 + 上游新增 pin 项，然后跑 `storedSettingsPins` 测试重生成校验。
- `test/unit/visualizer/smartBeat.test.ts`、新测试文件 `nebbiaScenery.test.ts` / `nebbiaPrograms.test.ts`：干净或新增，随 pick 落地。

## 2. 任务分解

### Task 1: cherry-pick 窗外单独开关 + 雨方向（`69f9fd16`）
`git cherry-pick -x 69f9fd16`；若 i18n/snap 冲突按 §1 处理。验证：`npx vitest run test/unit/visualizer/nebbiaScenery.test.ts test/unit/__snapshots__ related` + tsc。

### Task 2: cherry-pick 窗外共用背景 + 透明（`37bcf576`）
同模式。注意 `nebbiaBehind.ts` 为新文件、`entry.tsx` 的 `background: nebbiaBackgroundConfig` 接线。验证同上 + `VisualizerNebbia` 相关组件测试。

### Task 3: cherry-pick 透明雾色跟主题（`5a382dd7`）
同模式。

### Task 4: cherry-pick 节拍钟 fix（`6c9e40d7`）
`git cherry-pick -x 6c9e40d7`；README.md 若冲突以本线结构保留两侧说明。验证：`npx vitest run test/unit/visualizer/smartBeat.test.ts`。

### Task 5: cherry-pick 冷启动优化（`15152f2c`）
`git cherry-pick -x 15152f2c`（独立 perf 线，放最后，其 diff 与 Task 2 在 createNebbiaRuntime/nebbiaGl 有小重叠时按内容合）。验证：`npx vitest run test/unit/visualizer/nebbiaPrograms.test.ts` + 全 nebbia 目录测试。

### Task 6: 全量验证 + Android 适配终验
1. `pkill -f GradleDaemon` 后 `NODE_OPTIONS=--max-old-space-size=2560 npx tsc --noEmit` 0 错。
2. `npx vitest run test/unit/` 全绿（存量失败白名单见 MERGE-STATE：bravaisChrome.spec 组件测试为 CI 不跑的存量项）。
3. Android 终验清单：backdrop 选项四语言齐全；`nebbiaSeesThrough` 纯函数单测覆盖 preview 分支；machi 画质钳制（e278adfc）测试不回归；无 Android 壳/Java 改动确认（`git diff --stat 672f7fe4..HEAD -- android/` 为空）。

### Task 7: 发版 v0.7.22-android.291
1. `docs/state/MERGE-STATE.md` 追加本批记录 + 观察项（scenery/cold-start 上游合并后的增量核对；Android WebView 透明宿主能力不做承诺）。
2. `package.json` / `package-lock.json` → `0.7.22-android.291`。
3. Release commit（惯例格式：chore(release) + 批次要点），tag `v0.7.22-android.291`，push 分支 + tag。
4. CI 确认：android-pre-release workflow 绿，release 三格式 APK（armv7/armv8/universal）齐全。

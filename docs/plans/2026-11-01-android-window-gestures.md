# 实施计划：弹窗独立窗口化 + 手势补全（.294）——2026-11-01

设计见 `docs/plans/2026-11-01-android-window-gestures-design.md`。每任务=TDD：先测→红→实现→绿→提交。
沙箱约束：无 JDK；tsc 用 `pkill -f GradleDaemon; NODE_OPTIONS=--max-old-space-size=2560 npx tsc --noEmit -p tsconfig.json --skipLibCheck`；单测 `npx vitest run -c vitest.config.ts <file>`。

## Task 1 — 呈现与两个手势决策的纯函数
- 新 `src/components/shared/sheetPresentation.ts`：
  - `SHEET_BOTTOM_MAX_WIDTH = 720`、`DRAG_DISMISS_VELOCITY = 0.5`（px/ms）、`DRAG_DISMISS_DISTANCE_MIN = 120`、`DRAG_DISMISS_DISTANCE_RATIO = 0.2`、`PAGER_COMMIT_RATIO = 0.25`、`PAGER_FLICK_VELOCITY = 0.5` 常量导出。
  - `sheetPresentation({ coarse, portrait, width }): 'bottom' | 'card'`。
  - `sheetDragDecision({ dy, vy, viewportH, closeBlocked }): 'dismiss' | 'restore'`（dy<0 → restore；closeBlocked → restore；fling 或距离达标 → dismiss）。
  - `pagerSwipeDecision({ dx, dy, vx, width, page, count, canGo }): -1 | 0 | 1`（|dy|>|dx| → 0 轴锁；不达距离与速度 → 0；越界/canGo 假 → 0；dx<0 → next=+1，dx>0 → prev=-1）。
- 测试 `sheetPresentation.test.ts`：bottom 四条件全真；平板 900宽/横屏 700宽/桌面细指针/竖屏缺失 → card；拖拽：快速小位移 dismiss、慢速大位移 dismiss、慢速小位移 restore、dy 负 restore、closeBlocked 恒 restore；pager：横滑过阈值、快 flick、纵向让位、两端越界、canGo 拦截、斜向以横为准。
- 提交：`feat(ui): 弹窗窗口呈现与手势决策纯函数——bottom/card 呈现、下拉关闭、横滑翻页`

## Task 2 — Sheet 接 bottom 呈现（把手 + 自底滑入 + CSS）
- `Sheet.tsx`：`useMediaQuery` 三查询（coarse/竖屏/宽）→ `sheetPresentation`；`<html>` 挂 `data-folia-sheet-presentation`（effect 写属性，卸载不删——值恒为最新）；bottom 时：overlay `items-end p-0`（安全区走 CSS）、忽略 `restHeight` 的 paddingTop、忽略 `from`、进出场 `y:'110%'↔0`（`leave='through'` 照旧）、面板顶渲染把手 `data-folia-sheet-handle`。
- 新 `src/styles/androidSheetPresentation.css`（挂 `html[data-folia-sheet-presentation='bottom']`：overlay padding 0+底部安全区、dialog 全宽/顶圆角 26px/max-height 视高-顶部安全区-12px/padding 0），import 排在 `androidPhoneFit.css` 之后（找到导入点跟随）。
- 验证：tsc 0 错；现有 Sheet 相关测试全绿（无 DOM 基建，按仓库惯例）。
- 提交：`feat(ui): Sheet 安卓竖屏贴底呈现——全宽顶圆角把手、自底部滑入，桌面原样`

## Task 3 — Sheet 下拉关闭
- `Sheet.tsx`：拖拽壳 motion.div 只驮 `y` motion value；pointerdown 限定 `[data-folia-sheet-drag]`（把手+header 行）且不在 `button,a,input,select,textarea,[aria-haspopup]` 内；跟手 `dragY=max(0,dy)`；松手 `sheetDragDecision`：dismiss → 先 `onEscapeRef`（吃了=退页，弹回 0），再 `closeDisabled`（弹回 0），否则飞出（面板高+48，180ms；reduced 0ms）后 `requestCloseRef`。
- header 行挂 `data-folia-sheet-drag`。
- 验证：tsc；dragDecision 测试已绿。
- 提交：`feat(ui): Sheet 把手/头部下拉关闭——语义同返回键（onEscape 先退页），closeDisabled 弹回`

## Task 4 — 登录窗窄版双页 pager
- `LoginWindow.tsx`：narrow 时 Sheet `body="fill"`，内容换双页轨道：page0=`column('column')` 竖列（内滚），page1=原窄版栈（tile+message+below，内滚）；页=`providerId?1:0` 派生；CSS transition 滑动 + 拖拽位移直写（无过渡）；`pagerSwipeDecision` commit：到 page0 调 `onEscape()`；page0 无 chosen 不可进 page1（橡皮）。
- page1 时 `headerActions` 放「平台列表」返回钮（ChevronLeft，`onEscape`）。
- i18n 四语言加 `login.backToPlatforms`（zh-CN「平台列表」/ en "Platforms" / vi / in）。
- 验证：tsc；`loginHostState.test.ts` 回归绿（backOut 语义未动）。
- 提交：`feat(login): 登录窗窄版双页横滑——平台列表↔登录画跟手翻页，返回键/滑动/返回钮同一条 backOut 规矩`

## Task 5 — PlaybackEntryViewPrompt 横滑翻页
- 面板接 pointer swipe：`pagerSwipeDecision` flick commit → `goTo(pageIndex±1)`；起手在按钮上不拦翻页以外的路径（沿用现有 stopPropagation）；calm（reduced motion）下照翻（即时切页）。
- 验证：tsc。
- 提交：`feat(onboarding): 播放入门向导支持触摸横滑翻页`

## Task 6 — 自主巡检
- grep `window.confirm|window.alert|window.prompt` 残留（应为零，有则记 issue 不扩scope）；全量 `npx vitest run -c vitest.config.ts` 对照 .293 基线（13640 过/1 存量败 ytmProvider:813/3 skip）；tsc 0 错。
- 提交（如有巡检产物）或记入 MERGE-STATE。

## Task 7 — 发版 .294
1. `package.json` → `0.7.22-android.294`；MERGE-STATE.md 记本轮（手势三件套+bottom 呈现+登录 pager+prompt 翻页；fork 侦察引用 .293 结论）。
2. release commit + tag push → CI success → 三 APK published；签名指纹门禁绿（A8ED29C8）。
3. push `android-0.7.22` + `android-0.7.22:meta`。
4. release notes：老版本用户一次性卸载重装公告延续；bottom 呈现说明（若用户另指「自由小窗」下轮再议）。

# Android 弹窗「独立窗口」化 + 手势补全设计——2026-11-01

用户反馈（.293 之后）：手势仍然无效，要求「把所有的弹窗换成适用于安卓的独立窗口」。本文为 brainstorming 产出，证据先行；接续 `2026-11-01-android-signing-backgesture-design.md`（签名/返回键/透明开关已在 .293 闭环，本文不重做）。

## 0. 现状盘点（代码实证）

**返回键链路（.293 已修，本轮复核无误）**：系统返回/边缘手势 → `MainActivity.OnBackPressedCallback` → `FoliaNativePlugin.emitBackPressed()` → JS `useNativeBackButton` 在焦点元素上合成 Escape → Sheet 的 document 监听收到 → `onEscape`（多页先退页）→ `requestClose`。链路每一环都在，`useNativeBackButton.test.ts` 锁着。**用户仍报「无效」的另一解释：签名断签导致老版本用户装不上 .293（.293 起一次性卸载重装），他们手上还是旧壳。**

**手势缺口（本轮要补的全部）**：
1. **没有下拉关闭**：18 个 Sheet 弹窗只有 X / 点遮罩 / Esc 三条关闭路径，Android 标准的「从窗口下拉 dismiss」不存在。
2. **没有横滑翻页**：登录窗窄版（≤804px）是「平台行+画+话」堆在一列里滚，根本没有「页」；`PlaybackEntryViewPrompt`（第 X 步/共 Y 步的多页向导）只有按钮翻页，无触摸无键盘。用户原话「登录界面应该支持触摸左右滑动」「图片作为多页情景同理」指的就是这两处。全仓库无任何多页图片查看器（Explore 全面侦察结论），多页 overlay 就这两个 + 设置窗（已有 chip 导航）。
3. **呈现还是「网页弹窗」**：Sheet 是桌面式居中卡片（400-1160px 定宽、四周留白、整体缩放进场）。手机上（尤其 phone-fit 关着时——它是 opt-in 设置，存储默认 false）观感就是网页里浮的一块 div，不是 Android 那种「独立窗口」。

## 1. 方案：窗口呈现与手势按「视口事实」走，与 phone-fit 设置解耦

**呈现判定（纯函数）**：`sheetPresentation({ coarse, portrait, width })` → `'bottom' | 'card'`。
- `bottom` = 触摸指针（pointer: coarse）+ 竖屏 + 宽 < 720px：真手机。贴底弹出、全宽、只有顶圆角（26px）、顶部把手、入场自底部滑入。
- `card` = 其余一切（桌面、窄桌面窗、平板、横屏）：上游原样，一行不动。
- **不挂 phone-fit 设置**：默认安装（phone-fit=false）也直接获得安卓窗口呈现。这是「适用于安卓的独立窗口」的本意；phone-fit 依旧只管它自己那批布局规则。

**Sheet 增量（一处治全部 18+11 个弹窗）**：
- `SheetFrame` 挂 `data-folia-sheet-presentation='bottom'|'card'` 到 `<html>`（`useMediaQuery` 三个查询组合，CSS 按属性挑选择器，新增 `androidSheetPresentation.css` 排在 `androidPhoneFit.css` 之后，!important 覆盖它的定宽/全圆角规则）。
- 进出场：bottom 时 `y: '110%' ↔ 0`（自底部滑入滑出），`leave='through'`（登录成功那一出）保持不变；`from` 入场偏移在 bottom 下忽略。
- 把手：面板顶一条 36×4 圆角把手（纯视觉 + 拖拽锚点），仅 bottom。

**下拉关闭（安卓返回的同义词）**：
- 起手限定「把手 + 头部行」（`data-folia-sheet-drag`），起手点在按钮/输入类控件上不拖；竖直跟手 `translateY = max(0, dy)`，水平不动。体层滚动不受影响（体不在拖拽面内）。
- 松手决策（纯函数）：`sheetDragDecision({ dy, vy, viewportH, closeBlocked })` → fling（vy ≥ 0.5px/ms）或拖过 max(120px, 20% 视高) → dismiss；否则弹回。`closeDisabled` 永远 restore（与变暗的 X 同语义）。
- **dismiss 走与返回键完全相同的语义**：先问 `onEscape`（多页先退页，面板弹回不飞走），没消费才飞出+`requestClose`。不做第二套规矩。
- 实现：包一层只驮 `y` motion value 的拖拽壳（outside panel motion.div），进出场动画照旧在面板上，互不打架。

**登录窗窄版双页 pager**（`LoginWindow` narrow 分支重构）：
- page 0 = 平台列表（复用 `column('column')` 竖列，全宽大触点）；page 1 = 登录画（tile + message + 详情，原窄版内容）。
- **页 = `providerId` 派生**（选了平台→1，`backOut` 清掉→0）：不新增状态机，返回键/滑动/点击三条路殊途同归。
- 跟手横滑 + 松手决策（纯函数 `pagerSwipeDecision`）：横移 ≥ 25% 宽或 |vx| ≥ 0.5px/ms 才 commit，纵向意图让位（轴锁），边界橡皮。page1→page0 的 commit 调 `onEscape()`（= host.backOut，登录停、晚到回答作数——与返回键同一条规矩）。
- page 1 头部加「平台列表」返回钮（`headerActions` 位）：桌面窄窗（≤804px，无触摸无返回键）必须有点得到回去的路。
- Sheet body：narrow 时 `'fill'`（两页各自管滚动），wide 不动。

**PlaybackEntryViewPrompt 接横滑**：同一 `pagerSwipeDecision`，flick 翻页（±1，按钮保留），不跟手（它的 AnimatePresence 结构不值得为跟手重构）。

## 2. 取舍与不做

- **横屏不出 bottom 呈现**：横屏矮窗全宽贴底没有可看内容，保持 card（phone-fit 横屏规则继续管）。
- **不把弹窗做成 Android 原生 Dialog/新 Activity**：WebView 壳里再造原生窗需要把每个弹窗的 UI 重写进原生或再开一个 WebView，18 个弹窗工程量爆炸且丢失全部 web 交互；bottom-sheet 呈现 + 手势补全在用户感知上就是「安卓的独立窗口」（Android 自己的 bottom sheet 也是这么呈现的）。此解读写进 release notes，用户若另有所指（如自由小窗）下轮再议。
- **不动 phone-fit 默认值**：那是全应用布局开关，本轮只管弹窗；release notes 提示手机用户可开「手机适配」。
- **fork 侦察**：.293 轮已查 EasonLai96（Capacitor 移植，返回键无定制）、hejunlin1755（同样断签），无手势/弹窗可借鉴实现，本轮不重查。
- **自主巡检**：全量回归 + tsc 之外，grep `window.confirm`/`alert(` 等原生弹窗残留，有则换 ThemedDialog（预计为零，上游早已自绘）。

## 3. 验证与版本

- 纯函数单测三件套：`sheetPresentation`（6 边界）、`sheetDragDecision`（阈值/fling/closeBlocked）、`pagerSwipeDecision`（轴锁/边界/速度）。
- 全量 vitest 对照 .293 基线；tsc 0 错；CI 三 APK；签名指纹门禁绿（A8ED29C8 不变）。
- `0.7.22-android.294`，tag `v0.7.22-android.294`；release notes 首条提醒：老版本用户仍需那一次卸载重装（.293 公告的延续）。

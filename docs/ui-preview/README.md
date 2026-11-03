# folia-android 手机端 UI 渲染集（16 屏）

- **设备规格**：360×640 @DPR3 = **1080×1920**（1:1 手机分辨率）、`hasTouch`/`isMobile`、locale **zh-CN**、phone-fit 显式开（`folia_android_phone_fit='true'`）
- **首启门控五键预置**：phone-fit + `playback_entry_view_chosen` + `library_suite_prompt_seen` + `folia_last_seen_ponder_onboarding_version` + `folia_last_seen_guide_version`（防引导弹窗入镜）
- **代码基线**：v0.7.22-android.300（.299 基座 + 搜索离线判定）
- **复现**：`npx vite build && npx vite preview --port 4173`，然后 `node scripts/render-mobile-ui.mjs`（主 14 屏）+ `node scripts/render-extra.mjs`（补 02/15）+ `node scripts/render-offline-search.mjs`（16 离线空态，含断言）；渲染与探针脚本入库 `scripts/`（render-mobile-ui.mjs / render-extra.mjs / probe-{dom,palette,player}.mjs / probe-spine-geometry.mjs / probe-seam-expanded.mjs / probe-tablet-seam.mjs）
- **入库说明**：本渲染集同时入库在仓库 `docs/ui-preview/`（沙箱 download/ 目录会被周期性回退清空，仓库是持久正本；每次重渲染后整组替换、不留旧版本）

## 清单

| # | 文件 | 内容 |
|---|------|------|
| 01 | 01-home-wall.png | home 墙（phone-fit 书脊横条布局，未登录空态；.299 回归上游：34px 按钮、页签导航段 60px 横滑） |
| 02 | 02-home-tab-local.png | home 本地页签 |
| 03 | 03-lattice-queue-wall.png | lattice 队列墙 |
| 04 | 04-player.png | 播放页主界面 |
| 05 | 05-panel-cover.png | 播放页面板·封面 tab |
| 06 | 06-panel-queue.png | 播放页面板·队列 tab |
| 07 | 07-panel-controls.png | 播放页面板·控制 tab |
| 08 | 08-equalizer.png | 均衡器 |
| 09 | 09-panel-account.png | 播放页面板·账户 tab |
| 10 | 10-settings-landing.png | 设置落地页（.299 传统移动端化：全屏 edge-to-edge、搜索 + 分组类目根列表） |
| 11 | 11-settings-section.png | 设置·外观子页（.299 抽屉式：页头 ← 返回箭头 + 页内锚点页签） |
| 12 | 12-search-workspace.png | 搜索激活态（zh 本地化 placeholder「在当前来源搜索歌曲」） |
| 13 | 13-command-palette.png | 命令面板（zh 行 + zh 分类 chip，无英文等价物） |
| 14 | 14-login-window.png | 登录窗 |
| 15 | 15-search-overlay.png | 首页搜索覆盖层 |
| 16 | 16-offline-search.png | 搜索离线空态（.300：断网提交在线搜索 → store 离线预检 → WifiOff + 「未连接网络，请检查网络后重试。」+ 重试，不再误报「搜索失败」） |

> 平板双栏（.299）：触屏平板（coarse + 宽≥720 + 高≥720）上 auto 方向开竖缝——缝把墙分成左右两部分（M3 expanded 双栏），实测探针 `scripts/probe-tablet-seam.mjs` 四断言全过（平板竖/横竖缝、桌面/手机上游语义不变）。

> 未登录状态下播放页 TabDock 只渲染 cover/controls/queue/account 四个 tab（local/navi/onlineLyrics 不可用不出现）；空态入口缺失与两处轻微重叠（面板 × 关闭钮 vs 末 tab、命令面板 placeholder vs ？钮）为已知观察项，登录+播放内容后可补全形态。

## .299 探针实证

- **书脊横条回归上游**（360×640）：全按钮 34px 上游原生尺寸、页签文字中心偏移 0.00、行无溢出——折叠 12-46 | 页签导航段 54-114（60px 可横滑，五页签全部触达）| 账户 122-156 | 工具坞 164-306 | 展开 314-348；.295 的 seam 44px 触点规则与 .296 触屏竖排兜底已移除（上游 phone-fit 本就零 seam 规则）
- **窄缝展开态**：工具坞 190-348、按钮 38px、cx 209/249/289/329 等距 40px，对齐无偏
- **平板双栏**（`scripts/probe-tablet-seam.mjs` 四断言全过）：触屏平板竖屏 800×1280 竖缝 x=365 w=64 全高、横屏 1280×800 竖缝 x=577 w=120 全高（缝把墙分成左右两部分）；桌面 800×1280 非触屏横条 800×52、手机 360×640 横条 360×52（上游语义不变）

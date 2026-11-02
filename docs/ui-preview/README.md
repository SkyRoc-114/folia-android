# folia-android 手机端 UI 渲染集（15 屏）

- **设备规格**：360×640 @DPR3 = **1080×1920**（1:1 手机分辨率）、`hasTouch`/`isMobile`、locale **zh-CN**、phone-fit 显式开（`folia_android_phone_fit='true'`）
- **首启门控五键预置**：phone-fit + `playback_entry_view_chosen` + `library_suite_prompt_seen` + `folia_last_seen_ponder_onboarding_version` + `folia_last_seen_guide_version`（防引导弹窗入镜）
- **代码基线**：v0.7.22-android.298（书脊工具格右偏修复）——含 .297 双语修复与 .298 对齐修复
- **复现**：`npx vite build && npx vite preview --port 4173`，然后 `node scripts/render-mobile-ui.mjs`（主 14 屏）+ `node scripts/render-extra.mjs`（补 02/15）；渲染与探针脚本入库 `scripts/`（render-mobile-ui.mjs / render-extra.mjs / probe-{dom,palette,player}.mjs / probe-spine-geometry.mjs / probe-seam-expanded.mjs）
- **入库说明**：本渲染集同时入库在仓库 `docs/ui-preview/`（沙箱 download/ 目录会被周期性回退清空，仓库是持久正本；每次重渲染后整组替换、不留旧版本）

## 清单

| # | 文件 | 内容 |
|---|------|------|
| 01 | 01-home-wall.png | home 墙（phone-fit 书脊布局，未登录空态；.298 书脊工具格对齐修复后） |
| 02 | 02-home-tab-local.png | home 本地页签 |
| 03 | 03-lattice-queue-wall.png | lattice 队列墙 |
| 04 | 04-player.png | 播放页主界面 |
| 05 | 05-panel-cover.png | 播放页面板·封面 tab |
| 06 | 06-panel-queue.png | 播放页面板·队列 tab |
| 07 | 07-panel-controls.png | 播放页面板·控制 tab |
| 08 | 08-equalizer.png | 均衡器 |
| 09 | 09-panel-account.png | 播放页面板·账户 tab |
| 10 | 10-settings-options.png | 选项设置 |
| 11 | 11-settings-section.png | 设置·主题 section |
| 12 | 12-search-workspace.png | 搜索激活态（zh 本地化 placeholder「在当前来源搜索歌曲」） |
| 13 | 13-command-palette.png | 命令面板（zh 行 + zh 分类 chip，无英文等价物） |
| 14 | 14-login-window.png | 登录窗 |
| 15 | 15-search-overlay.png | 首页搜索覆盖层 |

> 未登录状态下播放页 TabDock 只渲染 cover/controls/queue/account 四个 tab（local/navi/onlineLyrics 不可用不出现）；空态入口缺失与两处轻微重叠（面板 × 关闭钮 vs 末 tab、命令面板 placeholder vs ？钮）为已知观察项，登录+播放内容后可补全形态。

## .298 对齐修复实证（探针几何）

- 书脊（64px）：搜索/设置/队列拼贴/更多 四格按钮 cx **181.92 → 177.92**，与折叠/页签/账户/展开同轴（修复前右偏 4px）
- 窄缝（120px）：四格 cx 对齐 grid 轨道中心（153.92/201.92），列间视觉间隙恢复设计值 8px（修复前 4px）
- 页签竖排文字中心偏移 0.91px 属亚像素渲染精度（非缺陷）；触点尺寸全部保持 44px 不变

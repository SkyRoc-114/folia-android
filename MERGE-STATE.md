# MERGE-STATE.md — folia-android 合并状态（会话间接力文档）

> 本文件与 `scripts/` 一起提交在 origin 的 `meta` 孤儿分支上，沙箱重置后用
> `git fetch origin meta && git checkout origin/meta -- MERGE-STATE.md scripts/` 恢复。
> 未推送的本地提交会在重置后丢失 —— 每批做完立即 push。

## 仓库关系

- `origin` = https://github.com/SkyRoc-114/folia-android （Android 移植 fork，工作分支 `android-0.7.22`）
- `upstream` = https://github.com/chthollyphile/folia-major （上游桌面版）
- `whycfawa` = 父仓库参考（`https://github.com/whycfawa/folia.git`；2026-10-29 查询 404，可能已改名/转私有，用到时先 `ls-remote` 验证）
- 凭证：`/home/z/my-project/.gh-credentials` 与 `~/.git-credentials`（credential.helper=store）
- ⚠️ PAT 绝不能写进仓库任何被跟踪的文件

## 当前进度（2026-10-30 09:05 +08 更新）

- **上游 v0.7.23（120 提交，B6-1..B6-6）：✅ 全部合入**（`git cherry android-0.7.22 v0.7.23` 零缺口，两个实例各自独立验证过），随 v0.7.22-android.282/.283/.284 发布
- **T1-T6 修复任务**：T1 启动闪斜体 ✅、T2 触屏按钮裁剪 ✅、T3 后台节流 ✅（真机耗电验证仍待，需实机）、T4 搜索页X误触灯泡 ✅、**T5 教程触屏分镜 ✅（随 .285 发布）**、T6 杂项视为关闭
- **issue 务实修复批（用户指令「去理想化修复issue」放行，随 .286 发布）**：
  - **#869 ✅**（162c279c）流式音源 duration=Infinity 时用元数据时长兑底上报 MediaSession 进度
  - **#889 ✅**（500d99bb）平台判死曲目（taken-down/no-audio/audio-unplayable/not-public）不倒数直接切下一首，即时跳过上限 20；新选项 `skipLoadingStatusToast` 让失败提示短暂可见
  - **#843 ✅**（d91f34c6）bravais 拖动相机改 rAF 目标插值（tau=8ms，收敛 snap 半设备像素），renderFrame 从帧状态新增的 renderCenter 出变换；spec 见 /home/z/my-project/spec-issue-fixes-2026-10-29.md
- **最新发布：v0.7.22-android.289（2026-10-31，用户指令「触发workflow发布新版本，自行下载所需工具和依赖辅助审查」放行）**：
  - **Android 7 闪退修复 ✅**（90072e92，自 main 7ab60536 移植）：FoliaPlaybackService 通知构建用 API 26 双参构造器 Notification.Builder(Context, channelId)，而第一次构建通知恰在「打开歌曲→获取歌曲链接」时，Android 7（API 24/25）上抛 NoSuchMethodError 闪退；按 SDK_INT 分支构造器，setter 链两分支共用（全自 API 21 起存在）
  - **实时日志落盘 ✅**（d3bc59e3，自 main 578efcd5 移植，对齐桌面 debug 模块）：SAF 选文件夹（ACTION_OPEN_DOCUMENT_TREE 持久授权），每次启动新建 folia-log-<时间戳>.txt（保留最近 8 个、只删自家前缀），console 行 500ms 批量即写即刷，崩溃前最后一行落盘；开卡回放内存缓冲；授权失效/写失败可见化。consoleLogBuffer 增 addConsoleLogSink 双 sink 并存
  - **审查适配（本线移植时的差异）**：设置卡按本线 pages 结构用 kit Group/Row 写进 DeveloperPage（main 线的 DeveloperSettingsSubview 本线零引用，已删）；FoliaNativePlugin.java 与上游 Spotify 登录段共存（41 个 PluginMethod 全保留）；vi 文案人工翻译非英文占位
  - **⚠️ main 线与发布线的 QQ 批次缺口（下批需用户拍板）**：main 上的 QQ/NetEase/KuGou 修复系列（970ef5be..d1d11bf7，约 25 提交：QQ 扫码登录/点赞/订阅/vkey/射频，0.7.20 基线）从未进发布线；本次按指令只移植本会话两笔。若要移植需跨 0.7.20→0.7.23 基线，冲突面集中在 qqTransport/nativeBridge/i18n
  - 验证：tsc 0 错；定向 vitest 304 例全过（consoleLogBuffer/i18n×4/settings 全套 23 文件/nativeBridge×2）；build:capacitor 产物 237 项正常；⚠️ 本环境 4G 内存，tsc 会被残留 Gradle 守护进程挤 OOM（先 `pkill -f GradleDaemon` 再跑，NODE_OPTIONS=--max-old-space-size=3072）
- **v0.7.22-android.288**（三件套批次：#929/#866/轻量模式第一阶段；分片全量回归 3 片全过；workflow run 40981761203 success，三格式 APK assets 齐全，armv7/armv8/universal 各 37.6MB）
- fork 仓库 0 issue（开+关均 0）；上游 34 个开放 issue，已筛出 Android 相关角度（见下）
- **巡检（2026-10-29 17:05 +08，沙箱重置后恢复）**：origin tip 与 tag .286 一致（1695a272）、workflow run#7 completed/success（APK 已发）、上游 **v0.7.24 未发 tag**（最新 v0.7.23，main tip f96c65b2）——无合并动作；发现 android-0.7.22 分支上的 MERGE-STATE.md 漏推 .286 版（已补同步，docs 提交 6db9534d，此后 tip 可领先 tag 一个文档提交属正常）；凭证/仓库/scripts 均已重建（blobless clone）
- **APK 多格式发布（用户指令「apk少了几个格式armv7 universal armv8」，随 .287 发布）**：`android/app/build.gradle` 加 `splits.abi`（armeabi-v7a + arm64-v8a + universalApk），workflow Rename 步骤改为三产物（`folia-<v>-armv7/-armv8/-universal.apk`）；spec 见 /home/z/my-project/spec-apk-abi-splits.md；提交 1f696ba3。**纯构建配置改动跳过 tsc/vitest，以 CI 构建结果验收**
- **fork 生态侦察（2026-10-29，用户指令「查看forks找找亮点」）**：本仓库 0 fork；folia-major 50+ forks 无实质领先（最多 ayegeer105-del +7 全是 README 更新；chenlibiao2004-tech +3 是 vercel API 代理）。第三方 Android 移植亮点：
  - **huleixin/folia-rear-lyrics（22⭐）**：小米 17 Pro 背屏歌词（Shizuku 授权，保留歌词舞台样式铺满背屏）；**轻量 mobile 界面**（虚拟列表+独立底部播放条，Android 默认启用可切回）；发布规范好（APK SHA-256、源码快照 zip、AGPL 署名；版本 `0.7.20-android.194-rear.r245` 叠 fork 后缀）。**mobile 轻量界面思路值得借鉴**（低端 Android 机性能）
  - **Sakurakilove/folia-major-android-apk**：bravais 滑动裁剪图块呈现顺序修正（避免保留封面节点反复 detach/reinsert，与 #843 相邻）；暂时关闭 Kyant 原生折射层换网页实时模糊（WebView 性能务实取舍）；REPAIR_STATUS/WORKLOG 文档纪律；只发 arm64 单包
  - **yezitotempeace/folia-android**：双安装包（带/不带模组商店）功能变体；**davaded/folia-android**：x86_64 车机 GeckoView 壳；**结论：生态无任何项目做 armv7/armv8/universal 三件套，.287 做即首个**
- **三件套批次（用户指令「查看，开始#866/929和轻量工作」放行，随 .288 发布）**：
  - **#929 ✅**（d9796d6a）歌词画布渲染倍率/MSAA 一等设置：`src/utils/lyricRenderQuality.ts` resolver（auto/1/2/3，auto 保留各风格旧行为）；lyricRenderQuality+lyricAntialias 挂 useLyricSettingsStore；lattice/hanabi/lumiere/fume 四处接入（fume snapshotScale 钳 2）；glyphs 图集上限改 `4096*resolution`；hanabi antialias 读设置；rebuildKey 重建（lattice 走 resize 更轻）；LyricsPage 新「歌词渲染」组
  - **#866 ✅**（95f344e4）M3U 歌单跟源 + 启动自动重扫：LocalPlaylist.sourcePath；upsertLocalPlaylistFromFile（sourcePath 精确或同名兜底匹配→更新不新建，名字/收藏保留；normalizePlaylist 透传 sourcePath）；autoRescanOnStartup（默认关）+ useLocalLibraryStartupRescan 启动 4s 重扫（Android=MediaStore 扫描，是移动端唯一自动重扫入口——FileSystemObserver 在 Android 不可用）；StoragePage 全平台「启动时重扫」组
  - **轻量模式第一阶段 ✅**（470693f2）：useAndroidLayoutSettingsStore.liteModeEnabled（Android 壳默认开）；VisualizerTempera 生效 tuning 强制 postProcessEnabled=false（只改生效值不动存储）；GeneralPage Android 组开关。v2 扩展点：列表虚拟化、更多特效降级
  - **测试债**（dae8be6f + 2c6be26a）：.286 #889 漏更新 4 个 countdown 期望测试，已还清；queueReplaceRaces 两例改用 sign-in-needed 保留 countdown 窗口测替换竞态
  - **契约修复**（0ebb5cff/95bdaf4b）：storeContract 靠模块级 XXX_KEY 常量声明抓 key——新 store key 必须用常量模式，勿用裸字面量（lyrics_antialias 教训）
- **⚠️ 双实例接力（2026-10-30 00:00-00:45）**：本批三功能由会话 A（00:09-00:24）完成提交+定向验证；会话 B 接手跑分片回归、还 queueReplaceRaces 债、发布 .288；会话 A 随后补 storeContract 契约修复（95bdaf4b）。两实例在同一沙箱文件系统交错操作，靠 git log/reflog 理清，无冲突
- **⚠️ 环境新坑（2026-10-29）**：①全仓库 4478 文件 chmod 644→755 的 mode 噪音：`npm version` 必触发，且**环境自身也会周期性触发**（00:00 巡检实测，未跑 npm 仍出现）——改版本号一律 node 手工改 package.json+package-lock.json；遇到 status 大片 M 先看 diff 是否纯 mode（0 insertions），是就 `git restore .` 清理；②`~/.git-credentials` 与 global `credential.helper` 会被环境定期清掉（本日两次）——重建法在速查区；③`git restore .` 前必须先 stage 真实改动（本次误伤 build.gradle/workflow 编辑重做一遍）

## ⚠️ 并行实例协议（2026-10-29 15:00 触发实测）

同一次 cron 触发出现过**两个 agent 实例并行**操作同一仓库（一个完成 T5 验证+发布 .285，另一个建 meta 分支+验证 cherry）。接力的会话**动手前必须**：

1. `git fetch origin && git log origin/android-0.7.22 --oneline -3` + `git ls-remote --tags origin` —— 看 tip 和最新 tag，别重复发布、别基于旧 tip
2. `ps aux | grep -E "vitest|tsc|npm exec"` —— 有残留进程先判断是谁的（reflog 看时间线），**不要贸然 reset --hard**；必要时先备份工作树文件
3. `git reflog -10 --date=format:'%H:%M'` —— 理清 HEAD 移动史，识别另一实例的动作
4. 推送/打 tag 遇到已存在就适配（读 origin 状态），不要 force

### 实例互踩实例（教训）

- 甲实例 `git checkout --orphan meta` 失败（乙实例已建）后，`&&` 链被 `| head` 吞掉退出码继续跑，`git rm -rf --cached . + commit` 把 android-0.7.22 本地 tip 污染成 2 文件树 → 靠 reflog 定位、`reset --hard <好提交>` 修复（origin 未受影响）。**教训：链式命令里别用管道吞关键命令的退出码；破坏性命令前先 `git branch --show-current`。**

## 下一批从这里开始

1. v0.7.23 已全部收尾；上游 main 已领先 v0.7.23（v0.7.24 开发中，截至 2026-10-29 领先 7 个非 merge 提交：remote 队列展开 #926、底部字幕布局 #924、login 测量修复 #914、fix(dev)、RPM build-id 等），**不要提前去合**，等上游出 v0.7.24 tag 或用户指示
2. 待办：T3 真机耗电验证（需要实机，沙箱做不了）
3. ~~#866 / #929 / 轻量模式第一阶段~~ ✅ 已随 .288 完成（见上「三件套批次」）；~~tip 遗留两个契约修复提交~~ ✅ 已随 .289 发布；轻量模式 v2 候选扩展：列表虚拟化、更多特效降级
- **巡检（2026-10-31 11:15 +08）**：.289 已发（5ccf86af 发布提交 + tag，main 线 7ab60536/578efcd5 两笔移植）；上游 v0.7.24 仍未发 tag——无合并动作；main 线 QQ 批次缺口记录在 .289 条目内待用户拍板

## T5 实现备忘（2026-10-29 完成）

- 分流开关：`src/components/ponder/targets/basics/ponderOnboardingShared.ts` 的 `ONBOARDING_TOUCH`（模块级求值一次，`FINE_POINTER_QUERY` 取反；node 测试环境无 window → 桌面分支）
- 触屏分镜：`helpPage.target.ts`（overview/commandPalette）+ `ponderBasics.target.ts`（insidePonder/wholePage），各自导出 `TOUCH_SCENE_STEPS`
- 原则：触屏没有悬停/键盘，keypress 一律换成灯泡（touchBulb 锚点）或左下角命令面板按钮的演示；不硬凑等价物
- 新增 i18n 键 ×4（`overviewCtrlGTouch`/`overviewCommandPaletteTouch`/`hereTouch`/`wholePageTouch`，四个语言文件都有）
- 测试：`ponderRegistry.test.ts` 新增「触屏分镜与桌面分镜过同一道防线」（锚点/id/结果层/时间线编译 + 触屏禁止 keypress）
- ⚠️ 已踩坑：`TOUCH_SCENE_STEPS` 不能引用 `scene.steps`（模块求值时已被三元定格成桌面分支），必须用具名触屏常量

## sync-vi-to-en.cjs（重建版要点，两实例收敛为同一实现）

- 行级 tokenizer：顺序 = 注释/空行 → export → 闭行（容忍 `} as const;`/`},`/`]`）→ 对象开 → 数组开 → **数组项（先于叶子）** → 叶子（最宽松放最后）
- 旧版「括号未闭合(剩 1 层)」的死因：闭行没容忍 `} as const;`、数组项被宽松叶子规则吞掉
- 数组项按数组内位置编号（`#N`），不能用行号（两文件行号天然错位）
- 用法：无参=对齐+写回；`--check`=只校验（漂移退出 1）。en 有 vi 无的键 → en 原文占位插入 vi，待人工翻译
- 副不变式：in.ts ↔ zh-CN.ts ↔ en.ts 键同步（missingTranslation.test.ts 把关）
- 本文件所在 meta 分支与 `/home/z/my-project/scripts/` 各存一份

## 全量回归的可靠跑法（沙箱实测结论）

- 沙箱 3.9G RAM / cgroup 4G；tsc 峰值 2.7G+ 会 OOM（dmesg 可查 `Killed process ... tsc`）——跑 tsc 前先杀别的 node 大进程
- **nohup 后台跑长任务会被沙箱驱动在 ~5 分钟回收**（实测两例），且 stdout 接管道结果丢失
- **可靠做法：`--shard` 分片前台跑**，每片 ~3.5 分钟（在单命令 10 分钟时限内）：
  `npx vitest run -c vitest.config.ts --silent=true --exclude "test/unit/ytm/**" --exclude "test/unit/discordPresence.test.ts" --shard=1/3`（再 2/3、3/3）
- 全量基线：1052 文件 / 13018+ 用例；--silent 必须 =true 否则吃掉路径参数

## 会话恢复速查

```bash
# 凭证（丢了才执行；PAT 在 cron job 2908101 / 2909454 的载荷里）
printf 'https://SkyRoc-114:<PAT>@github.com\n' > /home/z/my-project/.gh-credentials
chmod 600 /home/z/my-project/.gh-credentials && cp /home/z/my-project/.gh-credentials ~/.git-credentials
git config --global credential.helper store && git config --global http.version HTTP/1.1

# 克隆（网络抖动时用 HTTP/1.1 + blobless；GnuTLS recv error 就重试）
git clone --filter=blob:none --single-branch --branch android-0.7.22 https://github.com/SkyRoc-114/folia-android.git /home/z/my-project/folia-android
cd /home/z/my-project/folia-android
git remote add upstream https://github.com/chthollyphile/folia-major.git
git fetch --filter=blob:none upstream

# 恢复接力文档与脚本
git fetch origin meta && git checkout origin/meta -- MERGE-STATE.md scripts/
mkdir -p /home/z/my-project/scripts && cp scripts/sync-vi-to-en.cjs /home/z/my-project/scripts/

# 依赖（必须官方源 + ignore-scripts）
npm install --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund

# 每批验收
npx tsc --noEmit && npx vitest run -c vitest.config.ts --silent=true --exclude "test/unit/ytm/**" --exclude "test/unit/discordPresence.test.ts"
# 改了 en.ts / zh-CN.ts 后：
node /home/z/my-project/scripts/sync-vi-to-en.cjs
```

## fork issue 角度（2026-10-29 从上游 34 个开放 issue 筛出；fork 自身 0 issue）

**Android 直接相关（建议优先）：**
- **#843** bravais 墙 180Hz 拖拽节奏抖动 → rAF 目标插值 + 像素吸附：触屏拖拽平滑度，Android 帧率/DPR 受限时更明显
- **#929** 歌词画布渲染倍率/MSAA 成一等设置：Android 壳刻意关 MSAA、限帧率省电，这个设置应带 Android 默认值
- **#866** M3U 跟源文件更新 / 本地文件夹自动重扫：Android 的 SAF/存储权限与桌面 inotify 不同，合并时要设计 Android 分支
- **#889** 平台判放不了的曲目直接接下一首：移动网络/后台场景更痛
- **#869** 在线音源进度上报系统媒体控制：SMTC 是 Windows 概念，Android 对应 MediaSession —— 检查 fork 的 MediaSession 是否同步在线音源进度，可作为 fork 自己的修复项

**合并时顺带（上游先做）：**
- **#834** Bravais 墙双击封面直接播放（触屏友好）、**#848** 海报歌词 ruby 注音、**#918** 歌手页无专辑单曲、**#867** 心动模式、**#840** 在线多类型搜索、**#919** 电视端（大屏/遥控器 UI，Android 系可借力）

**跟踪即可：**
- QR 登录失败系列（#925/#908/#883/#882/#873/#861/#826/#851，多为 needs-info；fork 已有自己的登录错误文案修复 7ae2ff05）
- #928 声卡切换只切 audio（HiFi Web 引擎路线留意）、#870 遥控窗口美化（桌面向）、#850 模组只读接口、#901 酷狗每日推荐

## 批次收尾清单（每批照抄）

1. cherry-pick / 改动 → 冲突按「fork 的 nativeBridge/android 增量优先，上游语义不丢」解
2. `node /home/z/my-project/scripts/sync-vi-to-en.cjs`（动了 en.ts / zh-CN.ts 时）
3. `npm install --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund`（动了依赖时）
4. `npx tsc --noEmit` 0 错 + 定向 vitest；大批次全量回归用 `--shard` 分片前台跑
5. 更新本文件 → push `android-0.7.22` → 本文件+scripts 提交推 `meta` 分支
6. 推 tag 前先查上次 workflow：`curl -H "Authorization: Bearer $PAT" .../actions/runs?per_page=2`，确认 success 再 `git tag v0.7.22-android.NNN && git push origin <tag>`
7. 勿用 android-actions/setup-android@v3（runner 预装 sdkmanager 冲突）

# HANDOFF — folia-android 长程任务交接文档

> 面向：下一个接手的 agent（人机协同/多实例接力）。写于 2026-11-06，随 .304 批次收尾。
> 本文件是交接的唯一入口；进度数字以仓库根 `PROGRESS.json` 为准（变量存储，勿信任何文档里的硬编码数字）。

## 1. 仓库身份与分支策略（2026-11-06 用户指令重构）

- **仓库**：`SkyRoc-114/folia-android`（Folia 音乐播放器 Android fork，Capacitor + React + TS + Vite）
- **main = 唯一长期分支**：所有提交最终落到 main，保持最新。default branch 已是 main。
- **agent-cowork = 协作工作分支**：进行中的工作（未验证完的批次、实验）先提交到 agent-cowork，验证通过后合回 main（fast-forward 或普通 merge，勿 force push main，除非用户明确指令）。
- **其他分支一律删除**（历史遗留的 android-0.7.22 已于 2026-11-06 删除）。发现新的过期分支直接删。
- **tag 独立于分支**：v0.7.22-android.NNN 系列指向历史提交，删分支不影响。
- 上游：桌面功能上游 `chthollyphile/folia-major`（tags v0.7.x）；Android 上游 `whycfawa/folia-android`（其 android-0.7.22 分支为本 fork 直接父本，书脊/phone-fit 行为以其为准）。

## 2. 多 agent 协作协议（与另一位 agent 协同工作时）

1. **动手前必做**：`git fetch origin && git log origin/main --oneline -3 && git ls-remote --tags origin`——核对 main tip 与最新 tag，勿重复发布、勿基于旧 tip。
2. **工作面划分**：长期/发布性提交直接在 main；探索性/进行中工作在 agent-cowork。两 agent 同时在场时，约定「一个批次同一时刻只有一个 owner」，通过远端 main tip + PROGRESS.json 的 `last_round.updated_by_round` 辨认对方进度。
3. **冲突裁决**：PROGRESS.json 与远端 tag 不一致时，以远端 tag 为准，用 `python3 scripts/update-progress.py set fork.latest_tag <tag>` 回写。
4. **推送**：git 通道常超时 → `git -c http.version=HTTP/1.1 push` 重试 → 仍不通走 `python3 scripts/api-push.py <sha>`（⚠️ API 通道重建提交 sha 会变，推完 `git fetch + git reset --hard origin/main` 对齐）。链式命令勿用管道吞退出码（`| tail` 后 `$?` 是 tail 的）。
5. **交接更新**：每轮收尾重写 `docs/handoff/HANDOFF.md` 第 6 节状态快照并重新打包 handoff.zip。

## 3. 环境恢复（沙箱每窗口快照回滚是常态）

```bash
# 仓库丢失/回退：depth-1 全量克隆整体替换
rm -rf /tmp/folia-fresh && git clone --depth 1 --branch main https://github.com/SkyRoc-114/folia-android.git /tmp/folia-fresh
cd /home/z/my-project && rm -rf folia-android.old && mv folia-android folia-android.old && cp -a /tmp/folia-fresh folia-android && rm -rf folia-android.old /tmp/folia-fresh
# 加深历史（迁移上游需要）
cd folia-android && git fetch --depth=400 origin main

# 依赖（⚠️ 必须官方源；沙箱默认 npmmirror 在 npm 11.19 触发 EALLOWREMOTE 全量拒装）
NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ npm install --ignore-scripts --no-audit --no-fund
# node_modules 残缺时（npm 增量误判"已满足"）：rm -rf node_modules 后重装

# 凭证（PAT 在 /home/z/my-project/.gh-credentials，沙箱外不入库；被清就重建）
cp /home/z/my-project/.gh-credentials ~/.git-credentials && chmod 600 ~/.git-credentials
git config --global credential.helper store && git config --global http.version HTTP/1.1
```

## 4. 验证基线（以 PROGRESS.json 的 baseline 字段为准，此处为快照）

| 项 | 命令 | 当前基线（.304） |
|---|---|---|
| tsc | `node --max-old-space-size=3072 node_modules/typescript/bin/tsc --noEmit --skipLibCheck` | 0 错（137 单次=瞬态，连两次才算真） |
| 全量回归 | `./node_modules/.bin/vitest run -c vitest.config.ts --silent=true --exclude "test/unit/ytm/**" --exclude "test/unit/discordPresence.test.ts" --shard=N/3`（再单跑 `test/unit/ytm/` 补口径） | 三片 14047 + ytm 358 = 14405 过 + 1 基线败（ytmProvider sign-in，存量勿修）+ 4 skip |
| build | `./node_modules/.bin/vite build` | 0 错，~246 precache entries |
| 渲染 | `NODE_PATH=/home/z/.npm-global/lib/node_modules node render-mobile-ui.mjs`（在 `/home/z/my-project/scripts/` 层跑；+ render-extra.mjs + render-offline-search.mjs） | 16 屏，整组替换 `docs/ui-preview/`，README 同步 |

⚠️ vitest 4 无 `--reporter=basic`；npx 会被 `/home/z/.npm-global` 陈旧 .vite-temp 污染，一律用 `./node_modules/.bin/`；ESM 不认 NODE_PATH，渲染脚本必须在 `/home/z/my-project/scripts/` 目录跑；跑 tsc/vitest 前杀 chromium/preview 进程（内存 4G 上限）。

## 5. 发布流程（每批照抄）

1. 上个 tag 的 workflow `conclusion=success` 后才发下一批（`curl -H "Authorization: Bearer $PAT" .../actions/runs?per_page=2`）。
2. **node 手工改 package.json 与 package-lock.json 两处 version** → `0.7.22-android.NNN`（勿用 npm version，会触发 4700 文件 chmod mode 噪音；两处都改，历史曾漏）。
3. `chore(release)` 提交（正文写内容+验证）→ `git tag v0.7.22-android.NNN` → push main + tag（重试+HTTP/1.1，不通走 api-push.py 再补 tag）。
4. workflow `Android pre-release` 由 tag push 触发，产 3 APK（armv7/armv8/universal）；APK 指纹门禁漂移 fail 属正常拦截。勿用 android-actions/setup-android@v3。
5. 渲染集入库：整组替换 `docs/ui-preview/` 删旧截图，README 清单同步。

## 6. 当前状态快照（2026-11-06，接手后请用 PROGRESS.json 核实最新）

- **最新批次 .304 已发布**（v0.7.22-android.304 = 00db0476 + codemap 自动提交 ceeccfdb）：安卓上游 11 提交迁移（启动图 WebP 瘦身 / QQ 禁止降级原生快速登录 / Android 客户端模组系统全家桶：FoliaModsPlugin+FoliaModsServer 原生宿主、复用桌面管理界面、net.fetch/storage 适配、分辨率保护三挡）。fork 侧适配：MainActivity 只注册 FoliaModsPlugin；androidModsBridge 拔 app store 依赖（folium services 闭包边界，门禁在 ModManager UI 层）；platformNamePlaces 注册表更新（52/149/664）。
- **上游增量（下批素材）**：whycfawa 的 55af65d9（模型导入 ZIP）及其前面的分析模型系列（AnalysisModelImporter/FoliaAnalysisModelsPlugin，fork 无此基础，需成系列评估，注意上游版本号已是 0.7.25-android.NNN 体系）；桌面 folia-major 仍 v0.7.25 无新 tag。
- **pending**：见 PROGRESS.json `pending` 数组（upstream-android-mods 已随 .304 完成，应 pending-done）。
- **分支重构刚完成**：main 唯一长期分支 + agent-cowork 协作分支；android-0.7.22 已删；全部 workflow 已挂 main（codemap-sync 自动提交已实证生效）。

## 7. 工具坑速查（血泪积累，持续追加）

- **Bash 输出层吞 `[m`**（当 ANSI 颜色码转义）：`[main]` 显示成 `ain]`——判断文件真实内容用 `od -c` / python 布尔输出 / `grep -c`，勿信含方括号的行内显示。
- **管道吞退出码**：`cmd | tail -1; echo $?` 得到的是 tail 的退出码；重试循环用 `if cmd; then` 或先落日志再 `echo EXIT=$?`。
- **输出层吞字面反引号**：排查时 cat -A 也显示损坏文本，grep -c 才可信。
- tsc OOM EXIT 137 单次瞬态；内存敏感验证前 `pkill -f chromium`。
- 后台 nohup 长任务会被沙箱 ~5 分钟回收：分片前台跑或 setsid + 检查点 push（每 10 提交推一次）。
- blob:none 部分克隆下 cherry-pick 懒拉 blob 极慢：`git config remote.<r>.partialclonefilter ""` 清 filter 后带 blob fetch。
- 迁移冲突模式库：version 三件套（package.json/package-lock.json/android/app/build.gradle）取 OURS；注册表类（platformNamePlaces.ts）按实际计数更新；上游批次日志（ANDROID_PORT.md 尾部）可并入（fork 自己的批次走 MERGE-STATE.md，不写 ANDROID_PORT.md）；新功能 Java 插件注册只保留 fork 没有的类（fork 架构=大一统 FoliaNativePlugin 41 PluginMethod）。
- i18n 四语言（en/in/vi/zh-CN）同步改，跑 `node scripts/sync-vi-to-en.cjs`（missingTranslation.test 把关）。
- PAT 绝不入被跟踪文件；.gh-credentials 权限 600。

## 8. 巡检/批次协议（cron job 每日 09:00 Asia/Shanghai）

- 开场：恢复环境 → `python3 scripts/update-progress.py show` → 读 MERGE-STATE.md 对应批次。
- 收尾（每轮必做，纯巡检也不例外）：`round --type inspection|batch|infra --result "<一句话>"`；批次另 `set fork.latest_tag/next_batch_number`、`history`、`pending-*` → 随批 push main。
- 详细批次记录写 MERGE-STATE.md；机器态快照在 PROGRESS.json；冲突以远端 tag 为准。

# 实施计划：签名稳定化 + 返回手势 + 透明开关（.293）——2026-11-01

设计见 `docs/plans/2026-11-01-android-signing-backgesture-design.md`。每任务=TDD：先测→红→实现→绿→提交。
沙箱约束：无 JDK（gradle/keytool 交 CI）；tsc 需 `pkill -f GradleDaemon; NODE_OPTIONS=--max-old-space-size=2560 npx tsc --noEmit -p tsconfig.json --skipLibCheck`；测试命令 `npx vitest run -c vitest.config.ts <file>`。

## Task 1 — 返回键派发目标（useNativeBackButton）
- 测试（新 `src/hooks/useNativeBackButton.test.ts`）：
  1. `nativeEscapeTarget`：activeElement 有 dispatchEvent → 返回它；
  2. activeElement 为 null / 无 dispatchEvent（如 window 伪对象）→ 返回 fallback（body）；
  3. `applyNativeBackPress`（既有）回归：handled=true 不退后台（已有语义防漂移）。
- 实现：`useNativeBackButton.ts` 抽出并导出 `nativeEscapeTarget(active: unknown, fallback: unknown): unknown`
  （鸭子判定 `typeof (active as {dispatchEvent?: unknown})?.dispatchEvent === 'function'`）；合成事件改派发到
  `nativeEscapeTarget(document.activeElement, document.body)`；`handled` 判定保持 `!dispatchEvent(...) || defaultPrevented`。
- 验证：新测试绿；`npx vitest run -c vitest.config.ts src/hooks/useNativeBackButton.test.ts`。
- 提交：`fix(android): 返回键合成 Escape 派发到焦点元素——document 层弹窗（全部 Sheet）收得到返回键`

## Task 2 — loginHostState.backOut（多页返回）
- 测试（新 `src/components/login/loginHostState.test.ts`，参照现有 host 测试摆 ports 假件；若无同类文件则自建最小假件）：
  1. opened 后未选 → backOut=false，closeWindow 未被调（由 Sheet 走关窗）；
  2. choose 平台后 → backOut=true，chosen 清空、ports.closeLogin 被调（登录停）、且**不**调 closeWindow；
  3. backOut 后再 choose 同平台 → 重新开一轮（turn 推进，晚到的旧回答不作数）；
  4. done（成功动画）中 → backOut=false（不拦，窗口由动画收尾）；
  5. 窗口未开 → backOut=false。
- 实现：`loginHostState.ts` 返回对象加 `backOut()`：
  `if (!open || state.done || !state.chosen) return false; turn += 1; ports.closeLogin(); set(NOTHING_CHOSEN); return true;`
- 验证：`npx vitest run -c vitest.config.ts src/components/login/loginHostState.test.ts` 绿。
- 提交：`feat(login): 登录窗口多页返回 backOut——二维码页退回平台列表而不是直接关窗`

## Task 3 — Sheet onEscape + 登录窗接线
- 实现：`Sheet.tsx` SheetProps 增 `onEscape?: () => boolean`（SheetFrame 透传，ref 保最新）；keydown 的
  `if (closes)` 内：`event.preventDefault(); if (!(onEscapeRef.current?.() ?? false)) requestCloseRef.current();`
- 接线：`LoginWindow.tsx` props 增 `onEscape?` 透传 Sheet；`LoginScreen.tsx` 增 prop 透传 LoginWindow；
  `LoginHost.tsx` 传 `onEscape={() => host.backOut()}`。
- 测试：Task 2 的 host 测试已覆盖决策；Sheet 增量 4 行走 tsc + 现有全量回归（组件无 DOM 测试基建，与仓库惯例一致）。
- 验证：tsc 0 错。
- 提交：`feat(ui): Sheet 支持 onEscape 分层消费——登录窗返回键先退页再关窗`

## Task 4 — 透明开关 Android 隐藏
- `IntegrationPage.tsx`：透明 Row 包进 `{isElectron && (...)}`（与 OBS 行同款式）。
- `settingsCommands.ts`：`createToggleCommand('settings-toggle-transparent', ..., { platform: ['electron'] })`。
- 验证：tsc 0 错；grep 确认无其它 UI 入口引用该 Row。
- 提交：`fix(android): 播放页透明背景入口按 Electron 门控——WebView 不透明，开关在安卓是死的`

## Task 5 — 签名稳定化（无 TS 影响，CI 验收）
- openssl 生成：`openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/folia.key -out /tmp/folia.crt
  -days 10950 -subj "/CN=folia-android"` → `openssl pkcs12 -export -in /tmp/folia.crt -inkey /tmp/folia.key
  -out android/app/folia-release.p12 -name folia -passout pass:<固定口令>`；
  证书指纹 `openssl x509 -in /tmp/folia.crt -noout -fingerprint -sha256` 记档（workflow 比对用）。
- `android/keystore.properties` 入库（storeType=PKCS12 / storeFile=folia-release.p12 / 别名 folia / 口令）；
  `keystore.properties.example` 更新 + 警告（公开签名材料、换库即断装）。
- `build.gradle`：读 `storeType`（可 null）；`buildTypes { debug { if (hasReleaseKeystore) signingConfig signingConfigs.release } }`。
- workflow：assembleDebug 后加验证步 `keytool -list -v -keystore android/app/folia-release.p12 -storetype PKCS12
  -storepass <口令> | grep <指纹前缀>`（fail fast）；注释更新（不再"每次 runner 生成"）。
- `ANDROID_PORT.md` 补「签名与覆盖安装」小节（含一次性卸载重装公告）。
- 验证：gradle 语法目检（本地无 JDK）；CI 构建即验收。
- 提交：`fix(android): 入库稳定签名 keystore——修复 CI 每版随机证书导致的无法覆盖升级`

## Task 6 — 全量验证与发版 .293
1. `npx vitest run -c vitest.config.ts` 全量（约 8-10 分钟），对照 .292 基线（13640 过 / 1 存量败 ytmProvider:813 / 3 skip）。
2. tsc 0 错。
3. `package.json` → `0.7.22-android.293`；MERGE-STATE.md 更新（本三修复+签名迁移公告+fork 侦察）。
4. 发版 commit `chore(release): v0.7.22-android.293`（release notes 草稿写在 commit 与 release body：首条=卸载重装一次性公告）。
5. push `android-0.7.22` + tag → CI success → release 三 APK。
6. **签名闭环验证**：下载 .293 armv8 APK → `scripts/apk_cert.py` 指纹 == openssl 记档指纹（与 .292 的 6656f…不同属预期）。
7. push `android-0.7.22:meta`。

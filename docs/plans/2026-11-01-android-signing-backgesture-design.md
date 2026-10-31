# Android 三 bug 修复设计（签名断签 / 返回手势 / 透明开关）——2026-11-01

用户报障（.292 实机截图）：①签名变了无法覆盖升级；②登录界面（含二维码多页）不响应边缘滑动返回与后退键；③播放页透明开关在安卓不可用应删除；④自查其它 bug、参考上游 fork。本文为 brainstorming 产出，证据先行。

## 1. 签名断签（无法升级）——结构性缺陷，非某次提交改错

**根因（已实证）**：`android-pre-release.yml` 构链用 `assembleDebug`，debug 签名取 runner 的
`~/.android/debug.keystore`；GitHub Actions runner 一次一命，该 keystore **每次构建随机新生成**。
下载 .282/.286/.288/.290/.291/.292 六个 armv8 APK 解 v2 签名块比对（scripts/apk_cert.py）：

| 版本 | 证书 SHA-256（前16位） |
| --- | --- |
| .282 | 646774d2e06d303c |
| .286 | ba804aa1254c19c0 |
| .288 | 9c8d9b5335478f53 |
| .290 | 17bac445b8addb2e |
| .291 | e932a65fc3d421f7 |
| .292 | 6656f3783a7443a5 |

六版六证——自 CI 化（.281）起任何两版之间都无法覆盖安装，与"某次改了签名"无关。

**取舍**：
- 方案 A（采用）：**提交稳定 keystore 进仓库**。`openssl` 生成 PKCS12（RSA-2048，10950 天，CN=folia-android），
  连同 `android/keystore.properties` 一起入库。代价=签名材料公开，第三方可用同签名伪装更新；本 fork
  无商店渠道、上游同等姿态（上游 workflow 注释自认"仓库里没有签名密钥"），可安装性优先于防伪，文档声明。
- 方案 B（弃）：GH Actions Secrets 注入。需要管理员密钥经 API 写 secret + sodium 加密链路，PAT 权限存疑，
  且本地无法复现同签名构建，断裂面更多。
- **老版本用户迁移**：旧证书随机生成不可恢复，只能一次性卸载重装；release notes 首条写明，此后不再发生。

**落点**：
- `android/app/folia-release.p12` + `android/keystore.properties`（storeType=PKCS12，别名 folia）入库；
  `keystore.properties.example` 更新并加"覆盖安装连续性"警告。
- `android/app/build.gradle`：signingConfig 透传可选 `storeType`；`buildTypes.debug` 在有 keystore.properties
  时也用 `signingConfigs.release`（assembleDebug 即稳定签名，workflow 零改动即可生效）。
- workflow 加"签名指纹验证"步：`keytool -list` 比对固定指纹，不一致 fail fast，防止再次漂移。
- `ANDROID_PORT.md` 补签名章节。

## 2. 返回键 / 边缘滑动不关闭登录窗——合成 Escape 派发目标错了

**链路（现状）**：系统返回（手势/按键）→ MainActivity OnBackPressedCallback → `FoliaNativePlugin.emitBackPressed()`
→ JS `useNativeBackButton`（App.tsx:1638 挂载）→ **在 `window` 上合成 Escape keydown** → 各层自行消费。

**根因**：`Sheet`（全部 18 个对话框的共用框：登录窗、设置弹窗、均衡器、主题快编、歌词时间线、Remote sheet
……）的 keydown 监听挂在 **`document`**；`window.dispatchEvent` 的 target=window，**传播路径不含 document**，
Sheet 永远收不到。凡 Sheet 即对返回键免疫——不止登录窗。`TemperaImageImportMenu` 同在 document 上监听，同病。

**修复（一处治全app）**：合成 Escape 派发到 `document.activeElement`（Sheet 打开时自动聚焦面板，正是真实
Escape 的 target），兜底 `document.body`。派发目标抽纯函数 `nativeEscapeTarget(active, fallback)` 可测；
window 捕获层（useExclusiveKeyLayer/PonderSessionKeys 等）与 window 冒泡层（SettingsModal、各 grid suite）
经捕获/冒泡两相照常可达。

**多页返回（登录窗二维码页→平台列表→关窗）**：
- `Sheet` 增可选 `onEscape?: () => boolean`：仅当本 sheet 是最顶层且 escapeCloses 放行时调用；
  返回 true=本次 Esc 已消费（如退回上一页），false=按原逻辑关窗。不破坏任何现有调用点（不传=原行为）。
- `loginHostState` 增 `backOut(): boolean`：`done` 动画中或未选平台→false（关窗）；已选平台→结束本轮
  （turn+=1、closeLogin 停登录、清回 NOTHING_CHOSEN）→true（留在平台列表页）。
- 接线 LoginHost→LoginScreen→LoginWindow→Sheet。边缘滑动=系统返回=同一路径，一并修复。

## 3. 播放页透明开关——Electron 专属能力，Android 隐藏

`transparentPlayerBackground` 驱动 Electron 透明窗口（OBS 浏览器源/抠像，App.tsx 1580 / handoff / bridge）。
Android WebView 合成器不透明，开关是死的。**不删底层代码**（保上游合并面），只藏入口：
- `IntegrationPage.tsx`：透明行并入 `isElectron` 门控（与同组 OBS 行一致）；
- 命令面板 `settings-toggle-transparent` 加 `platform: ['electron']`（availability.ts 现成机制）；
- store/迁移逻辑不动（存量值无害）。

## 4. Fork 侦察与其它巡检

- EasonLai96/folia-major（Capacitor 移植）：MainActivity 无返回键定制；hejunlin1755（pc-for-android）：
  CI 同样裸 assembleDebug → **同样断签**。签名/返回键两问题无现成借鉴，本仓为首发修复。
- 上游新增 scratchpad 批次（b54f3681 等）与本两 bug 无关，留下一轮迁移。
- 巡检中两处疑似坏代码（LoginHost deps、TAB_STOP_SELECTOR）经 od 逐字节核实为**显示伪影**，代码无误。

## 版本

`0.7.22-android.293`，tag `v0.7.22-android.293`；release notes 首条=卸载重装公告（一次性）。

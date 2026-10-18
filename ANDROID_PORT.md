# Folia for Android

Folia 的非官方 Android 移植版。工程完全内置。

## 当前结构

```text
Folia React/Vite 前端
  -> Capacitor Android WebView
  -> FoliaNativeBridge JavaScript 兼容层
  -> FoliaNative Capacitor 插件
  -> Android CookieManager / OkHttp
```

扩展中的 `api/folia.js`、网易云、QQ、酷狗适配代码已复制到：

```text
src/nativeBridge/api/
src/nativeBridge/vendor/
```

Android 启动时会在 `src/index.tsx` 安装原生桥，模拟浏览器扩展的 `chrome.cookies`、`chrome.storage`、网络请求和 `FOLIA_API_REQUEST` 消息协议。

## 构建环境

- Node.js 24
- JDK 21（Capacitor 8 的 source/target 级别是 21，必须用 JDK 21；工程里通过 `android/gradle.properties` 的 `org.gradle.java.home` 指定）
- Android Studio
- Android SDK 36.1
- Android Build Tools 36.x

本机已验证路径：

```text
JDK 21:      C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot
Android SDK: C:\Users\whycf\Android\Sdk
```

## 安装 JS 依赖

```powershell
npm install
```

## 构建网页产物

```powershell
$env:VITE_NETEASE_API_BASE='extension'
$env:VITE_QQ_API_BASE='extension'
$env:VITE_KUGOU_API_BASE='extension'
npm run build:capacitor
```

## 同步 Android 工程

```powershell
npx cap sync android
```

## 生成调试 APK

Windows：

```powershell
$env:ANDROID_HOME='C:\Users\whycf\Android\Sdk'
$env:ANDROID_SDK_ROOT='C:\Users\whycf\Android\Sdk'
$env:JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot'
cd android
.\gradlew.bat assembleDebug
```

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## 当前实现范围

- Android Capacitor 容器
- 内置桥消息协议
- Android CookieManager 兼容层
- OkHttp 网络请求兼容层
- 网易云、QQ、酷狗 API 代码内置
- QQ 收藏、专辑、歌单逻辑保留
- 后台播放前台服务
- 锁屏和通知栏 MediaSession 控制
- Android MediaStore 本地音乐扫描
- App 内本地 HTTP 音频流

### QQ 写入接口的形状（合并上游时务必保留）

红心 / 取消红心的写入（`music.musicasset.PlaylistDetailWrite` 的 `AddSonglist` / `DelSonglist`）
在 QQ 官方服务端只认**下面这个组合**，缺任何一半都会被业务码拒掉。这是 2026-10 用「形状矩阵
自检」在现场矩阵里逐项试出来的，两条历史弯路各对了一半：

| 形状 | 结果 |
| --- | --- |
| android comm + 设备身份 + QIMEI + `uid/sid` 会话，**不带 g_tk** | 业务码 `500026` |
| **g_tk**（放 query）+ 网页 comm（`ct:24, uin`） | 业务码 `80105` |
| **android comm + 设备身份 + QIMEI + `uid/sid` 会话 + g_tk** | `retCode=0`，关系真的改变 |

实现集中在 `src/nativeBridge/api/qq.js` 的 `qqMusicassetWriteCall`：
android comm（`buildQQRadioComm`）+ `buildQQRadioCookie` 重建的凭据 cookie + `QQ_MUSICU_UA` +
`qqMusicRequest(..., { gTk: qqGtk(cookieHeader) })`。
`qqGtk` 只吃 `skey` / `p_skey`（缺省 5381）—— 拿 `qm_keyst` 算会得到错误的 g_tk。

写入一律靠**再读关系确认**（`SongFavRead/IsSongFanByMid`），上游自报成功不算数。
QQ 的同一套形状也用于专辑订阅与歌单写入。

## 构建状态

- `npm run build:capacitor` 已通过
- `npx cap sync android` 已通过
- `gradlew assembleDebug` 已通过，产出 `android/app/build/outputs/apk/debug/app-debug.apk`
- APK 包名 `top.izuna.foliamajor`，当前版本 `0.7.20-android.196`（`versionCode` 234），minSdk 24，targetSdk 36

## 尚未完成

- 正式签名和应用商店配置

网易云 / QQ / 酷狗登录与曲库、AI 主题配置、后台播放前台服务、锁屏与通知栏媒体控制、
本地音乐（系统文件管理导入 + 设备音乐库扫描）均已接入，详细改动见提交历史。

## GitHub Actions

上游带过来的工作流大多是桌面版和自建服务的发布流程，跟 Android 版无关，已从本 fork 移除：

```text
.github/workflows/canary-pre-release.yml
.github/workflows/docker-stack-check.yml
.github/workflows/docker-stack-publish.yml
.github/workflows/electron-release.yml
.github/workflows/nightly-pre-release.yml
.github/workflows/release-candidate.yml
.github/workflows/sync-server-docker-publish.yml
```

其中 `nightly-pre-release.yml` 是定时任务（每天 UTC 02:00），会在本仓库里构建并发布会往
Releases 里塞桌面版夜间包，所以优先删掉。

保留的两个：

- `codemap-sync.yml`：push 到 `main` 后自动重生成并提交 `docs/CODEMAP.md`
- `pr-unit-tests.yml`：push 和 PR 时跑前端单元测试

以后从上游合并时，如果上游又改了这些被删掉的工作流，冲突解决方式就是继续保持删除状态。

### QQ 登录通道：网页扫码优先、原生安卓兜底

`.176` 曾把 `qq` 通道换成原生安卓扫码（CreateQRCode + Login）来修红心写入被拒。但后续现场证据表明原生通道的 `musickey` 只是设备/登录密钥：同一账号**免费歌 purl=true、VIP 歌每档音质都 qqCode=104003 且 purl 为空**（账号确有会员、也重登过）。VIP 播放权挂在网页会话的授权 cookie（`p_skey`/`skey` 等）上，所以 `.194` 起 `login_qr_key` 改回**网页 ptlogin2 优先**，原生通道仅作回退。写入时的 `g_tk` 会来自 `p_skey`/`skey`，红心/收藏需重新回归验证 —— 合并上游时不要把这顺序改回去。

### QQ 音乐登录：不采用上游的新登录实现（2026-10-18 决定）

上游 0.7.20 之后改过一次 QQ 音乐登录。本仓**不采纳**：

- 继续用**网页扫码（ptlogin2）优先**，原生安卓扫码仅作回退；**不引入 QQ 音乐 APP 扫码登录**。
- 合并上游时，src/nativeBridge/api/folia.js 里 `login_qr_key` 的 `qq` 分支、以及
  `src/nativeBridge/api/qq-native-login.js` / `qq-mqtt.js` 保持本仓实现，不要被上游覆盖。
- 原因：网页凭证带 `p_skey`/`skey` 等授权 cookie，VIP 播放权挂在上面（`.194` 实测：换回网页
  扫码后部分 VIP 歌恢复 `purl=true`）；APP 扫码凭证只够写红心，不能覆盖 VIP 播放。

## 0.7.21 重移植（A 方案）

上游 v0.7.21 把 `src/services/onlineMusic/` 拆成按平台子目录（`bodian/ kugou/ netease/ qq/`）、
播放层拆到 `components/app/playback/{bridges,start}/`，直接 merge 0.7.20 旧树会产生数百个类型错误。
因此改为**以 v0.7.21 为底重建移植**：分支 `android-0.7.21` 从 `upstream/main` 起步，逐组把本仓的
Android 改动贴到新结构上。

已完成（按顺序）：

1. 基建：`npm install` 同步依赖；从 main 搬入「我们新增、上游没有」的 594 个文件
   （`src/nativeBridge/**`、`android/**`、Capacitor 配置、我们的测试与工具）
2. 清理：删除上游已迁移/已删除的 0.7.20 旧副本（共约 360 个）；`tsc` 从 688 错降到 0
3. 入口与壳：`index.tsx` 接原生桥/崩溃诊断/chunk 恢复/帧耗时采样/手机布局/屏幕常亮；
   `package.json` 合并 capacitor 依赖与 Android 脚本
4. 渲染：`IS_ANDROID_WEBVIEW` 探测、30 FPS 档与安卓默认 30、Diorama 暂停切 demand + 关 MSAA、
   Latent 暂停停帧（按上游重写后的 rAF 循环改造）
5. 诊断：自研的 `buildDiagnosticReport` 全量恢复（上游没有这个文件）+ 帮助页「复制诊断数据」+
   取流/失败留痕接回 `omni.getAudioSource` 与 `logOnlineFailure`
6. 运行时：所有在线音源统一走原生流代理、物理返回键、通用设置里的 Android 四件套
7. 本地音乐：设备扫描/导入动作、原生回环音频播放、封面取色经原生桥，全部嫁接到新 library 结构

已知差异（与我们的 .196 相比）：

- QQ 在 0.7.21 新增的接口（`recommend_new_*`、`radio_*`、`song_similar`、`user_vip`、
  `user_playlist_create`、`login_refresh`）未在我们的原生桥里实现 —— 这些是上游新功能，
  .196 时代不存在；对应页面在安卓上暂不可用，其余 QQ 功能（登录/搜索/歌单/收藏/播放）已覆盖。
- 桌面专用能力（Electron、模组系统、桌面更新检查等）按本仓惯例继续删除。

构建：`npm run build:capacitor` → `npx cap sync android` → `android/gradlew.bat assembleDebug`。
版本号从 `0.7.21-android.197`（versionCode 235）起。
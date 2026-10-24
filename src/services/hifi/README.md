# HiFi 原生直通（mpv）

桌面版可选的第二套音频引擎。本地曲库和（可选的）Navidrome 歌曲交给 mpv 子进程，由 Electron 主进程经 JSON IPC 控制，按源文件的格式直接送到输出设备；在线歌曲和 Stage 推来的歌照旧走 `<audio>` + Web Audio。当前这首走哪套引擎记在 `usePlaybackStore` 的 `playbackRoute`（`'web' | 'hifi'`，不持久化，每次起播重新判）。网页版没有 `window.electron.hifi`，本目录的每个方法都回安全的默认值，不抛错。

跨进程的形状（引擎状态、载入请求、错误码、信号链路）都在 `src/types/hifi.ts`。主进程只回错误码，文案在渲染端按 `hifi.errors.<code>` 取。

## 结构

```text
src/components/hifi/useHifiPlaybackBridge.ts（App 里挂一次）
  -> src/services/hifi/hifiPlayback.ts（判路线、起播、接管、守卫）
       -> hifiEngine.ts ──window.electron.hifi（preload）──> electron/hifi/hifiIpc.cjs
                                                               -> mpvSession.cjs ──JSON IPC──> mpv 子进程
       <── hifi:state / hifi:clock / hifi:error 推送 ───────────────┘
mpv ──HTTP（Range）──> electron/hifi/sourceBridge.cjs（127.0.0.1，每个源一个随机令牌）
                        ├─ 本地文件：hifi:read ──> 渲染端 hifiSourceResponder.ts（File.slice）
                        └─ Navidrome：主进程 net.fetch 带凭据的 stream 地址
```

### 主进程 `electron/hifi/`

- `hifiErrors.cjs`：错误码表（和 `HifiErrorCode` 一致）、带码的 Error；把 mpv 的日志行和 `end-file` 归到错误码；给日志的说明去掉查询串。
- `mpvArgs.cjs`：启动参数和 `loadfile` 命令（纯函数）；设备名不合规时回落 `auto`。
- `mpvIpcClient.cjs`：JSON IPC 客户端，一行一个 JSON，按 `request_id` 配对回复、按 observe id 分发属性变化；Windows 命名管道的连接。
- `mpvRuntime.cjs`：找 mpv、探版本（最低 0.39.0）、判能不能做 DoP，结果是 `HifiRuntimeStatus`。
- `mpvRuntimeInstaller.cjs`：按清单下载 mpv，边下边算 sha256，核对后解压到 `userData/hifi-runtime/mpv/<version>/`，只留最新两个版本。
- `approvedMpvPath.cjs`：主进程从系统文件框拿到的手动 mpv 路径，单独存在 `userData/hifi-runtime/approved-mpv-path.json`。
- `sourceBridge.cjs`：只听 127.0.0.1 的来源桥（见下面“为什么要来源桥”）。
- `mpvSession.cjs`：会话状态机：按需拉起 mpv、载入、走带、无缝预载、时钟节流（约 4 Hz）、空闲 5 分钟退出、崩溃熔断；Linux 上从 `/proc/asound` 补 hw: 直连设备。
- `hifiIpc.cjs`：只认主窗口的调用、校验每个载荷，把状态推回主窗口，替来源桥向持有 File 的渲染进程要字节，开文件框批准手动路径。

下载用的清单在 `shared/mpvRuntimeManifest.json`。主进程的接线只在三处：`electron/main.cjs`（建 runtime、installer、bridge、session，`registerHifiIpc`；退出的每条路都 `killSync()`；主页面一去不回时 `stop()`）、`electron/preload.cjs`（`window.electron.hifi`，类型在 `src/vite-env.d.ts`）、`electron/debug/crashLog.cjs`（`installCrashHandlers` 的 `beforeExit`，崩溃退出前杀掉 mpv）。

### 契约和设置

- `src/types/hifi.ts`：跨进程契约。
- `src/stores/useHifiSettingsStore.ts`：`folia_hifi_*` 设置键（默认：关、设备 `auto`、独占开、DSD 转 PCM、Navidrome 也走 HiFi、软件音量关）；`selectHifiEngineConfig` 拼出推给主进程的 `HifiEngineConfig`。主进程不读这些键。
- `src/stores/usePlaybackStore.ts`：`playbackRoute` 和 `setPlaybackRoute`。

### 渲染端服务 `src/services/hifi/`

- `hifiEligibility.ts`：一首歌走哪套引擎（`playbackKindOfSong`、`resolvePlaybackRoute`）。
- `hifiEngine.ts`：包住 `window.electron.hifi` 的客户端单例，写 `useHifiEngineStore`，分发时钟、错误和状态，记本次会话回落过的歌。
- `hifiEngineRules.ts`：客户端的对外形状和纯规则（取消的载入、说明 mpv 不能用的错误码、两份配置算不算一样）。
- `hifiEngineStore.ts`：`useHifiEngineStore`：支不支持、运行时、引擎状态、安装进度、设备、最近的错误、熔断。
- `hifiPlayback.ts`：数据流入口：`hifiRouteFor`、`beginHifiTrack`（起播，或接管窗口重建前还在放的那首）、`installHifiPlayback`；相邻文件的对外函数经它导出。
- `hifiTrackStore.ts`：当前曲目、载入到哪一步、源格式，和外推的播放时钟（`getHifiPosition`）。
- `hifiTrackLoad.ts`：拼载入请求、刚离开 Web 引擎时 `DEVICE_BUSY` 的重试、停着的恢复先不载入、被换下的曲目何时撤文件。
- `hifiTrackDriver.ts`：主进程推来的状态和时钟 → 播放时钟和 shim，只认当前曲目。
- `hifiRouteGuard.ts`：离开 HiFi 路线的唯一出口；也管上一个窗口留下、这个窗口没接管的那一首。
- `hifiTransport.ts`：播放、暂停、跳转：发 IPC，先把 shim 和时钟改成预期的样子。
- `hifiGapless.ts`：无缝接播：`loadfile append` 预载下一首、下一首变了就撤、mpv 接上时换成当前曲目。
- `hifiClock.ts`：按 `performance.now()` 外推 mpv 约 4 Hz 推来的位置。
- `hifiMediaShim.ts`：给 Media Session、听歌上报、scrobble 这些只读观察者一个像 `<audio>` 的对象；`getObservedMedia()` 在 HiFi 路线上返回它。
- `hifiSourceResponder.ts`：`sourceKey` → `File`，按来源桥的请求切片回送。
- `sourceSpec.ts`：源文件本身的格式：本地读文件头（music-metadata），Navidrome 用 Subsonic 返回的字段。
- `signalPath.ts`：源 → 传输 → 解码 → 处理 → 输出逐级比对，判断是不是原生直通。

### React 一侧 `src/components/hifi/`

- `useHifiPlaybackBridge.ts`：装上推送驱动，把设置和循环推给主进程，载入好了自动播放，引擎状态写回播放 store，放完换下一首（队尾停掉 mpv），失败或关掉 HiFi 时让这首在 Web 引擎上接着放。
- `hifiRouteTransport.ts`：传输控制用的 `resumeHifiPlayback` / `seekHifiRoute`，播放意图、队尾重放，以及把这首挪去 Web 引擎。
- `useHifiGaplessPreload.ts`：按队列、循环和私人 FM 算出下一首，当前这首就绪满 2 秒后交给 `hifiGapless` 预载。
- `useHifiAutomixGate.ts`：当前或下一首走 HiFi 时关掉智能过渡。
- `useWebEngineYield.ts`：切到 HiFi 的那一下停掉过渡、卸下两个 deck、挂起 AudioContext；切回 Web 时恢复它。
- `useHifiMediaSessionKeepAlive.ts`：共享输出时循环放一段静音，让系统媒体控制一直在。
- `useHifiSignalPath.ts`：播放界面读信号链路的 hook，另有 `useIsHifiRoute`。
- `hifiSignalText.ts`：徽标和面板上的文字。
- `HifiBadge.tsx`：播放胶囊进度条旁的小牌子（`HifiProgressRow`），点一下打开链路面板。
- `HifiSignalPathPanel.tsx`：信号链路面板，在 `src/components/app/overlays/AppOverlays.tsx` 挂一次；开关在 `hifiPanelStore.ts`。
- `HifiBypassNotice.tsx`：音频效果器窗口顶上的“HiFi 绕过了均衡器和音效”。

### 设置页

`src/components/modal/settings/pages/HifiPage.tsx` 只做组装，每组一个文件在 `pages/hifi/`：`HifiEngineGroup.tsx`（开关、mpv 状态、下载 / 更新、手动路径、重新检测、Linux 的包管理器提示）、`HifiOutputGroup.tsx`（输出设备、独占模式）、`HifiDsdGroup.tsx`（转 PCM 或 DoP）、`HifiScopeGroup.tsx`（Navidrome 走不走 HiFi）、`HifiVolumeGroup.tsx`（软件音量）、`HifiLimitsGroup.tsx`（已知限制）。`options.ts` 声明组和选项，组 id 就是锚点（`hifiEngine`、`hifiOutput`、`hifiDsd`、`hifiScope`、`hifiVolume`、`hifiLimits`）；`runtimeState.ts` 是设置页和命令面板共用的运行时判断。分区 `hifi` 在 `music` 组里 `playback` 之后，只在桌面版出现（`settingsNavModel.ts`）。

### 命令

`src/components/command-palette/commands/hifiCommands.ts`：`hifi-toggle`、`hifi-settings`、`hifi-exclusive-toggle`、`hifi-navidrome-toggle`、`hifi-software-volume-toggle`、`hifi-redetect-mpv`、`hifi-download-mpv`、`hifi-signal-path`（只在 HiFi 路线上可用）。DoP 故意没有命令：不支持 DoP 的 DAC 会放出噪声，这个选择只在设置页的警示旁边做。音量命令在 HiFi 固定音量时只提示“音量由你的 DAC 或功放控制”（`surfaces/volumeSurface.ts` 的 `isHifiVolumeFixed`）。

### 目录外接线点

| 位置 | 做什么 |
| --- | --- |
| `src/App.tsx` | 挂 `useHifiPlaybackBridge`、`useWebEngineYield`、`useHifiMediaSessionKeepAlive`；`useHifiAutomixGate` 进 automix 的 `isEnabled`；跳转拦截先走 `seekHifiRoute`；HiFi 路线上 deck 不给 src，deck 的事件处理直接返回 |
| `src/components/app/playback/start/useLibraryPlaybackController.ts` | 本地 / Navidrome 起播：读文件前先 `hifiRouteFor`，HiFi 不做 blob URL，改调 `beginHifiTrack` |
| `src/components/app/playback/source/songAudioSource.ts` | `loadLocalSongHifiSource`；Navidrome 用 `getStreamUrl(config, id, 'raw')` |
| `src/components/app/playback/restore/*` | 恢复和窗口交接的 HiFi 分支（`adoptRunning`、延后载入、`releaseUnclaimedHifiTrack`、交接时的位置取 `getHifiPosition()`） |
| `src/components/app/playback/useStagePlaybackController.ts` | Stage 快照记下路线，回来时重新按 HiFi 起播 |
| `src/components/app/playback/bridges/` | 传输控制、空格键、遥控跳转的 HiFi 分支；`usePlaybackVisualizerBridge.ts` 在 HiFi 上按 `getHifiPosition()` 走时钟，频谱停在待机动画 |
| `useMediaSessionBridge`、`usePlaybackReporter`、`useNavidromeScrobbleReporter`、`useRecentPlaysRecorder`、`useObsBrowserSourcePublisher`、`useElectronPlaybackBridge` | 读 `getObservedMedia()`，路线变了重新绑定 |
| `src/components/FloatingPlayerControls.tsx`、`src/components/panelTab/`（`controls/SoundTiles.tsx`、`controls/VolumeRow.tsx`、`AudioEqualizerDialog.tsx`、`ReplayGainControl.tsx`） | 进度条旁的徽标；链路入口代替智能过渡和均衡器两格；音量行停用；绕过说明 |
| `src/hooks/useElectronVideoExportController.ts` | HiFi 路线上拒绝导出视频 |
| `src/library/app/createLibraryAccountPort.ts` | 切换资料库平台时 `leaveHifiRoute()` |

## 为什么用 mpv

- 有先例：Feishin（Electron 的 Navidrome / Jellyfin 客户端）在主进程里起 mpv、走 IPC 控制；Supersonic（Subsonic / Jellyfin 桌面客户端）用 libmpv；Jellyfin Media Player 内嵌 mpv。拿 mpv 当桌面音乐后端是走过的路。
- 独占输出是现成的：WASAPI 独占、Core Audio 独占（hog 模式）、ALSA hw: 直连都只是 `--audio-device` 和 `--audio-exclusive`。不设 `--audio-samplerate` / `--audio-format`，mpv 就按源的格式开输出。
- 格式它自己解：FLAC、ALAC、DSD（DSF / DFF）等都由 mpv 解码，HiFi 路线不去找浏览器能放的副本。
- 链路看得见：`audio-params`（解码出的格式）、`audio-out-params`（送进设备的格式）、`current-ao`（实际用的输出驱动）、`audio-device-list`（设备）、`track-list`（编码名和 demux 采样率，用来认 DSD）这五个属性够判断每一级，`signalPath.ts` 拿它们和源格式逐级比，不靠猜。`request_log_messages warn` 收到的日志行再把失败归到错误码（`hifiErrors.cjs`：`AUDCLNT_E_DEVICE_IN_USE`、ALSA 的 busy、hog mode → `DEVICE_BUSY`）。
- 子进程 + JSON IPC：不用给 Electron 编原生模块；mpv 崩了不带走应用。Unix 上 IPC 是 fd 3 上的 socketpair（`--input-ipc-client=fd://3`），连接一断 mpv 就退出，不留孤儿进程；Windows 用随机名字的命名管道 `\\.\pipe\folia-hifi-<hex>`。

启动参数（`mpvArgs.cjs`）先关掉一切会碰声音和界面的东西：`--no-config`（不读用户的 mpv.conf）、`--af=`、`--replaygain=no`、`--audio-pitch-correction=no`、`--audio-normalize-downmix=no`、`--volume=100 --volume-max=100`。`--audio-fallback-to-null=no`：设备开不了就报错，不悄悄放进空输出。`--gapless-audio=weak`：下一首格式变了就按新格式重开输出；`yes` 会把后面的歌都重采样成第一首的格式。源从不上命令行，只经 IPC 的 `loadfile` 下发。

## 为什么要来源桥（127.0.0.1）

- 本地曲库经 File System Access 读（`src/services/localMusicService.ts` 的 `showDirectoryPicker`、`getFile()`），拿到的 `File` 在渲染端没有磁盘路径：`window.electron.webUtils.getPathForFile(file)` 对它返回 `''`，OPFS 里的文件本来就没有路径。mpv 也读不了 `blob:` 地址。
- 所以本地文件按块走：mpv 请求 `http://127.0.0.1:<port>/<token>/<文件名>` → `sourceBridge.cjs` 发 `hifi:read` 给持有这个 File 的渲染进程 → `hifiSourceResponder.ts` 用 `file.slice()` 读出那一段回送（每块最多 1 MiB，按背压写）。不往磁盘写临时副本。
- Navidrome 的 stream 地址（`format=raw`，原文件不转码）查询串里带着 `u` / `t` / `s`（或 `p` / `apiKey`）。主进程用 `net.fetch` 取它再转给 mpv：mpv 的参数、`loadfile` 和日志里只有 127.0.0.1 的令牌地址；桥的日志只写服务器的 host，报错先去掉凭据。服务器回 JSON / XML / HTML（Subsonic 的错误体、登录页）时报 `SOURCE_REJECTED`，不让 mpv 当音频去解。
- 只听 127.0.0.1、随机端口；每个源一个 128 位随机令牌，换下的曲目撤掉令牌；只认 GET / HEAD 和单段 Range。URL 里的文件名只帮 mpv 认格式，路由只看令牌。
- 窗口重建时新页面还没把 File 登记回来：桥收到 `unknown-source` 每 250 ms 再问一次，最多 8 秒。

## 哪些歌走 HiFi

`hifiEligibility.ts` 的 `resolvePlaybackRoute`，起播时（读文件之前）判一次：

1. 下面任一条不满足就走 Web：桌面版有 `window.electron.hifi`；设置里开了 HiFi；找到了可用的 mpv；本次会话没有熔断；这首歌本次会话没回落过。
2. 本地曲库的歌走 HiFi。
3. Navidrome 的歌在「Navidrome 歌曲」开着时走 HiFi（默认开）。
4. 在线歌曲和 Stage 推来的歌一律走 Web。

- **按歌回落**：载入失败或放到一半报致命错误时，提示 `hifi.errors.<code>`，`markSongForcedWeb` 记下这首本次会话走 Web，再让它在 Web 引擎上从原来的位置、按原来的播停接着放。只记在渲染端的内存里，重启应用、窗口重建后就清掉。被更新的载入顶替、被 stop 取消的载入（`superseded`、`stopped`）不算失败。刚从有源的 Web 路线换过来的 6 秒内报 `DEVICE_BUSY`（AudioContext 挂起后系统要过一会儿才关掉那条流），先隔 1.5 秒重试，最多三次。
- **会话熔断**：60 秒内 mpv 出事三次（进程退出、IPC 断开、命令超时、拉不起来）时主进程打开熔断，这次会话剩下的时间里载入都回 `CIRCUIT_OPEN`，只提示一次，所有歌走 Web。重启应用才恢复。
- `MPV_NOT_FOUND`、`MPV_SPAWN_FAILED`、`MPV_TOO_OLD` 会顺带刷新运行时状态，之后的歌直接判 Web。
- **进出路线**：切到 HiFi 时 `useWebEngineYield` 让 Web 引擎让位（Windows 上 Chromium 在同一设备上的共享流会挡住 WASAPI 独占）。离开只经 `hifiRouteGuard.ts`：Web 引擎拿到源、Stage 接管、或别处把路线改回 web 时，在 zustand 的 setState 里同步停掉 mpv，早于 React 渲染和 `<audio>` 换源，独占的设备先放开。放着时关掉 HiFi（或放着 Navidrome 歌时关掉「Navidrome 歌曲」），这首当场挪去 Web 引擎接着放，不算回落，再打开时照样走 mpv。
- 队尾放完时 `hifiEngine.stop()`，设备当场放开；mpv 进程空闲 5 分钟后自己退出。

## 恢复和窗口重建

- mpv 住在主进程那边，窗口重建（例如开关「播放页透明背景」）时接着放。新页面恢复时 `beginHifiTrack({ adoptRunning: true })` 先问 `getSnapshot()`：同一首（songKey 相同、mpv 在放或暂停着它）就接管：File 登记回原来的 `localSourceKey`，时钟按快照摆好，不重新载入。恢复落空时 `releaseUnclaimedHifiTrack` 停掉上一个窗口留下的那一首。
- 主页面一去不回（窗口关了、渲染进程没了又不重载）时主进程停掉 mpv，和 Web 引擎随页面停下一样。
- 冷启动恢复出来的暂停曲目先不载入（`loadState: 'deferred'`），按下播放才交给 mpv，启动时不占设备。

## HiFi 绕过了什么

| 功能 | 为什么 | 界面上 |
| --- | --- | --- |
| 智能过渡（automix / 交叉淡入淡出） | 要两个 `<audio>` deck 同时出声，mpv 不在这两个 deck 里 | 当前或下一首走 HiFi 时关掉（`useHifiAutomixGate.ts`） |
| 均衡器、音效、ReplayGain、淡入淡出 | 都是 deck 上的 Web Audio 节点；mpv 用 `--af=`、`--replaygain=no`，样本不经任何处理 | 设置保留给 Web 引擎；效果器窗口显示绕过说明，ReplayGain 显示“HiFi 下已绕过” |
| 频谱 | mpv 的输出上没有分析器 | 频谱停在待机动画 |
| 歌词视频导出 | 录制从 deck 的 `captureStream()` 取声音 | HiFi 路线上拒绝导出（`hifi.videoExportUnavailable`） |
| 应用音量 | mpv 固定 100%，响度由 DAC / 功放调 | 第一次开 HiFi 时确认；音量行停用。开「软件音量」后 mpv 跟随应用音量（下发立方根 × 100，和 mpv 的三次方曲线抵消），这一路不再原生直通。静音总是下发给 mpv 的 `mute`，不静音时不碰样本 |

## 各平台的原生直通条件

`signalPath.ts` 的判定：原生直通（bit-perfect）、经 DoP 原生输出 DSD（dop）、途中经过转换（converted）、经过系统混音器（shared-mixer）、尚未确认（unknown，mpv 还没报 `audio-out-params`）。

| 系统 | 原生直通要的输出 | 经过系统混音器的情况 |
| --- | --- | --- |
| Windows | WASAPI 独占：「独占模式」开着 | 独占关着（WASAPI 共享模式） |
| macOS | Core Audio 独占（hog 模式）：「独占模式」开着，mpv 改用 `coreaudio_exclusive`，按源格式切换设备的采样率 | 独占关着 |
| Linux | 只有 ALSA 的 hw: 直连设备（设置里标「直连」） | PipeWire、PulseAudio、JACK 不论独占开关都混音；`plughw` 会在 mpv 背后转格式，不算直连 |

除此之外每一级都要原样：

- 解码出的采样率、声道数和送进设备的一样；不一样就是重采样或声道转换（设备收不下源的格式时 mpv 会换成它收得下的）。
- 采样格式一样，或者只是整数低位补零（s16 → s24 / s32、s24 → s32）。mpv 把 24 位 FLAC 解成 s32，仍算直通。
- 软件音量关着。

Linux 的 hw: 设备 mpv 的 `audio-device-list` 里没有（它都滤掉了），`mpvSession.cjs` 从 `/proc/asound/cards` 和 `/proc/asound/pcm` 补上；mpv 一个 `alsa/` 设备都没列（没编 ALSA 输出）时不补。用 hw: 直连时别的程序用不了这块声卡；PipeWire 正在这块声卡上放音时它是被占的（`DEVICE_BUSY`），要选 PipeWire 没在用的声卡，或把它的配置文件设为关。

DSD：默认转 PCM，mpv 把 DSD 解成 PCM（DSD64 → 352.8 kHz 浮点），判“途中经过转换”。DoP（`--audio-spdif=dsd`）只在 Windows 的 WASAPI 独占下有，而且要比 0.41.0 新的 mpv（`mpvRuntime.cjs` 的 `isDopCapable`）。应用下载的官方 0.41.0 构建报的是 `0.41.0-dev-g…`，按 0.41.0 算，不能做 DoP；要用 DoP 得手动选一个更新的构建。DoP 帧的采样率是 DSD 位速率的 1/16（DSD64 → 176.4 kHz，DSD128 → 352.8 kHz），整数 24 / 32 位。不支持 DoP 的 DAC 收到 DoP 放出的是沙沙的噪声。

没有 ASIO：mpv 没有 ASIO 输出。Windows 上 WASAPI 独占能做到同样的原生直通。

## mpv 从哪来

`mpvRuntime.cjs` 的 `detect` 按这个顺序找，每个候选跑一次 `mpv --version`，比 0.39.0 旧的跳过（`--media-controls` 是 0.39.0 才有的；只找到旧的时报 `MPV_TOO_OLD`）：

1. **手动路径**：只认主进程自己从系统文件框（`hifi:pick-runtime-path`）拿到的那个，存在 `approvedMpvPath.cjs` 那份文件里。渲染端经 `hifi:configure` 只能用它或清掉它，不能另报一个程序给主进程运行；通用的 save-settings 写不到它。路径不存在、不是 mpv 或太旧时 `manualPathRejected`，接着找下面的。
2. **下载的运行时**：`mpvRuntimeInstaller.cjs` 按 `shared/mpvRuntimeManifest.json` 下载 mpv-player/mpv 官方 GitHub release 的资产（现在推荐 0.41.0，有 win32-x64、win32-arm64、darwin-arm64、darwin-x64），版本、字节数和 sha256 都钉在清单里，核对不上就删掉、报 `INSTALL_CHECKSUM_MISMATCH`。检测只认清单列出的版本目录，新的在前。macOS 的构建写着最低系统版本（`minOsVersion`），系统更旧时不提供下载。Linux 没有下载，报 `UNSUPPORTED_PLATFORM`，设置页给包管理器的安装命令；部分长期支持版的发行版仓库里 mpv 比 0.39 旧。
3. **系统的 mpv**：环境变量 `FOLIA_MPV_PATH`、`PATH`，再是常见位置（Homebrew、`/Applications/mpv.app`、scoop、Chocolatey、`%ProgramFiles%\mpv`、`/usr/bin`、`/usr/local/bin`、`/snap/bin`）。

## 已知限制

- **系统媒体控制只在共享输出时有**：mpv 发声时页面里没有在放的媒体元素，Chromium 就不登记媒体会话。`useHifiMediaSessionKeepAlive.ts` 在 HiFi 放着时循环一段音量为 0 的 6 秒静音，让 Linux 的 MPRIS、Windows 的 SMTC、macOS 的「正在播放」一直在。独占输出（Windows / macOS 开着独占，或 Linux 选了 hw: 设备）时不放：页面里多开一路流会和 mpv 抢设备，系统媒体控制和媒体键这时没有。只在 Linux 的 MPRIS 上实测过。
- 不能导出歌词视频，没有频谱（见上表）。
- **设备被占**：别的程序占着输出设备（独占时尤其）时载入报 `DEVICE_BUSY`，这首回落 Web 引擎。Linux 上 PipeWire 正在用的声卡的 hw: 设备也算被占。
- 没有 ASIO；DoP 只在 Windows，要比 0.41.0 新的 mpv。
- 格式变化处的无缝接播会有一下输出重开（`--gapless-audio=weak`）；同格式的两首才严丝合缝。
- 只有本地曲库和 Navidrome；在线歌曲不走 HiFi。

## 测试

单元测试（Vitest，默认 node 环境，用到 DOM 的文件第一行写 `// @vitest-environment jsdom`）：

```bash
npx vitest run -c vitest.config.ts test/unit/hifi test/unit/electron/hifi test/unit/electron/ipcSecurity test/unit/settings/hifi test/unit/command-palette/hifi
```

Node 25 上前面要加 `NODE_OPTIONS=--no-experimental-webstorage`，不然 localStorage 相关的测试报错一片。

- `test/unit/electron/hifi*.test.ts`：主进程每个模块一份，用 `createRequire` 载入、注入假的 spawn / net / fs / 定时器，不起 Electron、不要真 mpv。`hifiMainWiring.test.ts` 从 `main.cjs` 源码里核对接线；`ipcSecurity.test.ts` 核对手动 mpv 路径只能经文件框批准。
- `test/unit/hifi/*.test.ts`：渲染端服务和 React 一侧：路线判定、时钟、shim、载入与回落、无缝接播、信号链路判定和文字、徽标和面板、保活、Web 引擎让位、设置 store。
- 播放链路里的 HiFi 分支在 `test/unit/playback/`（如 `currentSongRestoreRoutes.test.ts`、`playbackTransportController.test.ts`、`playbackInteractionHifi.test.ts`、`stageHifiSnapshot.test.ts`）；`test/unit/stores/storeContract.test.ts` 钉着 `folia_hifi_*` 键。

`test/manual/hifiMpvSmoke.mjs` 用真的 mpv 跑主进程那几块（`mpvSession.cjs`、`sourceBridge.cjs`、`mpvIpcClient.cjs`），不起 Electron：渲染端换成从磁盘读字节的假实现，输出用 `--ao=null`，不出声也不占设备。它走一遍载入、时钟节流、跳转、暂停继续、stop、无缝换曲、预载项的撤和顶替、放到底、源读不出、源中途断掉和 `killSync`，每步打 PASS / FAIL，全部通过时退出码 0。两首采样率不同才看得出换曲时输出按新格式重开：

```bash
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=4" -ac 2 -sample_fmt s16 a44.flac
ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=96000:duration=6" -ac 2 -sample_fmt s32 -bits_per_raw_sample 24 b96.flac
node test/manual/hifiMpvSmoke.mjs a44.flac b96.flac --mpv /usr/bin/mpv
```

`--mpv` 默认 `/usr/bin/mpv`，Windows、macOS 上传实际路径；第二首也可以是 DSD64 的 `.dsf`。

## 手动测试矩阵

单元测试和 smoke 都不碰真的输出设备，下面这些要在真机上过。看结果的地方：播放胶囊上的徽标和点开的信号链路面板；「设置 → 开发者」的运行日志（主进程每次载入成功记一行 `[HiFi] loaded local <trackKey> -> <ao> <采样率> Hz <格式> <声道>`）；DAC 自己的采样率显示。除特别写明外，软件音量关着。

| 系统 | 场景 | 怎么做 | 应该看到 |
| --- | --- | --- | --- |
| Windows | WASAPI 独占 44.1 kHz | 输出设备选 DAC，独占开，放 44.1 kHz / 16 bit FLAC | 判原生直通；日志 `-> wasapi 44100 Hz s16`；DAC 显示 44.1 kHz；放着时别的程序出不了声；队尾放完后设备放开 |
| Windows | WASAPI 独占 96 kHz | 同上，放 96 kHz / 24 bit FLAC | 判原生直通，输出 96000 Hz s32；DAC 切到 96 kHz |
| Windows | WASAPI 独占 192 kHz | 同上，放 192 kHz / 24 bit FLAC | DAC 支持时同上、切到 192 kHz；不支持时判途中经过转换，面板写明重采样 |
| Windows | DoP DSD64 | 手动选一个比 0.41.0 新的 mpv（引擎组显示能做 DoP），DSD 选 DoP，独占开；接支持 DoP 的 DAC，放 DSD64 `.dsf` | 判经 DoP 原生输出 DSD；输出 176400 Hz、24 / 32 位整数；DAC 亮 DSD 指示 |
| Windows | DoP DSD128 | 同上，放 DSD128 | 输出 352800 Hz；DAC 显示 DSD128 |
| Windows | 设备被占 | 先让别的程序以 WASAPI 独占占住这块 DAC，再放一首本地歌 | 提示设备被占（`hifi.errors.DEVICE_BUSY`）；这首在 Web 引擎上接着放，没有徽标；别的歌照样先试 HiFi |
| macOS | hog 模式切采样率 | 独占开，依次放 44.1 kHz 和 96 kHz 的歌 | 日志里的输出驱动是 `coreaudio_exclusive`，判原生直通；「音频 MIDI 设置」里设备格式跟着切到 44.1 / 96 kHz；放着时别的程序没有声音 |
| Linux | hw: 直连 | 输出设备选标「直连」的 hw: 设备（PipeWire 没在用的声卡，如配置文件设为关的 USB DAC），放 96 kHz / 24 bit | 日志 `-> alsa 96000 Hz`，判原生直通；`/proc/asound/card<N>/pcm<D>p/sub0/hw_params` 显示 `rate: 96000` |
| Linux | PipeWire 占着声卡 | 选 PipeWire 正在放音的那块声卡的 hw: 设备 | 提示设备被占，这首回落 Web 引擎；换回默认设备（pipewire）判经过系统混音器 |
| 任意 | 窗口重建接管 | HiFi 放着时开关「播放页透明背景」 | mpv 进程号不变，主进程日志没有新的 `loaded` 行；渲染端日志 `[HiFi] adopted the track mpv is still playing`；位置、歌词接着走，和 mpv 对得上 |
| 任意 | 无缝 44.1 → 96 | 队列里连着两首本地歌（44.1 kHz / 16 bit，然后 96 kHz / 24 bit），第一首放满 2 秒后拖到快结尾 | 渲染端 `[HiFi] queued the next song for a gapless switch`、主进程 `[HiFi] gapless switch to …`；两首之间没有一次 ended；输出按 96 kHz 重开（weak 无缝在这里有一下重开），徽标换成 96 kHz |

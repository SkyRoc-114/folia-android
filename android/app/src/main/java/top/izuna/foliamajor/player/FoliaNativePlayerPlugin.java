package top.izuna.foliamajor.player;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import androidx.media3.common.Player;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import top.izuna.foliamajor.audio.FoliaDspSettings;
import top.izuna.foliamajor.audio.NativeAudioSpectrumTap;

/**
 * 原生播放内核的 Capacitor 桥。
 *
 * Web 侧只在「原生播放」打开、且这个插件真的在（`Capacitor.isPluginAvailable`）时才走原生；
 * 否则一切都还是 WebView 的 `<audio>`。也就是说这一层默认完全不参与播放。
 *
 * <p>位置是**推**的，不是**拉**的：引擎每 250ms 采一次位置，插件攒够两拍（约 500ms）才往
 * WebView 发一次 `foliaNativePlayer` 事件，Web 侧按本地墙钟插值。别改成 Web 侧定时调
 * getSnapshot —— Capacitor 的桥只有一条，轮询会跟批量拉取那些操作抢同一条通道。
 *
 * <p>⭐ 卡顿这件事的两条根因（都在这条链上）：
 * <ol>
 *   <li>播放循环 / 位置采样在主线程上 —— 已经在引擎里挪到专用 HandlerThread；</li>
 *   <li>每 250ms 往 WebView 里灌一次 JS（`evaluateJavascript` 要切进 JS 上下文、排到渲染
 *       流水线前面，还制造 GC 垃圾）—— 这里把位置事件过桥降到约 500ms 一拍。</li>
 * </ol>
 * 频谱是 20fps，只在 Web 侧明确说「我要频谱」的时候才推；主线程忙的时候只保留最新一帧，
 * 不排队（见 {@link #dispatchSpectrum}）。
 *
 * <p>事件名与 Web 侧 `src/services/playbackEngine/nativePlayerPlugin.ts` 一一对应，改一处
 * 两处都要改。
 */
@CapacitorPlugin(name = "FoliaNativePlayer")
public class FoliaNativePlayerPlugin extends Plugin {

    /** Web 侧监听的事件名（addListener('foliaNativePlayer')）。 */
    private static final String EVENT = "foliaNativePlayer";

    /**
     * 过桥回主线程用。
     *
     * Capacitor 的监听器表（`Plugin.eventListeners`）不是为并发写的：加 / 删监听器发生在
     * JS 那一侧，也就是主线程。播放器线程 / 采集线程直接 `notifyListeners` 等于跨线程改
     * 一个普通 HashMap —— 所以这里统一 post 回主线程再发。
     */
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /**
     * 位置事件过桥的最小间隔：引擎 250ms 报一次，攒两次才往 WebView 发。
     *
     * ⚠️ Web 侧的插值有上限（`MAX_LEAD_MS` 一类的夹取），**改这个值必须同步放宽那个上限**，
     * 否则位置会被夹住、进度条走走停停。引擎内部的 tick 仍然是 250ms，服务侧
     * `currentPositionMs()` 读的也是那个采样值，精度一点没降。
     */
    private static final long WEB_NOTIFY_INTERVAL_MS = 500L;

    /**
     * 位置往回跳超过这个量，就当作「seek / 循环回到开头」，这一拍不降频，立刻过桥。
     *
     * 位置 tick 本身只会往前走（单曲循环回到 0 是例外，那也是要立刻告诉 Web 的时间轴边界）。
     * 正向 seek 最多被吞掉一拍（≤500ms），Web 侧自己持有 seek 目标，不影响显示。
     */
    private static final long POSITION_REWIND_TOLERANCE_MS = 250L;

    /**
     * 服务那边（通知栏 / 锁屏 / 耳机）要能直接碰到播放器，只能走静态引用 ——
     * Activity 可能已经不在了，插件实例也可能换过。
     */
    private static volatile FoliaNativePlayerPlugin instance;

    private volatile boolean destroyed = false;

    private FoliaNativePlayer player;

    /**
     * 最近一次下发的 DSP 设置。
     *
     * <p>播放器可以被回收再重建（Activity 重建、插件 release 之后再 prepare），而 Web 侧
     * 不会为此重新下发一遍设置。所以这里留一份，{@link #ensurePlayer()} 建新播放器时直接
     * 装回去。
     */
    private volatile FoliaDspSettings lastDsp = FoliaDspSettings.NEUTRAL;

    /** 位置降频：只有播放器线程会碰这两个字段（onEvent 在那条线程上跑）。 */
    private long lastWebNotifyAtMs = 0L;
    private long lastForwardedPositionMs = 0L;

    /** 频谱的「只留最新一帧」信箱（采集线程写、主线程取）。 */
    private final AtomicReference<JSObject> pendingSpectrum = new AtomicReference<>();
    private final AtomicBoolean spectrumDrainScheduled = new AtomicBoolean(false);

    private final Runnable drainSpectrum = () -> {
        spectrumDrainScheduled.set(false);
        JSObject payload = pendingSpectrum.getAndSet(null);
        if (payload == null || destroyed) return;
        notifyListeners(EVENT, payload);
    };

    private final FoliaNativePlayer.Listener engineListener = new FoliaNativePlayer.Listener() {
        @Override
        public void onEvent(String type, long positionMs, long durationMs, String message) {
            // player == null 说明 Web 已经 release 过（或者插件在销毁）：迟到的这一拍直接丢。
            if (destroyed || player == null) return;
            /*
             * ⚠️ 这一下是**播放器线程**上跑的（播放循环在那条专用线程上），不在主线程。
             * 所以这里只组装普通对象，不碰任何 View / WebView。
             */
            JSObject payload = new JSObject();
            payload.put("type", type);
            payload.put("positionMs", (double) positionMs);
            payload.put("durationMs", (double) durationMs);
            if (message != null) {
                payload.put("message", message);
            }
            /*
             * ⭐ 位置这一档过桥要降频（500ms），其余状态事件照旧立刻发。
             *
             * 这笔开销不在数据量上，在「往 WebView 里塞一次 JS」这件事本身：它要切进
             * JS 上下文、排到渲染流水线前面，还给 GC 添一份垃圾。攒够两拍再发，频率直接
             * 减半，别的什么都不动。Web 侧按本地墙钟插值，视觉上看不出差别。
             */
            if ("position".equals(type)) {
                long now = SystemClock.elapsedRealtime();
                boolean rewound = positionMs + POSITION_REWIND_TOLERANCE_MS < lastForwardedPositionMs;
                if (!rewound && now - lastWebNotifyAtMs < WEB_NOTIFY_INTERVAL_MS) {
                    return;
                }
                lastWebNotifyAtMs = now;
                lastForwardedPositionMs = positionMs;
            }
            // 过桥那一下回主线程（原因见 MAIN 的说明）。
            MAIN.post(() -> {
                if (destroyed || player == null) return;
                notifyListeners(EVENT, payload);
            });
        }

        /**
         * 频谱（20fps，每帧 128 段）。
         *
         * ⚠️ 跑在频谱采集线程上。这里的 `spectrum` 已经是 0..255 的整数，
         * `bands` 也是 0..255（量纲见 NativeAudioSpectrumTap 的类注释）。
         */
        @Override
        public void onSpectrum(NativeAudioSpectrumTap.Frame frame) {
            if (destroyed || player == null || frame == null) return;
            JSArray spectrum = new JSArray();
            if (frame.spectrum != null) {
                for (int value : frame.spectrum) {
                    spectrum.put(value);
                }
            }
            JSObject bands = new JSObject();
            bands.put("bass", frame.bass);
            bands.put("lowMid", frame.lowMid);
            bands.put("mid", frame.mid);
            bands.put("vocal", frame.vocal);
            bands.put("treble", frame.treble);
            bands.put("power", frame.power);
            JSObject payload = new JSObject();
            payload.put("type", "spectrum");
            payload.put("bands", bands);
            payload.put("spectrum", spectrum);
            payload.put("sampleRate", frame.sampleRate);
            dispatchSpectrum(payload);
        }
    };

    /**
     * 频谱过桥：只保留最新一帧。
     *
     * 20fps 意味着主线程每 50ms 就有一条新 payload；一旦主线程被长任务占住（布局、绘制、
     * 别的高频 setState），按队列发就会越积越多，恢复时一次性把几十帧灌进 JS —— 比丢帧
     * 更糟。所以这里用一个单槽信箱：后来的帧直接覆盖前一个还没发出去的帧。
     * 可视化本来就是「最新状态」，丢掉中间帧不影响观感。
     */
    private void dispatchSpectrum(JSObject payload) {
        pendingSpectrum.set(payload);
        if (spectrumDrainScheduled.compareAndSet(false, true)) {
            MAIN.post(drainSpectrum);
        }
    }

    @Override
    public void load() {
        instance = this;
        // load() 在主线程上跑，但播放器自己会起一条专用线程（见 FoliaNativePlayer
        // 文件头的「线程」那一节）—— 这里只是把壳子建出来。
        ensurePlayer();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        FoliaNativePlayer current = player;
        player = null;
        if (current != null) {
            current.release();
        }
        pendingSpectrum.set(null);
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    /**
     * 播放器实例。
     *
     * `release()` 之后引擎会把线程收掉，所以这里允许**懒重建**：Web 侧 release 完再
     * prepare 一次也能重新起来，不需要重开 Activity。
     */
    private FoliaNativePlayer ensurePlayer() {
        if (destroyed) return null;
        FoliaNativePlayer current = player;
        if (current != null) return current;
        current = new FoliaNativePlayer(getContext(), engineListener);
        player = current;
        // 播放器重建后把上一次的设置装回去：Web 侧不需要因为重建而重发。
        current.setDsp(lastDsp);
        lastWebNotifyAtMs = 0L;
        lastForwardedPositionMs = 0L;
        return current;
    }

    // ------------------------------------------------------------------
    // 给 FoliaPlaybackService 用的静态入口（通知栏 / 锁屏 / 耳机键）
    // ------------------------------------------------------------------

    /**
     * 通知栏 / 锁屏按了「播放」之后，服务直接把这一下交给原生播放器。
     *
     * 不能只靠「广播 → 插件 → JS」那条老路：挂了很久之后，WebView 那侧的 JS 会被
     * 节流甚至整个挂起，`resumePlayback` 压根跑不起来 —— 表现就是
     * 「通知中心点了播放，一点反应都没有」。原生这一路不受那条限制。
     *
     * 只有在**确实是用原生在播**时才动手（手上有一首歌），否则交给 Web 那边照旧。
     * JS 那条命令照样会发：它负责界面与歌词，两边各管一半，不冲突。
     */
    public static void resumeFromSystem() {
        FoliaNativePlayerPlugin current = instance;
        if (current == null || current.destroyed) return;
        FoliaNativePlayer engine = current.player;
        if (engine == null || !engine.hasMedia()) return;
        engine.play();
    }

    /** 同上，方向相反。 */
    public static void pauseFromSystem() {
        FoliaNativePlayerPlugin current = instance;
        if (current == null || current.destroyed) return;
        FoliaNativePlayer engine = current.player;
        if (engine == null || !engine.hasMedia()) return;
        engine.pause();
    }

    /**
     * 原生手上有没有正在放的一首。
     *
     * 服务那边靠它决定「PlaybackState 的位置该由谁给」：原生在放的时候，Web 推上来的
     * 那个位置要过 Chromium 的定时器节流，挂久了就是「进度条不动」。
     */
    public static boolean hasActiveMedia() {
        FoliaNativePlayerPlugin current = instance;
        return current != null && !current.destroyed && current.player != null && current.player.hasMedia();
    }

    /**
     * 原生播放器**此刻是不是在播**。
     *
     * 和 `hasActiveMedia()` 是两件事：手上有一首不等于在播（暂停之后 lastUrl 还在）。
     */
    public static boolean isNativePlaying() {
        FoliaNativePlayerPlugin current = instance;
        return current != null && !current.destroyed && current.player != null && current.player.isPlaying();
    }

    /**
     * 原生播放器此刻的位置（毫秒）；没有播放器时给 -1。
     *
     * 通知栏 / 锁屏那条进度条用它：原生在放的时候位置只有播放器知道，而 Web 那一推
     * 要过 Chromium 的定时器节流 —— 挂久了就是「进度条不动」「一直是 00」。
     */
    public static long currentPositionMs() {
        FoliaNativePlayerPlugin current = instance;
        if (current == null || current.destroyed) return -1L;
        FoliaNativePlayer engine = current.player;
        return engine != null ? engine.getPositionMs() : -1L;
    }

    // ------------------------------------------------------------------
    // 插件方法（字段名与 Web 侧契约一一对应，不要改名）
    // ------------------------------------------------------------------

    @PluginMethod
    public void prepare(PluginCall call) {
        FoliaNativePlayer current = ensurePlayer();
        String url = call.getString("url");
        if (current == null) {
            call.reject("The player is not available.");
            return;
        }
        if (url == null || url.isEmpty()) {
            call.reject("A url is required.");
            return;
        }
        Double startPositionMs = call.getDouble("startPositionMs");
        int repeatMode = resolveRepeatMode(call);
        if (repeatMode >= 0) {
            current.setRepeatMode(repeatMode);
        }
        current.prepare(url, startPositionMs == null ? -1L : startPositionMs.longValue());
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void play(PluginCall call) {
        FoliaNativePlayer current = player;
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        current.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        FoliaNativePlayer current = player;
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        current.pause();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        FoliaNativePlayer current = player;
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        current.stop();
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        FoliaNativePlayer current = player;
        Double positionMs = call.getDouble("positionMs");
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        if (positionMs == null) {
            call.reject("positionMs is required.");
            return;
        }
        current.seek(positionMs.longValue());
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        FoliaNativePlayer current = player;
        Float volume = call.getFloat("volume");
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        if (volume == null) {
            call.reject("volume is required.");
            return;
        }
        current.setVolume(volume);
        call.resolve();
    }

    @PluginMethod
    public void setSpeed(PluginCall call) {
        FoliaNativePlayer current = player;
        Float speed = call.getFloat("speed");
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        if (speed == null) {
            call.reject("speed is required.");
            return;
        }
        current.setSpeed(speed);
        call.resolve();
    }

    /**
     * 频谱采集的开关。
     *
     * Web 侧按可见性开关：页面藏起来之后既没人看，也没有意义。默认关，只有真的要画
     * 频谱时才打开。
     */
    @PluginMethod
    public void setSpectrumEnabled(PluginCall call) {
        FoliaNativePlayer current = player;
        Boolean enabled = call.getBoolean("enabled");
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        if (enabled == null) {
            call.reject("enabled is required.");
            return;
        }
        current.setSpectrumEnabled(enabled);
        if (!enabled) {
            // 关掉之后可能还有一帧躺在信箱里，别让它再出去。
            pendingSpectrum.set(null);
        }
        call.resolve();
    }

    /**
     * 均衡器 / 音效 / ReplayGain 的整体下发。
     *
     * <p>字段名照抄 Web 侧（不要改名）：
     * <pre>
     * {
     *   enabled: boolean,
     *   gains: [10 个 dB 值],
     *   effects: { highpass, lowpass, drive, crush, wow, noise, width, space, punch },
     *   replayGainDb: number | null
     * }
     * </pre>
     *
     * <p>设置写进的是 {@code FoliaAudioProcessor} 的原子快照：播放中实时生效、不重建播放器、
     * 参数变化在音频线程上平滑过渡。越界 / NaN 由 {@link FoliaDspSettings} 夹紧，这里只负责
     * 取值。
     */
    @PluginMethod
    public void setDsp(PluginCall call) {
        // 允许比 prepare 更早调用：播放器壳子可以懒建，设置写进处理器后等第一次 configure 生效。
        FoliaNativePlayer current = ensurePlayer();
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }

        Boolean enabled = call.getBoolean("enabled");
        JSArray gains = call.getArray("gains");
        JSObject effects = call.getObject("effects");
        Double replayGainDb = call.getDouble("replayGainDb");

        float[] parsedGains = new float[FoliaDspSettings.BAND_COUNT];
        if (gains != null) {
            int count = Math.min(FoliaDspSettings.BAND_COUNT, gains.length());
            for (int index = 0; index < count; index += 1) {
                parsedGains[index] = (float) gains.optDouble(index, 0.0);
            }
        }

        FoliaDspSettings settings = new FoliaDspSettings(
            Boolean.TRUE.equals(enabled),
            parsedGains,
            effectValue(effects, "highpass", FoliaDspSettings.NEUTRAL_HIGHPASS_HZ),
            effectValue(effects, "lowpass", FoliaDspSettings.NEUTRAL_LOWPASS_HZ),
            effectValue(effects, "drive", FoliaDspSettings.NEUTRAL_DRIVE),
            effectValue(effects, "crush", FoliaDspSettings.NEUTRAL_CRUSH),
            effectValue(effects, "wow", FoliaDspSettings.NEUTRAL_WOW),
            effectValue(effects, "noise", FoliaDspSettings.NEUTRAL_NOISE),
            effectValue(effects, "width", FoliaDspSettings.NEUTRAL_WIDTH),
            effectValue(effects, "space", FoliaDspSettings.NEUTRAL_SPACE),
            effectValue(effects, "punch", FoliaDspSettings.NEUTRAL_PUNCH),
            replayGainDb == null ? 0f : replayGainDb.floatValue()
        );

        lastDsp = settings;
        current.setDsp(settings);
        call.resolve();
    }

    /** 取一个音效参数；字段缺省时用中性值，与 {@code normalizeAudioEffects} 的行为一致。 */
    private static float effectValue(JSObject effects, String key, float neutral) {
        return effects == null ? neutral : (float) effects.optDouble(key, neutral);
    }

    @PluginMethod
    public void getSnapshot(PluginCall call) {
        FoliaNativePlayer current = player;
        if (current == null) {
            call.reject("The player is not ready.");
            return;
        }
        JSObject result = new JSObject();
        result.put("positionMs", (double) current.getPositionMs());
        result.put("durationMs", (double) current.getDurationMs());
        result.put("playing", current.isPlaying());
        call.resolve(result);
    }

    @PluginMethod
    public void release(PluginCall call) {
        FoliaNativePlayer current = player;
        player = null;
        if (current != null) {
            current.release();
        }
        pendingSpectrum.set(null);
        call.resolve();
    }

    /**
     * `repeatMode` 允许两种写法：数字（0=off，1=one，2=all，与 media3 一致）或字符串
     * （'off' / 'one' / 'all'）。Web 侧用哪种都行；认不出来就保持原样（返回 -1）。
     */
    private static int resolveRepeatMode(PluginCall call) {
        Integer numeric = call.getInt("repeatMode");
        if (numeric != null) {
            int mode = numeric;
            if (mode == Player.REPEAT_MODE_OFF || mode == Player.REPEAT_MODE_ONE || mode == Player.REPEAT_MODE_ALL) {
                return mode;
            }
            return -1;
        }
        String text = call.getString("repeatMode");
        if (text == null) {
            return -1;
        }
        switch (text.trim().toLowerCase(Locale.ROOT)) {
            case "off":
            case "none":
                return Player.REPEAT_MODE_OFF;
            case "one":
            case "single":
                return Player.REPEAT_MODE_ONE;
            case "all":
            case "loop":
                return Player.REPEAT_MODE_ALL;
            default:
                return -1;
        }
    }
}

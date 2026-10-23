package top.izuna.foliamajor.audio;

import android.media.audiofx.Visualizer;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import java.util.concurrent.atomic.AtomicLong;

/**
 * 当前文件：原生播放（ExoPlayer）的频谱采集。
 *
 * 为什么需要它：播放一旦从 WebView 的 &lt;audio&gt; 换成 ExoPlayer，Web Audio 那张图就断了
 * （`createMediaElementSource` 是单向不可逆的），AnalyserNode 抽到的是空信号，播放页的
 * 柱子会全部趴下。所以频谱只能在原生侧采：`Visualizer(audioSessionId)`，session 取
 * ExoPlayer 自己的 `getAudioSessionId()` —— 只采这一首歌，不会把别的 App 的声音混进来
 * （对比传 0 的全局混音）。
 *
 * <p>量纲刻意做成和 WebAudio `getByteFrequencyData` 同一套，Web 侧那份可视化代码可以
 * 原样吃下去：
 * <ul>
 *   <li>{@code spectrum}：128 个 0..255 的整数，语义对齐 -100dB..-30dB 映射到 0..255；</li>
 *   <li>{@code bands}：bass / lowMid / mid / vocal / treble / power，同样是 0..255，
 *       频率边界和 shape 曲线与 Web 侧一致；</li>
 *   <li>{@code sampleRate}：Visualizer 本次采集用的采样率（Hz），Web 侧只用于显示/调试。</li>
 * </ul>
 *
 * <p>⭐ 线程：Visualizer 的 FFT 回调跑在**创建它的那条线程的 Looper** 上，而 20 帧/秒的
 * FFT + 重采样是实打实的 CPU 活，绝不能放主线程。这里自己起一条 HandlerThread 专管采集，
 * 主线程一个采样点都不碰。{@link Listener} 的回调就在这条采集线程上 —— 调用方（插件）
 * 负责把结果 post 回主线程再过 Capacitor 的桥，别在回调里直接碰 WebView。
 *
 * <p>拿不到数据时静默降级：一帧都不推，Web 侧维持它原来的行为。拿不到数据的常见原因：
 * manifest 缺 {@code RECORD_AUDIO} / {@code MODIFY_AUDIO_SETTINGS}、别的进程已经占用了这个
 * session 的 Visualizer、以及蓝牙 A2DP 输出（系统明确不给数据）。这几种失败在这里都是
 * **恒定**的，所以起不来就置 {@link #failed} 不再重试，免得每轮采集都白烧电还刷异常。
 *
 * <p>⭐ 失败不能只是「没声音」：插件那边有一个 {@code getSpectrumStatus()}，Web 诊断要能
 * 分清「开关没开」「在等播放」「权限被拒」「Visualizer 挂不上」。所以这里把
 * {@link #isRunning()} / {@link #isAttached()} / {@link #isFailed()} /
 * {@link #getFrameCount()} / {@link #getLastError()} 都做成 volatile / 原子读，任何线程
 * 都能安全问，不碰采集线程。
 */
public final class NativeAudioSpectrumTap {

    private static final String TAG = "FoliaNativeSpectrum";

    /** 推给 Web 侧的频谱段数。可视化只画几十根柱子，128 段足够，再密只是白耗桥带宽。 */
    public static final int SPECTRUM_LENGTH = 128;

    /** 采集节拍（次/秒）。下面按 Visualizer 要求的毫赫兹换算。 */
    private static final int CAPTURE_FPS = 20;

    /** 幅度上的指数平滑，对齐 AnalyserNode 的 smoothingTimeConstant = 0.6。 */
    private static final double SMOOTHING = 0.6;

    /**
     * 跳过的低频 bin（≈129Hz 以下）。
     *
     * 对齐页面侧的 `MIN_RAW_SPECTRUM_BIN = 6`：那边每个 bin 是 21.5Hz（44.1kHz / 2048），
     * 跳过 6 个 = 129Hz；这边 Visualizer 最大只能给到 1024 的捕获长度，每个 bin 是
     * 43Hz，所以对应跳过 3 个。
     */
    private static final int SKIP_BINS = 3;

    /**
     * 幅度 → 0..255 的参考响度。
     *
     * Visualizer 给的是**线性幅度**（signed byte 尺度，hypot 之后约 0..181），
     * 而页面那侧吃的是 dB 域。两边差一个固定尺度因子，这里用一个常量把它对上。
     *
     * **真机校准点**：频谱一直贴顶就把这个值调大，一直趴着就调小。
     */
    private static final double DB_REFERENCE = 84.0;

    /** 与 Web Audio 的 minDecibels(-100) / maxDecibels(-30) 一致。 */
    private static final double DB_RANGE = 70.0;

    /** 采集的一帧。数值全部是 0..255，跟页面侧 motion value 的量纲一致。 */
    public static final class Frame {
        public final int power;
        public final int bass;
        public final int lowMid;
        public final int mid;
        public final int vocal;
        public final int treble;
        /** 长度固定 {@link #SPECTRUM_LENGTH}，0..255。 */
        public final int[] spectrum;
        /** 本次采集的采样率（Hz）。 */
        public final int sampleRate;

        Frame(
            int power,
            int bass,
            int lowMid,
            int mid,
            int vocal,
            int treble,
            int[] spectrum,
            int sampleRate
        ) {
            this.power = power;
            this.bass = bass;
            this.lowMid = lowMid;
            this.mid = mid;
            this.vocal = vocal;
            this.treble = treble;
            this.spectrum = spectrum;
            this.sampleRate = sampleRate;
        }
    }

    /**
     * 一帧数据的上送。
     *
     * ⚠️ 跑在**采集线程**上，不是主线程。实现里不要做重活、不要碰 WebView / View；
     * 要过桥的话自己 post 到主线程。
     */
    public interface Listener {
        void onSpectrumFrame(Frame frame);
    }

    private final Listener listener;

    /**
     * 采集哪一路音频：ExoPlayer 的 `getAudioSessionId()`。
     *
     * 传 0 会变成全局混音（别的 App 的声音也会进来），所以只接受大于 0 的 session；
     * 拿不到 session 时调用方应当直接不建这个 tap。
     */
    private final int audioSessionId;

    private HandlerThread thread;
    private Handler worker;
    private Visualizer visualizer;

    private int captureSize = 0;
    /** 平滑后的幅度，长度 = captureSize / 2。只有采集线程碰它。 */
    private double[] smoothed;
    /** 输出缓冲，只有采集线程碰它。 */
    private int[] spectrum;

    private volatile boolean running = false;
    /** 起不来就不再试（见类注释最后一段）。 */
    private volatile boolean failed = false;
    /** Visualizer 是否真的挂上并 setEnabled 成功；和 {@link #running} 不是一回事。 */
    private volatile boolean attached = false;
    /** 已经送给上层的帧数：0 帧 + failed 就是「一条路都没通」的硬证据。 */
    private final AtomicLong frameCount = new AtomicLong();
    /**
     * 最近一次失败的原因（给 getSpectrumStatus 读）。
     *
     * 以前这里只置一个 failed，插件和 Web 侧只能看到「events=0」，分不清是权限、session
     * 还是被占用。现在每个失败分支都写一句能直接读的原因，成功后清空。
     */
    private volatile String lastError;

    public NativeAudioSpectrumTap(int audioSessionId, Listener listener) {
        this.audioSessionId = audioSessionId;
        this.listener = listener;
    }

    /** 挂上采集。重复调用无害。 */
    public void start() {
        if (running || failed) {
            return;
        }
        running = true;
        attached = false;
        lastError = null;
        // 回调跑在创建 Visualizer 的那条线程的 Looper 上，所以这条线程必须有 Looper。
        thread = new HandlerThread("folia-native-spectrum");
        thread.start();
        worker = new Handler(thread.getLooper());
        worker.post(this::attach);
    }

    /** 关掉采集并释放 Visualizer。重复调用无害。 */
    public void stop() {
        if (!running) {
            return;
        }
        running = false;
        attached = false;
        Handler currentWorker = worker;
        HandlerThread currentThread = thread;
        worker = null;
        thread = null;
        if (currentWorker == null || currentThread == null) {
            return;
        }
        // Visualizer 不是线程安全的，release 必须回到创建它的那条线程。
        currentWorker.post(this::releaseVisualizer);
        // quitSafely 会把队列里剩下的这条跑完再退，所以 release 一定执行得到。
        currentThread.quitSafely();
    }

    private void attach() {
        if (!running) {
            return;
        }
        Visualizer probe = null;
        try {
            probe = new Visualizer(audioSessionId);
            int[] range = Visualizer.getCaptureSizeRange();
            // 捕获长度越大频率越细，但上限是 1024（Visualizer 的硬规定），
            // 也就是 512 个频点 —— 比页面侧的 1024 个粗一倍，够画 128 段。
            int size = Math.min(1024, Math.max(128, range[1]));
            if (probe.setCaptureSize(size) != Visualizer.SUCCESS) {
                releaseQuietly(probe);
                fail("setCaptureSize(" + size + ") 失败");
                return;
            }
            int sampling = probe.getSamplingRate();
            if (sampling <= 0) {
                releaseQuietly(probe);
                fail("Visualizer 采样率无效(" + sampling + ")");
                return;
            }
            int maxRate = probe.getMaxCaptureRate();
            // 单位是毫赫兹：20000 mHz = 20 次/秒。
            int rate = CAPTURE_FPS * 1000;
            if (maxRate > 0) {
                rate = Math.min(rate, maxRate);
            }
            if (probe.setDataCaptureListener(new Visualizer.OnDataCaptureListener() {
                @Override
                public void onWaveFormDataCapture(Visualizer visualizer, byte[] waveform, int samplingRate) {
                    // 只要频谱。
                }

                @Override
                public void onFftDataCapture(Visualizer visualizer, byte[] fft, int samplingRate) {
                    onFft(fft, samplingRate);
                }
            }, rate, false, true) != Visualizer.SUCCESS) {
                releaseQuietly(probe);
                fail("setDataCaptureListener(" + rate + "mHz) 失败");
                return;
            }
            /*
             * 缓冲必须在 setEnabled 之前备好。
             *
             * 回调是 post 到**同一个** Looper 上的，理论上不会插到这个方法中间执行，
             * 但顺序上把它写成「先备好再开门」就不用依赖那条推论 —— 采集回调里
             * 摸到 null 缓冲就是一整条崩溃。
             */
            captureSize = size;
            smoothed = new double[size / 2];
            spectrum = new int[SPECTRUM_LENGTH];
            if (probe.setEnabled(true) != Visualizer.SUCCESS) {
                releaseQuietly(probe);
                // 最常见的一种：RECORD_AUDIO 没授予（或用户撤销了）。这一条必须写清楚，
                // 否则表现只有「events=0」，看不出是被权限挡住的。
                fail("setEnabled(true) 失败：可能缺少 RECORD_AUDIO 权限、session 被占用或输出是蓝牙");
                return;
            }
            visualizer = probe;
            attached = true;
            lastError = null;
            Log.i(TAG, "原生频谱采集已挂上 session=" + audioSessionId
                + " captureSize=" + captureSize + " rate=" + rate + "mHz");
        } catch (Throwable error) {
            // 采集起不来不是错误路径的终点：静默降级，Web 侧维持原来那份显示。
            Log.w(TAG, "原生频谱采集起不来，可视化维持原样", error);
            releaseQuietly(probe);
            fail(error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    /**
     * 记下一条失败原因并收口。
     *
     * 每个 attach 失败路径都走这里：日志里一句、状态里一句，插件 getSpectrumStatus()
     * 读到的 lastError 就是它。只写 volatile 字段，任何线程读都安全。
     */
    private void fail(String reason) {
        failed = true;
        attached = false;
        lastError = reason;
        Log.w(TAG, "原生频谱采集失败：" + reason);
    }

    // ------------------------------------------------------------------
    // 状态（给插件 getSpectrumStatus 用）：只读 volatile / 原子字段，不碰采集线程。
    // ------------------------------------------------------------------

    /** 采集线程已启动（不代表 Visualizer 已经挂上）。 */
    public boolean isRunning() {
        return running;
    }

    /** Visualizer 已经 setEnabled 成功，接下来就等帧。 */
    public boolean isAttached() {
        return attached;
    }

    /** 挂载失败且不会自动重试（见类注释）。关闭再开启会新建一个 tap。 */
    public boolean isFailed() {
        return failed;
    }

    /** 已经送给上层的帧数。 */
    public long getFrameCount() {
        return frameCount.get();
    }

    /** 最近一次挂载失败的原因；成功或尚未失败时为 null。 */
    public String getLastError() {
        return lastError;
    }

    private void releaseVisualizer() {
        Visualizer current = visualizer;
        visualizer = null;
        releaseQuietly(current);
    }

    private static void releaseQuietly(Visualizer target) {
        if (target == null) {
            return;
        }
        try {
            target.setEnabled(false);
        } catch (Throwable ignored) {
            // 已经没了。
        }
        try {
            target.release();
        } catch (Throwable ignored) {
            // 同上。
        }
    }

    /**
     * FFT 回调（采集线程）。
     *
     * 数据格式：`fft` 长度是 `captureSize * 2`，实部虚部交错，有效频点是前
     * `captureSize / 2` 个（0 .. Nyquist）。频率 = `k * samplingRate / captureSize`。
     * 下标 0 / 1 在 half-complex 打包下是 DC 与 Nyquist 的实部，这两点的误差
     * 在频谱上完全看不出来，所以按下标直接成对取，不做特殊处理。
     */
    private void onFft(byte[] fft, int samplingRateHz) {
        if (!running || fft == null || captureSize == 0 || smoothed == null || spectrum == null) {
            return;
        }
        int bins = captureSize / 2;
        if (fft.length < bins * 2 || samplingRateHz <= 0) {
            return;
        }
        for (int index = 0; index < bins; index += 1) {
            double real = fft[index * 2];
            double imaginary = fft[index * 2 + 1];
            double magnitude = Math.sqrt(real * real + imaginary * imaginary);
            // 平滑放在幅度域，跟 Web Audio 一样（它对 dB 之前的值做指数平滑）。
            smoothed[index] = smoothed[index] * SMOOTHING + magnitude * (1.0 - SMOOTHING);
        }

        double hzPerBin = samplingRateHz / (double) captureSize;
        // 频率边界与 Web 侧 computeBandEnergy 逐条对齐。
        double bassRaw = bandValue(hzPerBin, 20, 150);
        double lowMidRaw = bandValue(hzPerBin, 150, 400);
        double midRaw = bandValue(hzPerBin, 400, 1200);
        double vocalRaw = bandValue(hzPerBin, 1000, 3500);
        double trebleRaw = bandValue(hzPerBin, 3500, 12000);

        buildSpectrum();
        // 帧数在「帧已经成型」时加：Web 侧看到的 frames 与真有回调是同一刻。
        frameCount.incrementAndGet();

        int[] snapshot = new int[SPECTRUM_LENGTH];
        System.arraycopy(spectrum, 0, snapshot, 0, SPECTRUM_LENGTH);

        // shape 指数也与 Web 侧逐条对齐。
        final Frame frame = new Frame(
            shape((bassRaw + lowMidRaw) / 2.0, 3),
            shape(bassRaw, 1.8),
            shape(lowMidRaw, 2),
            shape(midRaw, 2),
            shape(vocalRaw, 1.5),
            shape(trebleRaw, 2),
            snapshot,
            samplingRateHz
        );
        try {
            if (listener != null) {
                // 就在采集线程上回调：调用方负责过桥（见 Listener 的说明）。
                listener.onSpectrumFrame(frame);
            }
        } catch (Throwable error) {
            // 上送一侧出问题不该把采集线程带崩。
            Log.w(TAG, "频谱上送失败", error);
        }
    }

    /** 一段频率里各 bin 的 0..255 值的平均，对齐 Web 侧的 computeBandEnergy。 */
    private double bandValue(double hzPerBin, double minHz, double maxHz) {
        int start = (int) Math.floor(minHz / hzPerBin);
        int end = (int) Math.floor(maxHz / hzPerBin);
        if (start < 0) {
            start = 0;
        }
        if (end >= smoothed.length) {
            end = smoothed.length - 1;
        }
        if (end < start) {
            return 0;
        }
        double sum = 0;
        for (int index = start; index <= end; index += 1) {
            sum += toByte(smoothed[index]);
        }
        return sum / (end - start + 1);
    }

    /**
     * 把 512 个频点重采样成 128 段，分段的对数曲线复刻页面侧
     * `sampleRawSpectrumProfile` 的映射 —— 那边按同一个指数往下取窗，
     * 这里按同一个指数往上分段，段与窗口才对得上。
     */
    private void buildSpectrum() {
        int usable = smoothed.length - SKIP_BINS;
        if (usable <= 1) {
            return;
        }
        double logSpan = Math.log(usable + 1);
        for (int index = 0; index < SPECTRUM_LENGTH; index += 1) {
            double from = Math.expm1((index / (double) SPECTRUM_LENGTH) * logSpan);
            double to = Math.expm1(((index + 1) / (double) SPECTRUM_LENGTH) * logSpan);
            int start = SKIP_BINS + (int) Math.floor(from);
            int end = SKIP_BINS + (int) Math.floor(to) - 1;
            if (start < SKIP_BINS) {
                start = SKIP_BINS;
            }
            if (end >= smoothed.length) {
                end = smoothed.length - 1;
            }
            if (end < start) {
                end = start;
            }
            double sum = 0;
            for (int bin = start; bin <= end; bin += 1) {
                sum += toByte(smoothed[bin]);
            }
            spectrum[index] = (int) Math.round(sum / (end - start + 1));
        }
    }

    /**
     * 线性幅度 → 0..255。
     *
     * 页面侧 `getByteFrequencyData` 给的是 dB 域（-100..-30 映射到 0..255），
     * Visualizer 给的是线性幅度，所以先转 dB 再减掉 {@link #DB_REFERENCE} 那把尺子。
     * 同一套常量决定了 Web 侧看到的形状；改这里要同步看 Web 侧的映射。
     */
    private static double toByte(double magnitude) {
        if (magnitude <= 1.0) {
            return 0;
        }
        double db = 20.0 * Math.log10(magnitude);
        double normalized = (db - DB_REFERENCE + 100.0) / DB_RANGE;
        if (normalized <= 0) {
            return 0;
        }
        if (normalized >= 1) {
            return 255;
        }
        return normalized * 255.0;
    }

    /** 对齐 shapeBandEnergy：pow(value / 255, boost) * 255。 */
    private static int shape(double value, double boost) {
        double normalized = value / 255.0;
        if (normalized <= 0) {
            return 0;
        }
        if (normalized > 1) {
            normalized = 1;
        }
        return (int) Math.round(Math.pow(normalized, boost) * 255.0);
    }
}

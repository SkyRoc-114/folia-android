package top.izuna.foliamajor.audio;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor.AudioFormat;
import androidx.media3.common.audio.AudioProcessor.StreamMetadata;
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException;
import androidx.media3.common.audio.BaseAudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.ShortBuffer;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 当前文件：ExoPlayer 音频链里的原生 DSP —— 10 段均衡器 + 音效链 + ReplayGain。
 *
 * <p>为什么放在 AudioProcessor 上：Web 侧一开均衡器 / 音效就回落 {@code <audio>}，是因为那些
 * 节点全在 Web Audio 图里，而 {@code createMediaElementSource} 单向不可逆 —— 原生出声之后
 * 那张图是断的。把同样的处理搬进 ExoPlayer 的音频管线，原生播放就能继续用，不用再回落到
 * WebView 播放。频谱（{@link NativeAudioSpectrumTap}）不经过这里，行为不变。
 *
 * <p>移植来源（只读参考，公式逐条对齐）：
 * <ul>
 *   <li>{@code src/services/audioEqualizerGraph.ts} + {@code src/utils/audioEqualizer.ts}：
 *       10 段 biquad 串联，形状 lowshelf / peaking / highshelf，Q=1.4，频率夹到
 *       {@code sampleRate * 0.475}；</li>
 *   <li>{@code src/services/audioEffects/effectChain.ts} 及同目录各分支：串联顺序
 *       highpass → lowpass → drive → crush → wow → width → compressor → makeup，
 *       外加并行 dry/wet reverb 与 noise。</li>
 * </ul>
 *
 * <p>⭐ 线程：{@link #setSettings} 在 Capacitor 的插件线程上调用，音频线程只读
 * {@link #settingsRef} 里的不可变快照。参数变化用一阶平滑（时间常数 15ms，按 64 帧一块
 * 推进）避免爆音；系数只在块边界重算（10 个 biquad 很便宜），音频线程上不做分配。
 *
 * <p>⚠️ 只处理 16-bit PCM。{@code DefaultAudioSink} 在 {@code setEnableFloatOutput(false)}
 * 时会在用户处理器**之前**插入 {@code ToInt16PcmAudioProcessor}，所以解码器的 float /
 * 24-bit 输出到这里已经是 16-bit；遇到其它编码（理论上不会出现）按契约抛
 * {@link UnhandledAudioFormatException}，不做静默降级。多于两个声道的 buffer 直接原样
 * 搬运（音乐不会走到这条路，但多声道影片不能因此出声失败）。
 *
 * <p>⚠️ 混响是**近似**：Web 侧用 2.2s 衰减 2.8 的噪声 IR 做卷积（{@code ConvolverNode}），
 * 真按卷积搬需要 FFT 与几十万 taps。这里用 Freeverb 的 Schroeder 结构（8 梳状 + 4 全通，
 * 按 RT60≈2.0s 逐梳状算反馈），湿声增益按 Web 的 {@code space * 0.75} 对到同一量级。
 */
@UnstableApi
public final class FoliaAudioProcessor extends BaseAudioProcessor {

    /** 每声道最多处理到这里；更多声道（多声道影片）整块原样搬运。 */
    private static final int MAX_CHANNELS = 2;

    private static final int EQ_BANDS = FoliaDspSettings.BAND_COUNT;

    /** 与 Web 侧 {@code EQUALIZER_TIME_CONSTANT_SECONDS} 一致。 */
    private static final float SMOOTHING_TIME_CONSTANT_SECONDS = 0.015f;

    /** 平滑与系数重算的块长：64 帧在 48kHz 下约 1.3ms，够细，又不用每帧算三角函数。 */
    private static final int SMOOTHING_CHUNK_FRAMES = 64;

    /** 低于这个量就当作已经完全中性（走逐字节直通）。 */
    private static final float ACTIVE_EPSILON = 1e-4f;

    /** 增益比较用更细的阈值：0.001dB 以下听不出来，没必要为它跑 10 个 biquad。 */
    private static final float GAIN_ACTIVE_EPSILON_DB = 1e-3f;

    /** 与 Web 侧 {@code WOW_BASE_DELAY_SECONDS} 一致。 */
    private static final float WOW_BASE_DELAY_SECONDS = 0.012f;
    private static final float WOW_DEPTH_SECONDS = 0.0045f;
    private static final float FLUTTER_DEPTH_SECONDS = 0.0006f;
    private static final double WOW_RATE_HZ = 0.7;
    private static final double FLUTTER_RATE_HZ = 6.8;

    /** 与 Web 侧 {@code createVinylNoiseBuffer} / {@code noiseBranch} 一致。 */
    private static final float NOISE_WHITE_AMPLITUDE = 0.12f;
    private static final float NOISE_CRACKLE_PROBABILITY = 0.0007f;
    private static final float NOISE_CRACKLE_DECAY = 0.88f;
    private static final float NOISE_CRACKLE_AMPLITUDE = 0.9f;
    private static final float NOISE_BANDPASS_HZ = 2600f;
    private static final float NOISE_BANDPASS_Q = 0.5f;
    private static final float NOISE_GAIN_SCALE = 0.55f;

    /** Freeverb 的经典延迟长度（44.1kHz 采样下），按实际采样率等比缩放。 */
    private static final int[] REVERB_COMB_DELAYS = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617};
    private static final int[] REVERB_ALLPASS_DELAYS = {556, 441, 341, 225};
    private static final int REVERB_STEREO_SPREAD = 23;
    private static final float REVERB_DAMPING = 0.2f;
    private static final float REVERB_INPUT_GAIN = 0.015f;
    /** 对齐 Web 侧卷积混响的衰减时间（IR 2.2s、(1-p)^2.8 的 -60dB 点约在 2.0s）。 */
    private static final float REVERB_RT60_SECONDS = 2.0f;

    /** 湿声标定（见 allocateForFormat 里的说明），让 Freeverb 的输出量级对上 Web 的 space*0.75。 */
    private static final float REVERB_WET_CALIBRATION = 0.78f;

    /** ReplayGain 之上再往上推时用的软限幅拐点。 */
    private static final float SOFT_LIMIT_KNEE = 0.9f;

    /**
     * 最近一次 {@link #setSettings} 的快照。
     *
     * <p>不可变，插件线程整体替换；音频线程每个 buffer 读一次引用，读到的是一份完整的设置，
     * 不会读到写了一半的参数。
     */
    private final AtomicReference<Plan> settingsRef = new AtomicReference<>(Plan.create(null));

    // ---- 格式（onConfigure 写，音频线程只读） ----------------------------------------------

    private int sampleRate = 44100;
    private int channelCount = 2;

    // ---- 目标值（来自当前 Plan，音频线程在块边界更新） --------------------------------------

    private final float[] targetGainsDb = new float[EQ_BANDS];
    private float targetHighpass = FoliaDspSettings.NEUTRAL_HIGHPASS_HZ;
    private float targetLowpass = FoliaDspSettings.NEUTRAL_LOWPASS_HZ;
    private float targetDrive = FoliaDspSettings.NEUTRAL_DRIVE;
    private float targetCrush = FoliaDspSettings.NEUTRAL_CRUSH;
    private float targetWow = FoliaDspSettings.NEUTRAL_WOW;
    private float targetNoise = FoliaDspSettings.NEUTRAL_NOISE;
    private float targetWidth = FoliaDspSettings.NEUTRAL_WIDTH;
    private float targetSpace = FoliaDspSettings.NEUTRAL_SPACE;
    private float targetPunch = FoliaDspSettings.NEUTRAL_PUNCH;
    private float targetReplayGainLinear = 1f;
    private float targetSaturationCompensation = 1f;

    // ---- 平滑后的当前值（音频线程） --------------------------------------------------------

    private final float[] smoothGainsDb = new float[EQ_BANDS];
    private float smoothHighpass = FoliaDspSettings.NEUTRAL_HIGHPASS_HZ;
    private float smoothLowpass = FoliaDspSettings.NEUTRAL_LOWPASS_HZ;
    private float smoothDrive = FoliaDspSettings.NEUTRAL_DRIVE;
    private float smoothCrush = FoliaDspSettings.NEUTRAL_CRUSH;
    private float smoothWow = FoliaDspSettings.NEUTRAL_WOW;
    private float smoothNoise = FoliaDspSettings.NEUTRAL_NOISE;
    private float smoothWidth = FoliaDspSettings.NEUTRAL_WIDTH;
    private float smoothSpace = FoliaDspSettings.NEUTRAL_SPACE;
    private float smoothPunch = FoliaDspSettings.NEUTRAL_PUNCH;
    private float smoothReplayGainLinear = 1f;
    private float smoothSaturationCompensation = 1f;

    private Plan activePlan = settingsRef.get();

    // ---- 每块生效的派生参数 ----------------------------------------------------------------

    private boolean eqActive;
    private boolean filterActive;
    private boolean driveActive;
    private boolean crushActive;
    private boolean wowActive;
    private boolean widthActive;
    private boolean compressorActive;
    private boolean reverbActive;
    private boolean noiseActive;
    private boolean replayGainActive;

    /** 上一块各阶段是否开着：用于在「开 → 关」的那一刻清掉残留状态。 */
    private boolean eqWasActive;
    private boolean filterWasActive;
    private boolean wowWasActive;
    private boolean reverbWasActive;

    private float driveShape = 1f;
    private float driveScale = 1f;
    private float crushSteps = 32768f;

    private float compressorThresholdDb = -6f;
    private float compressorSlope = 1f;
    private float compressorKneeDb = 30f;
    private float compressorMakeupDb = 0f;
    private float compressorAttackCoefficient = 0.9f;
    private float compressorReleaseCoefficient = 0.999f;
    private float compressorEnvelope = 0f;

    private float reverbDry = 1f;
    private float reverbWet = 0f;
    private float reverbTrim = 1f;

    private float noiseGain = 0f;

    // ---- 逐声道状态 ------------------------------------------------------------------------

    private final float[][] eqState1 = new float[MAX_CHANNELS][EQ_BANDS];
    private final float[][] eqState2 = new float[MAX_CHANNELS][EQ_BANDS];
    private final float[] eqB0 = new float[EQ_BANDS];
    private final float[] eqB1 = new float[EQ_BANDS];
    private final float[] eqB2 = new float[EQ_BANDS];
    private final float[] eqA1 = new float[EQ_BANDS];
    private final float[] eqA2 = new float[EQ_BANDS];

    private final float[] highpassState1 = new float[MAX_CHANNELS];
    private final float[] highpassState2 = new float[MAX_CHANNELS];
    private float highpassB0 = 1f;
    private float highpassB1;
    private float highpassB2;
    private float highpassA1;
    private float highpassA2;

    private final float[] lowpassState1 = new float[MAX_CHANNELS];
    private final float[] lowpassState2 = new float[MAX_CHANNELS];
    private float lowpassB0 = 1f;
    private float lowpassB1;
    private float lowpassB2;
    private float lowpassA1;
    private float lowpassA2;

    private final float[][] wowBuffer = new float[MAX_CHANNELS][0];
    private final int[] wowWriteIndex = new int[MAX_CHANNELS];
    private double wowPhase;
    private double flutterPhase;
    private double wowPhaseIncrement;
    private double flutterPhaseIncrement;
    private float wowBaseSamples;
    private float wowDepthSamples;
    private float flutterDepthSamples;

    private float[][][] reverbCombBuffers = new float[MAX_CHANNELS][0][0];
    private int[][] reverbCombIndices = new int[MAX_CHANNELS][0];
    private float[][] reverbCombStore = new float[MAX_CHANNELS][0];
    private float[][][] reverbAllpassBuffers = new float[MAX_CHANNELS][0][0];
    private int[][] reverbAllpassIndices = new int[MAX_CHANNELS][0];
    private float[] reverbCombFeedback = new float[0];

    private final int[] noiseRandomState = {0x9E3779B9, 0x9E3779B9 + 0x85EBCA6B};
    private final float[] crackleState = new float[MAX_CHANNELS];
    private final float[] noiseBandState1 = new float[MAX_CHANNELS];
    private final float[] noiseBandState2 = new float[MAX_CHANNELS];
    private float noiseBandB0;
    private float noiseBandB2;
    private float noiseBandA1;
    private float noiseBandA2;

    // ---- 每 buffer 的临时缓冲（按需增长，之后复用） ----------------------------------------

    private short[] pcmScratch = new short[0];
    private final float[][] channelSamples = new float[MAX_CHANNELS][0];

    /**
     * 全新的处理器：默认关、全中性、ReplayGain 0dB，逐字节直通。
     *
     * <p>{@code ExoPlayer} 建起来之前 Web 侧可能还没调 {@code setDsp}，所以默认必须是
     * 「什么都不动」。
     */
    public FoliaAudioProcessor() {
        // 初始化状态；真正的格式在 onConfigure 里拿。
    }

    // =====================================================================================
    // 对外入口
    // =====================================================================================

    /**
     * 换一份设置。可以在任意线程调用（插件线程就是这么用的）。
     *
     * <p>这里做的活包括饱和曲线的响度补偿（1024 点正弦，Web 侧
     * {@code measureSaturationCompensation} 的同一套算法）——放在这条线程上算，音频线程
     * 只负责平滑。设置对象本身不可变，所以音频线程读到的永远是完整的一份。
     */
    public void setSettings(@Nullable FoliaDspSettings settings) {
        settingsRef.set(Plan.create(settings));
    }

    // =====================================================================================
    // BaseAudioProcessor 钩子
    // =====================================================================================

    /**
     * 只接受 16-bit PCM，输出同采样率 / 同声道数。
     *
     * <p>输入编码不是 16-bit 时按契约抛 {@link UnhandledAudioFormatException}：这条链上
     * 正常情况下不会出现（sink 强制 16-bit 输出，{@code ToInt16PcmAudioProcessor} 在用户
     * 处理器之前完成转换），真出现了说明假设不成立，宁可让上层看到明确的错误也不静默
     * 出一段没处理的音。
     */
    @Override
    protected AudioFormat onConfigure(AudioFormat inputAudioFormat)
        throws UnhandledAudioFormatException {
        if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT) {
            throw new UnhandledAudioFormatException(
                "FoliaDsp handles 16-bit PCM only",
                inputAudioFormat
            );
        }
        sampleRate = inputAudioFormat.sampleRate > 0 ? inputAudioFormat.sampleRate : 44100;
        channelCount = inputAudioFormat.channelCount;
        allocateForFormat();
        resetState();
        // 插件线程可能在播放器建起来之前就发过设置：configure 时直接落到目标，不走 15ms 滑动。
        activePlan = settingsRef.get();
        copyTargets(activePlan);
        syncSmoothingToTargets();
        updateFlags();
        updateCoefficients();
        return inputAudioFormat;
    }

    /**
     * seek / 换格式之后的重新开始：清掉延迟线与滤波器状态，参数直接落到目标值（不滑）。
     *
     * <p>用带 {@link StreamMetadata} 的新重载：media3 1.11 里无参的 {@code onFlush()} 已废弃，
     * 而两个入口（{@code flush()} 与 {@code flush(metadata)}）最终都走到这里。
     */
    @Override
    protected void onFlush(StreamMetadata streamMetadata) {
        resetState();
        activePlan = settingsRef.get();
        copyTargets(activePlan);
        syncSmoothingToTargets();
        updateFlags();
        updateCoefficients();
    }

    /** 复位：把一切清回中性；下一轮 configure 会把设置重新装回来。 */
    @Override
    protected void onReset() {
        resetState();
        syncSmoothingToTargets();
    }

    /**
     * 处理一个 PCM buffer。
     *
     * <p>三种走法：
     * <ol>
     *   <li>设置全中性且平滑值已经落定、ReplayGain 0dB —— 逐字节搬运，bit-perfect；</li>
     *   <li>不是 1/2 声道（多声道影片）—— 原样搬运，绝不改数据；</li>
     *   <li>其余 —— 拆成每声道 float、跑 DSP、再合回 16-bit。</li>
     * </ol>
     */
    @Override
    public void queueInput(ByteBuffer inputBuffer) {
        if (!inputBuffer.hasRemaining()) {
            return;
        }

        int channels = channelCount;
        if (sampleRate <= 0 || (channels != 1 && channels != 2)) {
            copyThrough(inputBuffer);
            return;
        }

        int frameBytes = channels * 2;
        int remaining = inputBuffer.remaining();
        int frames = remaining / frameBytes;
        int tailBytes = remaining - frames * frameBytes;
        if (frames <= 0) {
            copyThrough(inputBuffer);
            return;
        }

        applyPendingPlan();
        if (canBypassCompletely()) {
            copyThrough(inputBuffer);
            return;
        }

        ensureScratch(frames);
        ShortBuffer inputShorts = inputBuffer.order(ByteOrder.nativeOrder()).asShortBuffer();
        int sampleCount = frames * channels;
        inputShorts.get(pcmScratch, 0, sampleCount);
        inputBuffer.position(inputBuffer.position() + sampleCount * 2);

        // 拆成每声道一条 float 轨。除法用 1/32768（2 的幂，float 精确），回写时乘回去
        // 才能保证「中性 = 逐样本相等」。
        for (int channel = 0; channel < channels; channel += 1) {
            float[] track = channelSamples[channel];
            for (int frame = 0; frame < frames; frame += 1) {
                track[frame] = pcmScratch[frame * channels + channel] * (1f / 32768f);
            }
        }

        processFrames(frames, channels);

        for (int channel = 0; channel < channels; channel += 1) {
            float[] track = channelSamples[channel];
            for (int frame = 0; frame < frames; frame += 1) {
                pcmScratch[frame * channels + channel] = toPcm16(track[frame]);
            }
        }

        ByteBuffer outputBuffer = replaceOutputBuffer(remaining);
        ShortBuffer outputShorts = outputBuffer.order(ByteOrder.nativeOrder()).asShortBuffer();
        outputShorts.put(pcmScratch, 0, sampleCount);
        outputBuffer.position(sampleCount * 2);
        // PCM 帧总是整帧的；万一有残余字节（不该发生）照原样带上，别丢数据。
        while (tailBytes > 0) {
            outputBuffer.put(inputBuffer.get());
            tailBytes -= 1;
        }
        outputBuffer.flip();
    }

    // =====================================================================================
    // 设置快照
    // =====================================================================================

    /**
     * 一份不可变的「这次要做什么」。
     *
     * <p>与 {@link FoliaDspSettings} 的区别：这里已经是**实际生效**的参数 ——
     * {@code enabled == false} 时增益清零、音效回中性（与 Web 侧
     * {@code createAudioEffectChain} 的 {@code DEFAULT_AUDIO_EFFECT_SETTINGS} 一致），
     * ReplayGain 不受 {@code enabled} 影响。
     */
    private static final class Plan {

        final boolean enabled;
        final float[] gainsDb;
        final float highpass;
        final float lowpass;
        final float drive;
        final float crush;
        final float wow;
        final float noise;
        final float width;
        final float space;
        final float punch;
        final float replayGainLinear;
        final float saturationCompensation;

        private Plan(
            boolean enabled,
            float[] gainsDb,
            float highpass,
            float lowpass,
            float drive,
            float crush,
            float wow,
            float noise,
            float width,
            float space,
            float punch,
            float replayGainLinear,
            float saturationCompensation
        ) {
            this.enabled = enabled;
            this.gainsDb = gainsDb;
            this.highpass = highpass;
            this.lowpass = lowpass;
            this.drive = drive;
            this.crush = crush;
            this.wow = wow;
            this.noise = noise;
            this.width = width;
            this.space = space;
            this.punch = punch;
            this.replayGainLinear = replayGainLinear;
            this.saturationCompensation = saturationCompensation;
        }

        static Plan create(@Nullable FoliaDspSettings settings) {
            float[] gains = new float[EQ_BANDS];
            float highpass = FoliaDspSettings.NEUTRAL_HIGHPASS_HZ;
            float lowpass = FoliaDspSettings.NEUTRAL_LOWPASS_HZ;
            float drive = FoliaDspSettings.NEUTRAL_DRIVE;
            float crush = FoliaDspSettings.NEUTRAL_CRUSH;
            float wow = FoliaDspSettings.NEUTRAL_WOW;
            float noise = FoliaDspSettings.NEUTRAL_NOISE;
            float width = FoliaDspSettings.NEUTRAL_WIDTH;
            float space = FoliaDspSettings.NEUTRAL_SPACE;
            float punch = FoliaDspSettings.NEUTRAL_PUNCH;
            float replayGainDb = 0f;

            boolean enabled = settings != null && settings.isEnabled();
            if (settings != null) {
                replayGainDb = settings.getReplayGainDb();
                if (enabled) {
                    System.arraycopy(
                        settings.getGainsInternal(),
                        0,
                        gains,
                        0,
                        EQ_BANDS
                    );
                    highpass = settings.getHighpass();
                    lowpass = settings.getLowpass();
                    drive = settings.getDrive();
                    crush = settings.getCrush();
                    wow = settings.getWow();
                    noise = settings.getNoise();
                    width = settings.getWidth();
                    space = settings.getSpace();
                    punch = settings.getPunch();
                }
            }

            // 饱和曲线的响度补偿：Web 侧在换曲线时算一次，这里同样一次算好，音频线程不再碰。
            float shape = 1f + drive * 4f;
            float compensation = drive > 0f
                ? measureSaturationCompensation(shape, (float) Math.tanh(shape))
                : 1f;

            return new Plan(
                enabled,
                gains,
                highpass,
                lowpass,
                drive,
                crush,
                wow,
                noise,
                width,
                space,
                punch,
                (float) Math.pow(10.0, replayGainDb / 20.0),
                compensation
            );
        }

        /** 目标本身是不是「什么都不做」：用来决定能不能走逐字节直通。 */
        boolean isNeutralTargets() {
            if (Math.abs(replayGainLinear - 1f) > 1e-6f) {
                return false;
            }
            for (int index = 0; index < EQ_BANDS; index += 1) {
                if (gainsDb[index] != 0f) {
                    return false;
                }
            }
            return highpass == FoliaDspSettings.NEUTRAL_HIGHPASS_HZ
                && lowpass == FoliaDspSettings.NEUTRAL_LOWPASS_HZ
                && drive == 0f
                && crush == 0f
                && wow == 0f
                && noise == 0f
                && width == FoliaDspSettings.NEUTRAL_WIDTH
                && space == 0f
                && punch == 0f;
        }
    }

    // =====================================================================================
    // 目标 / 平滑 / 系数
    // =====================================================================================

    private void applyPendingPlan() {
        Plan plan = settingsRef.get();
        if (plan == activePlan) {
            return;
        }
        activePlan = plan;
        copyTargets(plan);
    }

    private void copyTargets(Plan plan) {
        System.arraycopy(plan.gainsDb, 0, targetGainsDb, 0, EQ_BANDS);
        targetHighpass = plan.highpass;
        // Web 侧把 lowpass 夹到 sampleRate * 0.475；中性值 20kHz 在低采样率下也按这个上限。
        targetLowpass = Math.min(plan.lowpass, lowpassCeiling());
        targetDrive = plan.drive;
        targetCrush = plan.crush;
        targetWow = plan.wow;
        targetNoise = plan.noise;
        targetWidth = plan.width;
        targetSpace = plan.space;
        targetPunch = plan.punch;
        targetReplayGainLinear = plan.replayGainLinear;
        targetSaturationCompensation = plan.saturationCompensation;
    }

    private void syncSmoothingToTargets() {
        System.arraycopy(targetGainsDb, 0, smoothGainsDb, 0, EQ_BANDS);
        smoothHighpass = targetHighpass;
        smoothLowpass = targetLowpass;
        smoothDrive = targetDrive;
        smoothCrush = targetCrush;
        smoothWow = targetWow;
        smoothNoise = targetNoise;
        smoothWidth = targetWidth;
        smoothSpace = targetSpace;
        smoothPunch = targetPunch;
        smoothReplayGainLinear = targetReplayGainLinear;
        smoothSaturationCompensation = targetSaturationCompensation;
    }

    /** 每个 64 帧块推进一次一阶平滑；时间常数 15ms，与 Web 侧 setTargetAtTime 一致。 */
    private void advanceSmoothing(int frames) {
        float coefficient = 1f - (float) Math.exp(
            -frames / (SMOOTHING_TIME_CONSTANT_SECONDS * sampleRate)
        );
        for (int index = 0; index < EQ_BANDS; index += 1) {
            smoothGainsDb[index] = approach(smoothGainsDb[index], targetGainsDb[index], coefficient);
        }
        smoothHighpass = approach(smoothHighpass, targetHighpass, coefficient);
        smoothLowpass = approach(smoothLowpass, targetLowpass, coefficient);
        smoothDrive = approach(smoothDrive, targetDrive, coefficient);
        smoothCrush = approach(smoothCrush, targetCrush, coefficient);
        smoothWow = approach(smoothWow, targetWow, coefficient);
        smoothNoise = approach(smoothNoise, targetNoise, coefficient);
        smoothWidth = approach(smoothWidth, targetWidth, coefficient);
        smoothSpace = approach(smoothSpace, targetSpace, coefficient);
        smoothPunch = approach(smoothPunch, targetPunch, coefficient);
        smoothReplayGainLinear = approach(
            smoothReplayGainLinear,
            targetReplayGainLinear,
            coefficient
        );
        smoothSaturationCompensation = approach(
            smoothSaturationCompensation,
            targetSaturationCompensation,
            coefficient
        );
    }

    /**
     * 一阶平滑的一步，并在足够接近时**落到目标值**。
     *
     * <p>指数收敛永远到不了目标：crush=1 会一直停在 0.9995，量化级数就成了 8.017 而不是 8。
     * 差 1e-6 时直接吸附过去，听不出来，但能让「关掉后逐字节直通」和「crush 的 8 级量化」
     * 这类离散结论真正成立。
     */
    private static float approach(float current, float target, float coefficient) {
        float next = current + (target - current) * coefficient;
        return Math.abs(target - next) < 1e-6f ? target : next;
    }

    /** 根据平滑后的值决定这一段要开哪些级（关掉的级连乘加都不做）。 */
    private void updateFlags() {
        boolean anyGain = false;
        for (int index = 0; index < EQ_BANDS; index += 1) {
            if (Math.abs(smoothGainsDb[index]) > GAIN_ACTIVE_EPSILON_DB) {
                anyGain = true;
                break;
            }
        }
        eqActive = anyGain;

        filterActive = Math.abs(smoothHighpass - FoliaDspSettings.NEUTRAL_HIGHPASS_HZ) > 0.5f
            || Math.abs(smoothLowpass - lowpassCeiling()) > 1f;
        driveActive = smoothDrive > ACTIVE_EPSILON;
        crushActive = smoothCrush > ACTIVE_EPSILON;
        wowActive = smoothWow > ACTIVE_EPSILON;
        widthActive = Math.abs(smoothWidth - FoliaDspSettings.NEUTRAL_WIDTH) > ACTIVE_EPSILON;
        compressorActive = smoothPunch > ACTIVE_EPSILON;
        reverbActive = smoothSpace > ACTIVE_EPSILON;
        noiseActive = smoothNoise > ACTIVE_EPSILON;
        replayGainActive = Math.abs(smoothReplayGainLinear - 1f) > 1e-5f;

        driveShape = 1f + smoothDrive * 4f;
        driveScale = (float) Math.tanh(driveShape);

        if (crushActive) {
            // 与 Web 侧一致：bits = 16 - sqrt(amount) * 12，steps = max(2, 2^(bits-1))。
            float bits = 16f - (float) Math.sqrt(smoothCrush) * 12f;
            crushSteps = Math.max(2f, (float) Math.pow(2.0, bits - 1.0));
        } else {
            crushSteps = 32768f;
        }

        // punch：threshold=-6-26p、ratio=1+7p、knee=30-18p、makeup=+3p dB、attack 8ms、release 180ms。
        compressorThresholdDb = -6f - smoothPunch * 26f;
        compressorSlope = 1f / (1f + smoothPunch * 7f);
        compressorKneeDb = 30f - smoothPunch * 18f;
        compressorMakeupDb = smoothPunch * 3f;

        if (reverbActive) {
            // 与 Web 侧 reverbBranch 一致：dry = 1 - space*0.2，wet = space*0.75。
            reverbDry = 1f - smoothSpace * 0.2f;
            reverbWet = smoothSpace * 0.75f;
        } else {
            reverbDry = 1f;
            reverbWet = 0f;
        }

        noiseGain = noiseActive
            ? (float) Math.pow(smoothNoise, 1.4) * NOISE_GAIN_SCALE
            : 0f;

        if (wowActive) {
            wowBaseSamples = WOW_BASE_DELAY_SECONDS * sampleRate;
            wowDepthSamples = smoothWow * WOW_DEPTH_SECONDS * sampleRate;
            flutterDepthSamples = smoothWow * FLUTTER_DEPTH_SECONDS * sampleRate;
        }

        // 阶段从「开」变「关」的这一刻清掉它的历史状态：
        // 否则下次再打开时，会先放出几分钟前留在延迟线 / 混响里的旧声音（或滤波器里
        // 的旧电量），听感上是一次突兀的尾巴。此时湿声增益已经滑到 0，清理本身听不见。
        if (eqWasActive && !eqActive) {
            clearEqualizerStates();
        }
        if (filterWasActive && !filterActive) {
            clearCutoffStates();
        }
        if (wowWasActive && !wowActive) {
            clearWowBuffers();
        }
        if (reverbWasActive && !reverbActive) {
            clearReverbBuffers();
        }
        if (!compressorActive) {
            compressorEnvelope = 0f;
        }
        eqWasActive = eqActive;
        filterWasActive = filterActive;
        wowWasActive = wowActive;
        reverbWasActive = reverbActive;
    }

    /** 块边界重算系数。10 个 biquad + 几个标量，比每帧算便宜太多。 */
    private void updateCoefficients() {
        if (eqActive) {
            for (int index = 0; index < EQ_BANDS; index += 1) {
                float gainDb = smoothGainsDb[index];
                float frequency = FoliaDspSettings.BAND_FREQUENCIES_HZ[index];
                if (index == 0) {
                    designLowShelf(index, frequency, gainDb);
                } else if (index == EQ_BANDS - 1) {
                    designHighShelf(index, frequency, gainDb);
                } else {
                    designPeaking(index, frequency, gainDb, 1.4f);
                }
            }
        }

        if (filterActive) {
            designHighpass(smoothHighpass, 0.7f);
            designLowpass(smoothLowpass, 0.7f);
        }
    }

    private float lowpassCeiling() {
        return Math.min(FoliaDspSettings.NEUTRAL_LOWPASS_HZ, sampleRate * 0.475f);
    }

    private float clampFrequency(float frequency) {
        float maximum = sampleRate * 0.475f;
        if (frequency > maximum) {
            return maximum;
        }
        if (frequency < 10f) {
            return 10f;
        }
        return frequency;
    }

    // ---- RBJ cookbook 系数 ----------------------------------------------------------------

    private void designPeaking(int band, float frequency, float gainDb, float q) {
        double amplitude = Math.pow(10.0, gainDb / 40.0);
        double w0 = 2.0 * Math.PI * clampFrequency(frequency) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / (2.0 * q);
        double a0 = 1.0 + alpha / amplitude;
        eqB0[band] = (float) ((1.0 + alpha * amplitude) / a0);
        eqB1[band] = (float) (-2.0 * cos / a0);
        eqB2[band] = (float) ((1.0 - alpha * amplitude) / a0);
        eqA1[band] = (float) (-2.0 * cos / a0);
        eqA2[band] = (float) ((1.0 - alpha / amplitude) / a0);
    }

    /** lowshelf，S=1（Web Audio 的 lowshelf 不使用 Q）。 */
    private void designLowShelf(int band, float frequency, float gainDb) {
        double amplitude = Math.pow(10.0, gainDb / 40.0);
        double w0 = 2.0 * Math.PI * clampFrequency(frequency) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / 2.0 * Math.sqrt(2.0);
        double sqrtAmplitude = Math.sqrt(amplitude);
        double a0 = (amplitude + 1.0) + (amplitude - 1.0) * cos + 2.0 * sqrtAmplitude * alpha;
        eqB0[band] = (float) (amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cos
            + 2.0 * sqrtAmplitude * alpha) / a0);
        eqB1[band] = (float) (2.0 * amplitude * ((amplitude - 1.0) - (amplitude + 1.0) * cos) / a0);
        eqB2[band] = (float) (amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cos
            - 2.0 * sqrtAmplitude * alpha) / a0);
        eqA1[band] = (float) (-2.0 * ((amplitude - 1.0) + (amplitude + 1.0) * cos) / a0);
        eqA2[band] = (float) (((amplitude + 1.0) + (amplitude - 1.0) * cos
            - 2.0 * sqrtAmplitude * alpha) / a0);
    }

    /** highshelf，S=1。 */
    private void designHighShelf(int band, float frequency, float gainDb) {
        double amplitude = Math.pow(10.0, gainDb / 40.0);
        double w0 = 2.0 * Math.PI * clampFrequency(frequency) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / 2.0 * Math.sqrt(2.0);
        double sqrtAmplitude = Math.sqrt(amplitude);
        double a0 = (amplitude + 1.0) - (amplitude - 1.0) * cos + 2.0 * sqrtAmplitude * alpha;
        eqB0[band] = (float) (amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cos
            + 2.0 * sqrtAmplitude * alpha) / a0);
        eqB1[band] = (float) (-2.0 * amplitude * ((amplitude - 1.0) + (amplitude + 1.0) * cos) / a0);
        eqB2[band] = (float) (amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cos
            - 2.0 * sqrtAmplitude * alpha) / a0);
        eqA1[band] = (float) (2.0 * ((amplitude - 1.0) - (amplitude + 1.0) * cos) / a0);
        eqA2[band] = (float) (((amplitude + 1.0) - (amplitude - 1.0) * cos
            - 2.0 * sqrtAmplitude * alpha) / a0);
    }

    private void designHighpass(float frequency, float q) {
        double w0 = 2.0 * Math.PI * clampFrequency(frequency) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / (2.0 * q);
        double a0 = 1.0 + alpha;
        highpassB0 = (float) ((1.0 + cos) / 2.0 / a0);
        highpassB1 = (float) (-(1.0 + cos) / a0);
        highpassB2 = (float) ((1.0 + cos) / 2.0 / a0);
        highpassA1 = (float) (-2.0 * cos / a0);
        highpassA2 = (float) ((1.0 - alpha) / a0);
    }

    private void designLowpass(float frequency, float q) {
        double w0 = 2.0 * Math.PI * clampFrequency(frequency) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / (2.0 * q);
        double a0 = 1.0 + alpha;
        lowpassB0 = (float) ((1.0 - cos) / 2.0 / a0);
        lowpassB1 = (float) ((1.0 - cos) / a0);
        lowpassB2 = (float) ((1.0 - cos) / 2.0 / a0);
        lowpassA1 = (float) (-2.0 * cos / a0);
        lowpassA2 = (float) ((1.0 - alpha) / a0);
    }

    /** vinyl noise 的固定带通：2.6kHz、Q=0.5（与 noiseBranch 一致）。 */
    private void designNoiseBandpass() {
        double w0 = 2.0 * Math.PI * clampFrequency(NOISE_BANDPASS_HZ) / sampleRate;
        double cos = Math.cos(w0);
        double alpha = Math.sin(w0) / (2.0 * NOISE_BANDPASS_Q);
        double a0 = 1.0 + alpha;
        noiseBandB0 = (float) (alpha / a0);
        noiseBandB2 = (float) (-alpha / a0);
        noiseBandA1 = (float) (-2.0 * cos / a0);
        noiseBandA2 = (float) ((1.0 - alpha) / a0);
    }

    // =====================================================================================
    // 处理循环
    // =====================================================================================

    private void processFrames(int frames, int channels) {
        applyPendingPlan();

        int offset = 0;
        while (offset < frames) {
            int chunk = Math.min(SMOOTHING_CHUNK_FRAMES, frames - offset);
            advanceSmoothing(chunk);
            updateFlags();
            updateCoefficients();
            processChunk(offset, chunk, channels);
            offset += chunk;
        }
    }

    private void processChunk(int offset, int count, int channels) {
        boolean stereo = channels > 1;
        for (int frame = 0; frame < count; frame += 1) {
            int index = offset + frame;

            // wow 的调制是两条 LFO，两个声道共用，所以每帧算一次。
            float wowDelay = 0f;
            if (wowActive) {
                wowDelay = nextWowDelaySamples();
            }

            for (int channel = 0; channel < channels; channel += 1) {
                float sample = channelSamples[channel][index];
                if (eqActive) {
                    sample = applyEqualizer(channel, sample);
                }
                if (filterActive) {
                    sample = applyHighpass(channel, sample);
                    sample = applyLowpass(channel, sample);
                }
                if (driveActive) {
                    sample = applyDrive(sample);
                }
                if (crushActive) {
                    sample = applyBitCrush(sample);
                }
                if (wowActive) {
                    sample = applyWow(channel, sample, wowDelay);
                }
                channelSamples[channel][index] = sample;
            }

            float left = channelSamples[0][index];
            float right = stereo ? channelSamples[1][index] : left;

            if (widthActive && stereo) {
                // outL = L*direct + R*cross，outR = L*cross + R*direct；
                // 展开就是 M/S：mid = (L+R)/2，side = (L-R)/2，L' = mid + width*side。
                // 两条式子数学上完全等价，这里用 M/S 少两次乘法。
                float mid = (left + right) * 0.5f;
                float side = (left - right) * 0.5f;
                left = mid + side * smoothWidth;
                right = mid - side * smoothWidth;
            }

            if (compressorActive) {
                float gain = nextCompressorGain(Math.max(Math.abs(left), Math.abs(right)));
                left *= gain;
                right *= gain;
            }

            if (reverbActive) {
                // Web 侧 wetSend 接的是 makeup 之后的信号；这里同样在压缩 / 补偿之后取干声。
                float send = (left + right) * 0.5f;
                float wetLeft = processReverb(0, send);
                float wetRight = stereo ? processReverb(1, send) : wetLeft;
                left = left * reverbDry + wetLeft * reverbWet;
                right = right * reverbDry + wetRight * reverbWet;
            }

            if (noiseActive) {
                left += nextNoiseSample(0);
                if (stereo) {
                    right += nextNoiseSample(1);
                }
            }

            if (replayGainActive) {
                left *= smoothReplayGainLinear;
                right *= smoothReplayGainLinear;
                if (smoothReplayGainLinear > 1f) {
                    left = softLimit(left);
                    right = softLimit(right);
                }
            }

            channelSamples[0][index] = left;
            if (stereo) {
                channelSamples[1][index] = right;
            }
        }
    }

    private float applyEqualizer(int channel, float sample) {
        float[] state1 = eqState1[channel];
        float[] state2 = eqState2[channel];
        float value = sample;
        for (int band = 0; band < EQ_BANDS; band += 1) {
            float output = eqB0[band] * value + state1[band];
            state1[band] = eqB1[band] * value - eqA1[band] * output + state2[band];
            state2[band] = eqB2[band] * value - eqA2[band] * output;
            value = output;
        }
        return value;
    }

    private float applyHighpass(int channel, float sample) {
        float output = highpassB0 * sample + highpassState1[channel];
        highpassState1[channel] = highpassB1 * sample - highpassA1 * output
            + highpassState2[channel];
        highpassState2[channel] = highpassB2 * sample - highpassA2 * output;
        return output;
    }

    private float applyLowpass(int channel, float sample) {
        float output = lowpassB0 * sample + lowpassState1[channel];
        lowpassState1[channel] = lowpassB1 * sample - lowpassA1 * output
            + lowpassState2[channel];
        lowpassState2[channel] = lowpassB2 * sample - lowpassA2 * output;
        return output;
    }

    /** drive：Web 侧 tanh(shape*x)/tanh(shape) * compensation，shape = 1 + 4*drive。 */
    private float applyDrive(float sample) {
        float shaped = (float) Math.tanh(driveShape * sample) / driveScale;
        return shaped * smoothSaturationCompensation;
    }

    /** crush：Web 侧 round(x*steps)/steps 再夹到 [-1,1]。 */
    private float applyBitCrush(float sample) {
        float quantized = Math.round(sample * crushSteps) / crushSteps;
        if (quantized > 1f) {
            return 1f;
        }
        if (quantized < -1f) {
            return -1f;
        }
        return quantized;
    }

    private float nextWowDelaySamples() {
        float modulation = wowDepthSamples * (float) Math.sin(wowPhase)
            + flutterDepthSamples * (float) Math.sin(flutterPhase);
        wowPhase += wowPhaseIncrement;
        if (wowPhase > Math.PI * 2.0) {
            wowPhase -= Math.PI * 2.0;
        }
        flutterPhase += flutterPhaseIncrement;
        if (flutterPhase > Math.PI * 2.0) {
            flutterPhase -= Math.PI * 2.0;
        }
        return wowBaseSamples + modulation;
    }

    /** 分数延迟读取：线性插值。12ms 基础延迟远大于 1，读指针不会撞上刚写入的位置。 */
    private float applyWow(int channel, float sample, float delaySamples) {
        float[] buffer = wowBuffer[channel];
        int length = buffer.length;
        if (length < 2) {
            return sample;
        }
        float readPosition = wowWriteIndex[channel] - delaySamples;
        while (readPosition < 0f) {
            readPosition += length;
        }
        while (readPosition >= length) {
            readPosition -= length;
        }
        int index0 = (int) readPosition;
        if (index0 >= length) {
            index0 = 0;
        }
        int index1 = index0 + 1 >= length ? 0 : index0 + 1;
        float fraction = readPosition - index0;
        float delayed = buffer[index0] + (buffer[index1] - buffer[index0]) * fraction;
        buffer[wowWriteIndex[channel]] = sample;
        int write = wowWriteIndex[channel] + 1;
        if (write >= length) {
            write = 0;
        }
        wowWriteIndex[channel] = write;
        return delayed;
    }

    /**
     * 前馈压缩器 + makeup。
     *
     * <p>Web 侧是 {@code DynamicsCompressorNode}（内部有它自己的检波器），这里是峰值检波 +
     * 软拐点的常用实现：attack 8ms、release 180ms，阈值 / 压缩比 / 拐点 / makeup 与
     * effectChain.ts 完全一致。听感上的差别主要来自检波方式（峰值 vs RMS），已在报告里注明。
     */
    private float nextCompressorGain(float peak) {
        float envelope = peak > compressorEnvelope
            ? compressorAttackCoefficient * compressorEnvelope
                + (1f - compressorAttackCoefficient) * peak
            : compressorReleaseCoefficient * compressorEnvelope
                + (1f - compressorReleaseCoefficient) * peak;
        compressorEnvelope = envelope;

        if (envelope <= 1e-6f) {
            return (float) Math.pow(10.0, compressorMakeupDb / 20.0);
        }

        float levelDb = 20f * (float) Math.log10(envelope);
        float over = levelDb - compressorThresholdDb;
        float reductionDb;
        float halfKnee = compressorKneeDb * 0.5f;
        if (over <= -halfKnee) {
            reductionDb = 0f;
        } else if (over < halfKnee && compressorKneeDb > 1e-3f) {
            float kneePosition = over + halfKnee;
            reductionDb = (compressorSlope - 1f) * kneePosition * kneePosition
                / (2f * compressorKneeDb);
        } else {
            reductionDb = (compressorSlope - 1f) * over;
        }
        return (float) Math.pow(10.0, (reductionDb + compressorMakeupDb) / 20.0);
    }

    /**
     * 并行混响（Freeverb 结构，**近似** Web 侧的卷积）。
     *
     * <p>每声道 8 个梳状滤波器并联、4 个全通串联；梳状反馈按 RT60=2.0s 与各自延迟长度
     * 反推，使衰减时间接近 Web 侧那条 2.2s IR。输出乘一个按「梳状稳态增益之和」算出来的
     * 归一化系数，让湿声量级与 Web 的 {@code space * 0.75} 对得上。
     */
    private float processReverb(int channel, float input) {
        float[] combStore = reverbCombStore[channel];
        float output = 0f;

        float[][] combBuffers = reverbCombBuffers[channel];
        int[] combIndicesChannel = reverbCombIndices[channel];
        int combCount = combBuffers.length;
        for (int index = 0; index < combCount; index += 1) {
            float[] buffer = combBuffers[index];
            int position = combIndicesChannel[index];
            float delayed = buffer[position];
            float store = delayed * (1f - REVERB_DAMPING) + combStore[index] * REVERB_DAMPING;
            combStore[index] = store;
            buffer[position] = input * REVERB_INPUT_GAIN + store * reverbCombFeedback[index];
            position += 1;
            if (position >= buffer.length) {
                position = 0;
            }
            combIndicesChannel[index] = position;
            output += delayed;
        }

        float[][] allpassBuffers = reverbAllpassBuffers[channel];
        int[] allpassIndicesChannel = reverbAllpassIndices[channel];
        for (int index = 0; index < allpassBuffers.length; index += 1) {
            float[] buffer = allpassBuffers[index];
            int position = allpassIndicesChannel[index];
            float delayed = buffer[position];
            float allpassOut = -output + delayed;
            buffer[position] = output + delayed * 0.5f;
            position += 1;
            if (position >= buffer.length) {
                position = 0;
            }
            allpassIndicesChannel[index] = position;
            output = allpassOut;
        }

        return output * reverbTrim;
    }

    /**
     * vinyl noise：白噪 + 稀疏噼啪声，再过一个 2.6kHz 带通。
     *
     * <p>与 Web 侧 {@code createVinylNoiseBuffer} 的区别只有一处：那边是 3 秒循环缓冲，
     * 这里是实时生成（不会周期性重复），概率与衰减常数照抄。
     */
    private float nextNoiseSample(int channel) {
        float white = nextRandom(channel) * NOISE_WHITE_AMPLITUDE;
        float trigger = nextRandom(channel);
        if (trigger < NOISE_CRACKLE_PROBABILITY * 2f - 1f) {
            crackleState[channel] = nextRandom(channel);
        }
        crackleState[channel] *= NOISE_CRACKLE_DECAY;
        float noise = white + crackleState[channel] * NOISE_CRACKLE_AMPLITUDE;

        float output = noiseBandB0 * noise + noiseBandState1[channel];
        noiseBandState1[channel] = -noiseBandA1 * output + noiseBandState2[channel];
        noiseBandState2[channel] = noiseBandB2 * noise - noiseBandA2 * output;
        return output * noiseGain;
    }

    /** xorshift32：音频线程上不碰 Random 的对象分配，也不需要线程安全。 */
    private float nextRandom(int channel) {
        int state = noiseRandomState[channel];
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        noiseRandomState[channel] = state;
        return (state & 0xFFFFFF) / 8388608f - 1f;
    }

    /** 软限幅：只作用在 ReplayGain 往上推的时候，0dB 以下保持原样。 */
    private static float softLimit(float value) {
        if (value > SOFT_LIMIT_KNEE) {
            return SOFT_LIMIT_KNEE + (1f - SOFT_LIMIT_KNEE)
                * (float) Math.tanh((value - SOFT_LIMIT_KNEE) / (1f - SOFT_LIMIT_KNEE));
        }
        if (value < -SOFT_LIMIT_KNEE) {
            return -SOFT_LIMIT_KNEE - (1f - SOFT_LIMIT_KNEE)
                * (float) Math.tanh((-value - SOFT_LIMIT_KNEE) / (1f - SOFT_LIMIT_KNEE));
        }
        return value;
    }

    private static short toPcm16(float value) {
        float clamped = value;
        if (clamped > 1f) {
            clamped = 1f;
        } else if (clamped < -1f) {
            clamped = -1f;
        }
        int pcm = Math.round(clamped * 32768f);
        if (pcm > 32767) {
            pcm = 32767;
        } else if (pcm < -32768) {
            pcm = -32768;
        }
        return (short) pcm;
    }

    // =====================================================================================
    // 缓冲与状态
    // =====================================================================================

    private void copyThrough(ByteBuffer inputBuffer) {
        int remaining = inputBuffer.remaining();
        if (remaining <= 0) {
            return;
        }
        ByteBuffer outputBuffer = replaceOutputBuffer(remaining);
        outputBuffer.put(inputBuffer);
        outputBuffer.flip();
    }

    /**
     * 完全旁路：目标本身中性、平滑值也已经落在中性、ReplayGain 0dB。
     *
     * <p>「已经落定」这一条不能省：关掉均衡器的那 15ms 里参数还在往回滑，这时候逐字节直通
     * 会把还没滑完的那一截直接切断，听感上是一次咔哒。
     */
    private boolean canBypassCompletely() {
        if (!activePlan.isNeutralTargets()) {
            return false;
        }
        if (Math.abs(smoothReplayGainLinear - 1f) > 1e-6f) {
            return false;
        }
        for (int index = 0; index < EQ_BANDS; index += 1) {
            if (Math.abs(smoothGainsDb[index]) > 1e-5f) {
                return false;
            }
        }
        return Math.abs(smoothHighpass - FoliaDspSettings.NEUTRAL_HIGHPASS_HZ) <= 1e-3f
            && Math.abs(smoothLowpass - lowpassCeiling()) <= 1e-3f
            && smoothDrive <= 1e-6f
            && smoothCrush <= 1e-6f
            && smoothWow <= 1e-6f
            && smoothNoise <= 1e-6f
            && Math.abs(smoothWidth - FoliaDspSettings.NEUTRAL_WIDTH) <= 1e-6f
            && smoothSpace <= 1e-6f
            && smoothPunch <= 1e-6f;
    }

    private void ensureScratch(int frames) {
        int samples = frames * channelCount;
        if (pcmScratch.length < samples) {
            pcmScratch = new short[samples];
        }
        for (int channel = 0; channel < channelCount && channel < MAX_CHANNELS; channel += 1) {
            if (channelSamples[channel].length < frames) {
                channelSamples[channel] = new float[frames];
            }
        }
    }

    /** 采样率 / 声道数变了才重新分配：延迟线长度、混响的梳状延迟都跟采样率有关。 */
    private void allocateForFormat() {
        int wowLength = Math.max(4, Math.round(sampleRate * 0.021f) + 4);
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            wowBuffer[channel] = new float[wowLength];
        }

        int combCount = REVERB_COMB_DELAYS.length;
        int allpassCount = REVERB_ALLPASS_DELAYS.length;
        float scale = sampleRate / 44100f;
        reverbCombBuffers = new float[MAX_CHANNELS][combCount][];
        reverbCombIndices = new int[MAX_CHANNELS][combCount];
        reverbCombStore = new float[MAX_CHANNELS][combCount];
        reverbAllpassBuffers = new float[MAX_CHANNELS][allpassCount][];
        reverbAllpassIndices = new int[MAX_CHANNELS][allpassCount];
        reverbCombFeedback = new float[combCount];

        float feedbackSum = 0f;
        for (int index = 0; index < combCount; index += 1) {
            int delay = Math.max(1, Math.round(REVERB_COMB_DELAYS[index] * scale));
            // RT60 -> 每个梳状的反馈系数：g = 10^(-3 * delaySeconds / rt60)。
            float delaySeconds = delay / (float) sampleRate;
            float feedback = (float) Math.pow(10.0, -3.0 * delaySeconds / REVERB_RT60_SECONDS);
            reverbCombFeedback[index] = feedback;
            // 稳态增益（非相干叠加）用于归一化湿声，见 processReverb 的说明。
            feedbackSum += (float) (1.0 / Math.sqrt(1.0 - feedback * feedback));
            for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
                int spread = channel == 1 ? REVERB_STEREO_SPREAD : 0;
                reverbCombBuffers[channel][index] = new float[delay + spread];
            }
        }
        for (int index = 0; index < allpassCount; index += 1) {
            int delay = Math.max(1, Math.round(REVERB_ALLPASS_DELAYS[index] * scale));
            for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
                int spread = channel == 1 ? REVERB_STEREO_SPREAD : 0;
                reverbAllpassBuffers[channel][index] = new float[delay + spread];
            }
        }
        // 湿声归一化：先按「梳状稳态增益之和」把 Freeverb 抬到 0dB 量级，再乘一个标定系数，
        // 让 space=1 时的湿声 RMS 落在 Web 侧 space*0.75 的附近（实测桌面自测里总 RMS 与
        // 卷积版本相差 0.6dB 以内）。不带这个系数时湿声偏高约 2.5dB。
        reverbTrim = feedbackSum > 0f
            ? REVERB_WET_CALIBRATION / (feedbackSum * REVERB_INPUT_GAIN)
            : 1f;

        compressorAttackCoefficient = (float) Math.exp(-1.0 / (0.008 * sampleRate));
        compressorReleaseCoefficient = (float) Math.exp(-1.0 / (0.18 * sampleRate));
        designNoiseBandpass();

        wowPhaseIncrement = 2.0 * Math.PI * WOW_RATE_HZ / sampleRate;
        flutterPhaseIncrement = 2.0 * Math.PI * FLUTTER_RATE_HZ / sampleRate;

        // 先在 configure 里把常用大小的临时缓冲分配好：音频线程上的 ensureScratch 只在
        // 遇到更大 buffer 时才增长一次，正常播放（media3 一般 1k~4k 帧）不会再分配。
        int initialFrames = 4096;
        int pcmLength = initialFrames * Math.min(channelCount, MAX_CHANNELS);
        if (pcmScratch.length < pcmLength) {
            pcmScratch = new short[pcmLength];
        }
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            if (channelSamples[channel].length < initialFrames) {
                channelSamples[channel] = new float[initialFrames];
            }
        }
    }

    /** 清掉所有会「记住上一段声音」的状态：滤波器、延迟线、混响、压缩器、LFO 相位。 */
    private void resetState() {
        clearEqualizerStates();
        clearCutoffStates();
        clearWowBuffers();
        clearReverbBuffers();
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            crackleState[channel] = 0f;
            noiseBandState1[channel] = 0f;
            noiseBandState2[channel] = 0f;
            noiseRandomState[channel] = 0x9E3779B9 + channel * 0x85EBCA6B;
        }
        compressorEnvelope = 0f;
        eqWasActive = false;
        filterWasActive = false;
        wowWasActive = false;
        reverbWasActive = false;
    }

    private void clearEqualizerStates() {
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            for (int band = 0; band < EQ_BANDS; band += 1) {
                eqState1[channel][band] = 0f;
                eqState2[channel][band] = 0f;
            }
        }
    }

    private void clearCutoffStates() {
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            highpassState1[channel] = 0f;
            highpassState2[channel] = 0f;
            lowpassState1[channel] = 0f;
            lowpassState2[channel] = 0f;
        }
    }

    private void clearWowBuffers() {
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            float[] buffer = wowBuffer[channel];
            for (int position = 0; position < buffer.length; position += 1) {
                buffer[position] = 0f;
            }
            wowWriteIndex[channel] = 0;
        }
        wowPhase = 0.0;
        flutterPhase = 0.0;
    }

    private void clearReverbBuffers() {
        for (int channel = 0; channel < MAX_CHANNELS; channel += 1) {
            for (int index = 0; index < reverbCombBuffers[channel].length; index += 1) {
                float[] buffer = reverbCombBuffers[channel][index];
                for (int position = 0; position < buffer.length; position += 1) {
                    buffer[position] = 0f;
                }
                reverbCombIndices[channel][index] = 0;
                reverbCombStore[channel][index] = 0f;
            }
            for (int index = 0; index < reverbAllpassBuffers[channel].length; index += 1) {
                float[] buffer = reverbAllpassBuffers[channel][index];
                for (int position = 0; position < buffer.length; position += 1) {
                    buffer[position] = 0f;
                }
                reverbAllpassIndices[channel][index] = 0;
            }
        }
    }

    /**
     * 饱和曲线的响度补偿，逐字照搬 Web 侧 {@code measureSaturationCompensation}：
     * 用 0.5 幅度的正弦量一遍 RMS，再取参考 RMS 与它的比值。
     *
     * <p>只在 {@link #setSettings} 里算一次（插件线程），音频线程不碰。
     */
    private static float measureSaturationCompensation(float shape, float scale) {
        int cycleSamples = 1024;
        double energy = 0.0;
        for (int index = 0; index < cycleSamples; index += 1) {
            double input = 0.5 * Math.sin((2.0 * Math.PI * index) / cycleSamples);
            double shaped = Math.tanh(shape * input) / scale;
            energy += shaped * shaped;
        }
        double shapedRms = Math.sqrt(energy / cycleSamples);
        double referenceRms = 0.5 / Math.sqrt(2.0);
        return shapedRms > 0.0 ? (float) (referenceRms / shapedRms) : 1f;
    }
}

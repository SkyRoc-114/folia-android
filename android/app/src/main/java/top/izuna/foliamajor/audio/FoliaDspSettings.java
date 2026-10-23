package top.izuna.foliamajor.audio;

/**
 * 当前文件：原生播放 DSP 的不可变设置快照（10 段均衡器 + 音效链 + ReplayGain）。
 *
 * <p>字段与 Web 侧一一对应，改一处两处都要改：
 * <ul>
 *   <li>{@code src/utils/audioEqualizer.ts}：{@code enabled}、{@code gains[10]}（31/62/125/250/
 *       500/1k/2k/4k/8k/16k，±12dB）；</li>
 *   <li>{@code src/utils/audioEffects.ts}：{@code highpass(20..2000, 中性 20)}、
 *       {@code lowpass(500..20000, 中性 20000)}、{@code drive/crush/wow/noise/space/punch(0..1)}、
 *       {@code width(0..2, 中性 1)}；</li>
 *   <li>{@code replayGainDb}：全链之后的线性增益（dB，可空，默认 0），与均衡器的
 *       {@code enabled} 无关，独立生效。</li>
 * </ul>
 *
 * <p>所有数值在构造时夹紧：NaN / 无穷 / 越界一律落回中性值。这份对象只被插件线程写、
 * 音频线程整份读（见 {@link FoliaAudioProcessor#setSettings}），所以它必须是不可变的 ——
 * {@link #getGainsInternal()} 返回的数组只给同包的处理器读，不允许外部改。
 *
 * <p>范围与 Web 侧的一致：增益 ±12dB、highpass 20..2000Hz、lowpass 500..20000Hz、
 * 其余比例量 0..1（width 0..2）、ReplayGain 夹到 -24..+12dB（超过这个范围只会把
 * 输出按比例放大成削波，没有意义）。
 */
public final class FoliaDspSettings {

    /** 与 {@code AUDIO_EQUALIZER_BANDS} 一致：10 段。 */
    public static final int BAND_COUNT = 10;

    /** 与 {@code AUDIO_EQUALIZER_BANDS} 的频率一致（Hz）。 */
    public static final float[] BAND_FREQUENCIES_HZ = {
        31f, 62f, 125f, 250f, 500f, 1000f, 2000f, 4000f, 8000f, 16000f,
    };

    /** 与 {@code AUDIO_EQUALIZER_MIN_GAIN_DB} / {@code MAX_GAIN_DB} 一致。 */
    public static final float MIN_GAIN_DB = -12f;
    public static final float MAX_GAIN_DB = 12f;

    public static final float MIN_HIGHPASS_HZ = 20f;
    public static final float MAX_HIGHPASS_HZ = 2000f;
    public static final float MIN_LOWPASS_HZ = 500f;
    public static final float MAX_LOWPASS_HZ = 20000f;
    public static final float MIN_WIDTH = 0f;
    public static final float MAX_WIDTH = 2f;

    /** ReplayGain 的可用范围：再大就只是把削波推给限幅器了。 */
    public static final float MIN_REPLAY_GAIN_DB = -24f;
    public static final float MAX_REPLAY_GAIN_DB = 12f;

    /** 音效链的中性值（与 {@code DEFAULT_AUDIO_EFFECT_SETTINGS} 一致）。 */
    public static final float NEUTRAL_HIGHPASS_HZ = 20f;
    public static final float NEUTRAL_LOWPASS_HZ = 20000f;
    public static final float NEUTRAL_DRIVE = 0f;
    public static final float NEUTRAL_CRUSH = 0f;
    public static final float NEUTRAL_WOW = 0f;
    public static final float NEUTRAL_NOISE = 0f;
    public static final float NEUTRAL_WIDTH = 1f;
    public static final float NEUTRAL_SPACE = 0f;
    public static final float NEUTRAL_PUNCH = 0f;

    /**
     * 全关、全中性、ReplayGain 0dB 的一份设置。
     *
     * <p>处理器拿它当「什么都不做」的基准：目标等于它、平滑值也停在它上面时，走逐字节直通。
     */
    public static final FoliaDspSettings NEUTRAL = new FoliaDspSettings(
        false,
        new float[BAND_COUNT],
        NEUTRAL_HIGHPASS_HZ,
        NEUTRAL_LOWPASS_HZ,
        NEUTRAL_DRIVE,
        NEUTRAL_CRUSH,
        NEUTRAL_WOW,
        NEUTRAL_NOISE,
        NEUTRAL_WIDTH,
        NEUTRAL_SPACE,
        NEUTRAL_PUNCH,
        0f
    );

    private final boolean enabled;
    private final float[] gains;
    private final float highpass;
    private final float lowpass;
    private final float drive;
    private final float crush;
    private final float wow;
    private final float noise;
    private final float width;
    private final float space;
    private final float punch;
    private final float replayGainDb;

    /**
     * 一次性接收完整的一组设置。
     *
     * <p>参数顺序与插件契约一致；任何越界 / NaN 都在这里夹紧，处理器不必再判。
     */
    public FoliaDspSettings(
        boolean enabled,
        float[] gains,
        float highpass,
        float lowpass,
        float drive,
        float crush,
        float wow,
        float noise,
        float width,
        float space,
        float punch,
        float replayGainDb
    ) {
        this.enabled = enabled;
        this.gains = new float[BAND_COUNT];
        for (int index = 0; index < BAND_COUNT; index += 1) {
            this.gains[index] = clamp(
                gains != null && index < gains.length ? gains[index] : 0f,
                MIN_GAIN_DB,
                MAX_GAIN_DB,
                0f
            );
        }
        this.highpass = clamp(highpass, MIN_HIGHPASS_HZ, MAX_HIGHPASS_HZ, NEUTRAL_HIGHPASS_HZ);
        this.lowpass = clamp(lowpass, MIN_LOWPASS_HZ, MAX_LOWPASS_HZ, NEUTRAL_LOWPASS_HZ);
        this.drive = clamp(drive, 0f, 1f, NEUTRAL_DRIVE);
        this.crush = clamp(crush, 0f, 1f, NEUTRAL_CRUSH);
        this.wow = clamp(wow, 0f, 1f, NEUTRAL_WOW);
        this.noise = clamp(noise, 0f, 1f, NEUTRAL_NOISE);
        this.width = clamp(width, MIN_WIDTH, MAX_WIDTH, NEUTRAL_WIDTH);
        this.space = clamp(space, 0f, 1f, NEUTRAL_SPACE);
        this.punch = clamp(punch, 0f, 1f, NEUTRAL_PUNCH);
        this.replayGainDb = clamp(replayGainDb, MIN_REPLAY_GAIN_DB, MAX_REPLAY_GAIN_DB, 0f);
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** 第 {@code index} 段的目标增益（dB）。 */
    public float getGain(int index) {
        return index >= 0 && index < BAND_COUNT ? gains[index] : 0f;
    }

    public float getHighpass() {
        return highpass;
    }

    public float getLowpass() {
        return lowpass;
    }

    public float getDrive() {
        return drive;
    }

    public float getCrush() {
        return crush;
    }

    public float getWow() {
        return wow;
    }

    public float getNoise() {
        return noise;
    }

    public float getWidth() {
        return width;
    }

    public float getSpace() {
        return space;
    }

    public float getPunch() {
        return punch;
    }

    public float getReplayGainDb() {
        return replayGainDb;
    }

    /**
     * 内部数组，只给 {@link FoliaAudioProcessor} 读（同包）。
     *
     * <p>不做拷贝是有意的：每帧都要读一次，复制数组会变成音频线程上的垃圾来源。
     * 约定是这个数组在构造之后谁都不改。
     */
    float[] getGainsInternal() {
        return gains;
    }

    private static float clamp(float value, float min, float max, float fallback) {
        if (Float.isNaN(value) || Float.isInfinite(value)) {
            return fallback;
        }
        if (value < min) {
            return min;
        }
        if (value > max) {
            return max;
        }
        return value;
    }
}

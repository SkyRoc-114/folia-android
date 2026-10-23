package top.izuna.foliamajor.audio;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

/**
 * 当前文件：把 {@link FoliaAudioProcessor} 挂进 ExoPlayer 音频输出的 RenderersFactory。
 *
 * <p>为什么必须从这里挂：均衡器 / 音效要在**解码之后、写 AudioTrack 之前**处理，唯一稳定的
 * 位置是 {@code DefaultAudioSink} 的 AudioProcessor 链。{@link FoliaNativePlayer} 用它建
 * ExoPlayer，于是同一条链上还留着 media3 自己的处理器：
 *
 * <ul>
 *   <li>{@code ToInt16PcmAudioProcessor} —— 在用户处理器**之前**，把 float / 24-bit 解码结果
 *       压成 16-bit（因为这里 {@code setEnableFloatOutput(false)}），所以 DSP 拿到的永远是
 *       16-bit；</li>
 *   <li>{@code SilenceSkippingAudioProcessor} 与 {@code SonicAudioProcessor} —— 在用户处理器
 *       之后，静音跳过和倍速照旧由 media3 负责，不会因为换了处理器链而失效。</li>
 * </ul>
 *
 * <p>⚠️ 这里**故意**忽略父类传进来的 {@code enableFloatOutput}：float 输出意味着
 * AudioTrack 吃 float，而 {@link FoliaAudioProcessor} 只处理 16-bit PCM。固定 16-bit
 * 输出的代价是理论上的动态范围（16-bit ≈ 96dB，对播放已经够），换来的是处理器链的行为
 * 确定、不用为两种采样格式各写一遍 DSP。
 *
 * <p>频谱不受影响：{@code Visualizer} 用的是 ExoPlayer 的 audioSessionId
 * （{@code getAudioSessionId()}），AudioProcessor 只在 AudioTrack 的写入路径上加处理，
 * 不会换掉 session，也不会改 {@code NativeAudioSpectrumTap} 的采集方式。
 */
@UnstableApi
public final class FoliaRenderersFactory extends DefaultRenderersFactory {

    private final AudioProcessor dsp;

    public FoliaRenderersFactory(@NonNull Context context, @NonNull AudioProcessor dsp) {
        super(context);
        this.dsp = dsp;
    }

    /**
     * 建 sink 时把 DSP 处理器插进链里。
     *
     * <p>{@code setEnableAudioTrackPlaybackParams} 原样透传父类的决定：true 时倍速交给
     * AudioTrack 的 PlaybackParams，false 时由链上的 SonicAudioProcessor 做时间伸缩 ——
     * 两种都成立，因为没有把默认处理器链整个换掉（{@code setAudioProcessors} 只替换
     * 「用户处理器」那一段，media3 会把静音跳过与 Sonic 接在后面）。
     */
    @Override
    // media3 1.11 把 setEnableAudioTrackPlaybackParams 标成废弃，但它是
    // setEnableAudioOutputPlaybackParameters 的别名（字节码就是直接转调），语义没变。
    // 这里按要求保留原名，避免读代码的人以为倍速行为被换掉了。
    @SuppressWarnings("deprecation")
    protected AudioSink buildAudioSink(
        Context context,
        boolean enableFloatOutput,
        boolean enableAudioTrackPlaybackParams
    ) {
        return new DefaultAudioSink.Builder(context)
            .setAudioProcessors(new AudioProcessor[]{dsp})
            .setEnableFloatOutput(false)
            .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
            .build();
    }
}

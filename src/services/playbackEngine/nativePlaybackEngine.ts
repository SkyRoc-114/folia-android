import { audioBands, audioPower } from '../../stores/motionSignals';
import {
    nativePlayer,
    type NativeAudioBands,
    type NativePlaybackEvent,
    type NativePlayerEvent,
    type NativeSpectrumEvent,
} from './nativePlayerPlugin';

// src/services/playbackEngine/nativePlaybackEngine.ts
//
// 原生播放内核在 Web 侧的那一半：一个进程里只有一个播放器，所以这里是单例。
//
// 时钟是这里最容易做错的地方。原生播放器不会给逐帧位置 —— 它把 `position` 过桥降频到
// 500ms 一档（Java 的 WEB_NOTIFY_INTERVAL_MS），而歌词、进度条都是按帧读的。所以位置要按
// 本地墙钟插值补出来：
//
//     真实位置 ≈ 最后一次上报的位置 + (现在 − 那次上报的时刻) × 倍速
//
// 绝不反过来做「Web 侧每秒调 getSnapshot 问一次」：Capacitor 的桥只有一条，轮询会和批量
// 拉取那些操作抢同一条通道。
//
// 夹在 duration 之内：缓冲、切歌之后插出来的值可能越过结尾，进度条冲到 4:07 再弹回来很难看。
// 只进不退（带 MAX_LEAD 上限）：位置采样本身会滞后，暂停/缓冲事件又会让插值那一截凭空消失，
// 直接给原始采样就是「歌词往回抽一下又恢复」。
//
// 频谱事件只写 MotionValue，不经过 React state：`audioBands` 与 `audioPower` 是可视化、频谱
// 与智能动感的唯一数据源，走 state 等于按事件频率重渲染整棵树。

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** 原生 `Visualizer` 的频谱带宽：与 `audioBands.spectrum` 的消费方约定一致。 */
export const NATIVE_SPECTRUM_BINS = 128;

/** 原生端口：测试注入假实现，生产就是 Capacitor 插件。 */
export interface NativePlayerPort {
    prepare(options: {
        url: string;
        startPositionMs?: number | null;
        repeatMode?: number | null;
    }): Promise<unknown>;
    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    setVolume(volume: number): Promise<void>;
    setSpeed(speed: number): Promise<void>;
    setSpectrumEnabled(enabled: boolean): Promise<void>;
    release(): Promise<void>;
    addListener(listener: (event: NativePlayerEvent) => void): Promise<{ remove(): Promise<void> | void }>;
}

const defaultPort: NativePlayerPort = {
    prepare: options => nativePlayer.prepare(options),
    play: () => nativePlayer.play(),
    pause: () => nativePlayer.pause(),
    stop: () => nativePlayer.stop(),
    seek: positionMs => nativePlayer.seek(positionMs),
    setVolume: volume => nativePlayer.setVolume(volume),
    setSpeed: speed => nativePlayer.setSpeed(speed),
    setSpectrumEnabled: enabled => nativePlayer.setSpectrumEnabled(enabled),
    release: () => nativePlayer.release(),
    addListener: listener => nativePlayer.addListener(listener),
};

export type NativeFallbackRecord = {
    reason: string;
    at: number;
    url: string | null;
};

export type NativeSpectrumDiagnostics = {
    enabled: boolean;
    events: number;
    lastAt: number | null;
    lastLength: number;
    lastSampleRate: number | null;
    lastBands: NativeAudioBands | null;
    /** 最近一个统计窗口内的每秒事件数。 */
    ratePerSec: number;
};

export type NativePlaybackDiagnostics = {
    hasSource: boolean;
    playing: boolean;
    url: string | null;
    positionSec: number;
    durationSec: number;
    volume: number;
    rate: number;
    takeovers: number;
    fallbacks: number;
    lastFallbackReason: string | null;
    fallbackReasons: NativeFallbackRecord[];
    lastEventType: string | null;
    lastEventAt: number | null;
    recentEvents: { type: string; at: number }[];
    positionEvents: number;
    positionIntervalAvgMs: number | null;
    positionIntervalMinMs: number | null;
    positionIntervalMaxMs: number | null;
    spectrum: NativeSpectrumDiagnostics;
    spectrumEnableOn: number;
    spectrumEnableOff: number;
    /** 最近 60 秒里的开关请求数：真机上「谁在反复开关」看这个。 */
    spectrumEnableRecent: number;
    spectrumEnabledAt: number | null;
    lastError: string | null;
    commandCount: number;
    lastCommand: string | null;
    lastCommandAt: number | null;
    decision: { takes: boolean; reason: string | null; url: string | null; at: number } | null;
};

/**
 * 频谱量纲：**Java 侧契约固定为 0..255 的整数**（NativeAudioSpectrumTap 已经把 Visualizer
 * 的线性幅度按 dB 参考映射过了）。这里只做夹取，不再做「峰值小就乘 255」的猜测：
 * 近静音段落里恰好只有一个 1 时，那种启发式会把它放大成 255，静音反而画出一根满格柱子。
 */
const toLevel = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return clamp(parsed, 0, 255);
};

/**
 * 频谱量纲归一化：原生如果给 0..1 就乘 255；已经是 0..255 就原样用。
 *
 * 判据是整条事件的最大值而不是逐值判断 —— 安静段落的 0.8（0..255 量纲）逐值判断会被放大 255 倍。
 */
export const normalizeNativeSpectrum = (
    event: Pick<NativeSpectrumEvent, 'bands' | 'spectrum'>,
): { bands: NativeAudioBands; spectrum: Uint8Array } => {
    const rawBands = event.bands ?? { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 0 };
    const rawSpectrum = Array.isArray(event.spectrum) ? event.spectrum : [];
    const spectrum = new Uint8Array(rawSpectrum.length);
    for (let index = 0; index < rawSpectrum.length; index += 1) {
        spectrum[index] = Math.round(toLevel(rawSpectrum[index]));
    }
    return {
        bands: {
            bass: toLevel(rawBands.bass),
            lowMid: toLevel(rawBands.lowMid),
            mid: toLevel(rawBands.mid),
            vocal: toLevel(rawBands.vocal),
            treble: toLevel(rawBands.treble),
            power: toLevel(rawBands.power),
        },
        spectrum,
    };
};

class NativePlaybackEngine {
    private positionMs = 0;
    private durationMs = 0;
    private playing = false;
    private hasSource = false;
    private rate = 1;
    private updatedAtMs = 0;
    /**
     * 上一次对外给过的位置（毫秒）。只进不退，最多比原始采样领先 MAX_LEAD_MS。
     */
    private lastDeliveredMs = 0;
    private repeatMode = 0;
    private volume = 1;
    private currentUrl: string | null = null;
    private listeners = new Set<(event: NativePlayerEvent) => void>();
    private subscriptionStarted = false;
    private subscriptionHandle: { remove(): Promise<void> | void } | null = null;

    // ---- 诊断计数（不参与播放逻辑，只给「复制诊断数据」和小节日志用） ----
    private takeovers = 0;
    private fallbacks = 0;
    private fallbackReasons: NativeFallbackRecord[] = [];
    private lastFallbackReason: string | null = null;
    private lastFallbackLogKey = '';
    private lastEventType: string | null = null;
    private lastEventAt: number | null = null;
    private recentEvents: { type: string; at: number }[] = [];
    private positionEvents = 0;
    private positionTimestamps: number[] = [];
    private spectrumEvents = 0;
    private spectrumTimestamps: number[] = [];
    private spectrumLastAt: number | null = null;
    private spectrumLastLength = 0;
    private spectrumLastSampleRate: number | null = null;
    private spectrumLastBands: NativeAudioBands | null = null;
    private spectrumBuffer = new Uint8Array(NATIVE_SPECTRUM_BINS);
    private spectrumEnabled = false;
    private spectrumEnableOn = 0;
    private spectrumEnableOff = 0;
    private spectrumEnableTimestamps: number[] = [];
    private spectrumEnabledAt: number | null = null;
    private lastError: string | null = null;
    private commandCount = 0;
    private lastCommand: string | null = null;
    private lastCommandAt: number | null = null;
    private decision: NativePlaybackDiagnostics['decision'] = null;
    /** 最近一次 stop() 时手上停留的位置（秒），回落交接给 <audio> 时用来续播。 */
    private stoppedPositionSec = 0;

    /**
     * 插值出来的领先最多允许多少：采样滞后时的缓冲空间，也是假领先的上限。
     *
     * 必须大于 Java 的位置过桥间隔（`WEB_NOTIFY_INTERVAL_MS` = 500ms）：两次采样之间要靠
     * 这里插值顶着，上限比间隔还小的话位置会被夹住、进度条与歌词走走停停。多给 200ms 吃抖动。
     */
    private static readonly MAX_LEAD_MS = 700;
    constructor(
        private readonly port: NativePlayerPort = defaultPort,
        private readonly now: () => number = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
    ) { }

    /**
     * 这个地址能不能交给原生。
     *
     * `blob:` 不行 —— 那是 WebView 自己造的对象 URL（本地歌、以及媒体缓存副本），原生进程
     * 根本看不到它。`data:` 同理。遇到这种地址整首回落到 `<audio>`。
     */
    supports(url: string | null | undefined): boolean {
        if (!url) return false;
        if (url.startsWith('blob:')) return false;
        if (url.startsWith('data:')) return false;
        return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('content://') || url.startsWith('file://');
    }

    /** 当前是不是由原生在播（用来决定进度条走哪条时钟）。 */
    activeUrl(): string | null {
        return this.hasSource ? this.currentUrl : null;
    }

    /** 原生手上有没有歌（不论在不在播）。进度条与歌词看这个，不看 isPlaying。 */
    ownsPlayback(): boolean {
        return this.hasSource;
    }

    isPlaying(): boolean {
        return this.hasSource && this.playing;
    }

    getVolume(): number {
        return this.volume;
    }

    /** 插值后的当前位置（秒）。没有源时给 0。 */
    getPositionSec(): number {
        if (!this.hasSource) return 0;
        const raw = this.playing
            ? this.positionMs + Math.max(0, this.now() - this.updatedAtMs) * this.rate
            : this.positionMs;
        const upper = this.durationMs > 0
            ? Math.min(this.positionMs + NativePlaybackEngine.MAX_LEAD_MS, this.durationMs)
            : this.positionMs + NativePlaybackEngine.MAX_LEAD_MS;
        // 不许往回走，也不许把假的领先越攒越多。
        const delivered = Math.min(Math.max(raw, this.lastDeliveredMs), Math.max(upper, this.positionMs));
        this.lastDeliveredMs = Math.max(0, delivered);
        return this.lastDeliveredMs / 1000;
    }

    getDurationSec(): number {
        return this.durationMs > 0 ? this.durationMs / 1000 : 0;
    }

    /** 最近一次 stop() 时的位置（秒）：回落网页路径时从这里续。 */
    lastStoppedPositionSec(): number {
        return this.stoppedPositionSec;
    }

    getLatestBands(): NativeAudioBands | null {
        return this.spectrumLastBands;
    }

    async setSource(url: string, options: { startPositionMs?: number | null; repeatMode?: number } = {}): Promise<void> {
        this.ensureSubscription();
        this.currentUrl = url;
        this.hasSource = true;
        this.playing = false;
        this.positionMs = Math.max(0, options.startPositionMs ?? 0);
        this.durationMs = 0;
        this.updatedAtMs = this.now();
        this.lastDeliveredMs = this.positionMs;
        if (typeof options.repeatMode === 'number') this.repeatMode = options.repeatMode;
        this.noteCommand('prepare');
        await this.port.prepare({
            url,
            startPositionMs: options.startPositionMs ?? null,
            repeatMode: this.repeatMode,
        });
        this.noteCommand('setVolume');
        await this.port.setVolume(this.volume);
    }

    async play(): Promise<void> {
        this.noteCommand('play');
        await this.port.play();
        // 播放意图先记下：等 `playing` 事件回来之前，进度条不该停在原地不动。
        this.playing = true;
        this.updatedAtMs = this.now();
    }

    async pause(): Promise<void> {
        this.noteCommand('pause');
        await this.port.pause();
        this.playing = false;
        this.updatedAtMs = this.now();
    }

    async seek(seconds: number): Promise<void> {
        const targetMs = Math.max(0, Math.round(seconds * 1000));
        this.positionMs = targetMs;
        this.updatedAtMs = this.now();
        // 跳是唯一允许「往回走」的动作，所以这里必须把只进不退的基准一起复位。
        this.lastDeliveredMs = targetMs;
        this.noteCommand('seek');
        await this.port.seek(targetMs);
    }

    async stop(): Promise<void> {
        this.stoppedPositionSec = this.getPositionSec();
        this.hasSource = false;
        this.playing = false;
        this.positionMs = 0;
        this.durationMs = 0;
        this.lastDeliveredMs = 0;
        this.currentUrl = null;
        this.setSpectrumEnabled(false);
        this.noteCommand('stop');
        await this.port.stop();
    }

    /**
     * 音量写回原生。`immediate` 给淡入淡出用（每一步都要真的落到桥那头）；
     * 普通音量拖动按 60ms 合并，避免指针移动频率把桥塞满。
     */
    setVolume(volume: number, options: { immediate?: boolean } = {}): void {
        this.volume = clamp(volume, 0, 1);
        if (!this.hasSource) return;
        if (options.immediate) {
            this.flushVolume();
            return;
        }
        this.scheduleVolume();
    }

    private volumeTimer: ReturnType<typeof setTimeout> | null = null;
    private lastVolumeSentAt = 0;

    private scheduleVolume(): void {
        const elapsed = this.now() - this.lastVolumeSentAt;
        if (elapsed >= 60) {
            this.flushVolume();
            return;
        }
        if (this.volumeTimer !== null) return;
        this.volumeTimer = setTimeout(() => {
            this.volumeTimer = null;
            this.flushVolume();
        }, Math.max(0, 60 - elapsed));
    }

    private flushVolume(): void {
        if (this.volumeTimer !== null) {
            clearTimeout(this.volumeTimer);
            this.volumeTimer = null;
        }
        this.lastVolumeSentAt = this.now();
        this.noteCommand('setVolume');
        void this.port.setVolume(this.volume).catch(() => undefined);
    }

    setSpeed(speed: number): void {
        this.rate = clamp(speed, 0.1, 4);
        if (!this.hasSource) return;
        this.noteCommand('setSpeed');
        void this.port.setSpeed(this.rate).catch(() => undefined);
    }

    setRepeatMode(repeatMode: number): void {
        // 只记下来：下一次 prepare 会带上它。已经在播的这一首不重新装地址 —— 那会把当前这一首从头再来一遍。
        this.repeatMode = repeatMode;
    }

    /**
     * 频谱开关。原生播放且页面可见且真的要频谱时才开；暂停、停止、切后台立刻关。
     * 调用次数进诊断：真机上「谁在反复开关」比「有没有开」更有用。
     */
    setSpectrumEnabled(enabled: boolean): void {
        const next = Boolean(enabled) && this.hasSource;
        if (next === this.spectrumEnabled) return;
        this.spectrumEnabled = next;
        this.spectrumEnabledAt = this.now();
        this.spectrumEnableTimestamps.push(this.spectrumEnabledAt);
        if (this.spectrumEnableTimestamps.length > 30) this.spectrumEnableTimestamps.shift();
        if (next) this.spectrumEnableOn += 1;
        else this.spectrumEnableOff += 1;
        this.noteCommand(`setSpectrumEnabled(${next})`);
        void this.port.setSpectrumEnabled(next).catch(() => undefined);
    }

    isSpectrumEnabled(): boolean {
        return this.spectrumEnabled;
    }

    subscribe(listener: (event: NativePlayerEvent) => void): () => void {
        this.listeners.add(listener);
        this.ensureSubscription();
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 原生接管了这一首（诊断用；同一首重复调用只计一次由调用方保证）。 */
    noteTakeover(url: string | null): void {
        this.takeovers += 1;
        this.decision = { takes: true, reason: null, url, at: this.now() };
        console.info('[NativePlayer] 接管这一首', url?.slice(0, 24) ?? '(none)');
    }

    /** 这一首回落到 `<audio>` 的原因（诊断用；同一首同一原因只记一次）。 */
    noteFallback(reason: string, url: string | null): void {
        this.decision = { takes: false, reason, url, at: this.now() };
        const key = `${reason}|${url ?? ''}`;
        if (key === this.lastFallbackLogKey) return;
        this.lastFallbackLogKey = key;
        this.fallbacks += 1;
        this.lastFallbackReason = reason;
        this.fallbackReasons.push({ reason, at: this.now(), url });
        if (this.fallbackReasons.length > 8) this.fallbackReasons.shift();
        console.info(`[NativePlayer] 回落：${reason}`);
    }

    noteDecision(takes: boolean, reason: string | null, url: string | null): void {
        this.decision = { takes, reason, url, at: this.now() };
    }

    private noteCommand(command: string): void {
        this.commandCount += 1;
        this.lastCommand = command;
        this.lastCommandAt = this.now();
    }

    private ensureSubscription(): void {
        if (this.subscriptionStarted) return;
        this.subscriptionStarted = true;
        void this.port.addListener(event => {
            this.apply(event);
            this.listeners.forEach(listener => listener(event));
        })
            .then(handle => {
                this.subscriptionHandle = handle;
            })
            .catch(() => undefined);
    }

    /** 只给测试/卸载用。 */
    async dispose(): Promise<void> {
        this.listeners.clear();
        try {
            await this.subscriptionHandle?.remove();
        } catch {
            // 插件不在时 remove 也会失败：收尾动作，吞掉。
        }
        this.subscriptionHandle = null;
        this.subscriptionStarted = false;
    }

    private apply(event: NativePlayerEvent): void {
        const now = this.now();
        this.lastEventType = event.type;
        this.lastEventAt = now;
        this.recentEvents.push({ type: event.type, at: now });
        if (this.recentEvents.length > 12) this.recentEvents.shift();

        if (event.type === 'spectrum') {
            this.applySpectrum(event as NativeSpectrumEvent, now);
            return;
        }

        const playback = event as NativePlaybackEvent;
        if (typeof playback.positionMs === 'number') {
            const nextPosition = Math.max(0, playback.positionMs);
            /*
             * 回退超过 1 秒只可能是播放器自己跳了：单曲循环回到开头，或者原生侧 seek。
             * 那种情况下「只进不退」的基准必须一起复位，否则进度条会卡在结尾不动。
             * 250ms 采样之间的正常抖动（暂停/缓冲）在 1 秒以内，仍由夹子挡住。
             */
            if (nextPosition + 1_000 < this.positionMs) {
                this.lastDeliveredMs = nextPosition;
            }
            this.positionMs = nextPosition;
            this.updatedAtMs = now;
            this.positionEvents += 1;
            this.positionTimestamps.push(now);
            if (this.positionTimestamps.length > 40) this.positionTimestamps.shift();
        }
        if (typeof playback.durationMs === 'number' && playback.durationMs > 0) {
            this.durationMs = playback.durationMs;
        }
        switch (playback.type) {
            case 'playing':
                this.playing = true;
                this.updatedAtMs = now;
                break;
            case 'paused':
            case 'ended':
            case 'idle':
                this.playing = false;
                break;
            case 'error':
                this.playing = false;
                this.lastError = playback.message ?? 'unknown';
                console.error('[NativePlayer] player error', playback.message);
                break;
            case 'buffering':
                /*
                 * 缓冲期间播放器的 isPlaying 会翻成 false。但歌并没有停 —— 这里跟着置 false，
                 * 进度条就停在原地、歌词不动，等缓冲结束再猛地跳一段。所以缓冲不改这个标记。
                 */
                break;
            default:
                break;
        }
    }

    private applySpectrum(event: NativeSpectrumEvent, now: number): void {
        const { bands, spectrum } = normalizeNativeSpectrum(event);
        this.spectrumEvents += 1;
        this.spectrumTimestamps.push(now);
        if (this.spectrumTimestamps.length > 60) this.spectrumTimestamps.shift();
        this.spectrumLastAt = now;
        this.spectrumLastLength = spectrum.length;
        this.spectrumLastBands = bands;
        if (typeof event.sampleRate === 'number' && Number.isFinite(event.sampleRate)) {
            this.spectrumLastSampleRate = event.sampleRate;
        }

        // 直接写 MotionValue：可视化、频谱、智能动感都从这里读，不经过 React。
        audioBands.bass.set(bands.bass);
        audioBands.lowMid.set(bands.lowMid);
        audioBands.mid.set(bands.mid);
        audioBands.vocal.set(bands.vocal);
        audioBands.treble.set(bands.treble);
        audioPower.set(bands.power);
        if (spectrum.length > 0) {
            if (this.spectrumBuffer.length !== spectrum.length) {
                this.spectrumBuffer = new Uint8Array(spectrum.length);
            }
            this.spectrumBuffer.set(spectrum);
            audioBands.spectrum.set(this.spectrumBuffer);
        }
    }

    private intervalStats(timestamps: readonly number[]): { avg: number | null; min: number | null; max: number | null } {
        if (timestamps.length < 2) return { avg: null, min: null, max: null };
        let total = 0;
        let min = Number.POSITIVE_INFINITY;
        let max = 0;
        for (let index = 1; index < timestamps.length; index += 1) {
            const gap = timestamps[index] - timestamps[index - 1];
            total += gap;
            if (gap < min) min = gap;
            if (gap > max) max = gap;
        }
        return { avg: total / (timestamps.length - 1), min, max };
    }

    getDiagnostics(): NativePlaybackDiagnostics {
        const position = this.intervalStats(this.positionTimestamps);
        const spectrum = this.intervalStats(this.spectrumTimestamps);
        const spectrumWindow = this.spectrumTimestamps.length >= 2
            ? (this.spectrumTimestamps[this.spectrumTimestamps.length - 1] - this.spectrumTimestamps[0]) / 1000
            : 0;
        // 关掉频谱三秒后速率读 0：报告里「开了但没数据」和「刚关掉」要分得开。
        const spectrumStale = this.spectrumLastAt === null || this.now() - this.spectrumLastAt > 3_000;
        return {
            hasSource: this.hasSource,
            playing: this.playing,
            url: this.currentUrl,
            positionSec: this.getPositionSec(),
            durationSec: this.getDurationSec(),
            volume: this.volume,
            rate: this.rate,
            takeovers: this.takeovers,
            fallbacks: this.fallbacks,
            lastFallbackReason: this.lastFallbackReason,
            fallbackReasons: [...this.fallbackReasons],
            lastEventType: this.lastEventType,
            lastEventAt: this.lastEventAt,
            recentEvents: [...this.recentEvents],
            positionEvents: this.positionEvents,
            positionIntervalAvgMs: position.avg,
            positionIntervalMinMs: position.min,
            positionIntervalMaxMs: position.max,
            spectrum: {
                enabled: this.spectrumEnabled,
                events: this.spectrumEvents,
                lastAt: this.spectrumLastAt,
                lastLength: this.spectrumLastLength,
                lastSampleRate: this.spectrumLastSampleRate,
                lastBands: this.spectrumLastBands,
                ratePerSec: spectrumStale
                    ? 0
                    : (spectrum.avg && spectrum.avg > 0
                        ? 1000 / spectrum.avg
                        : (spectrumWindow > 0 ? (this.spectrumTimestamps.length - 1) / spectrumWindow : 0)),
            },
            spectrumEnableOn: this.spectrumEnableOn,
            spectrumEnableOff: this.spectrumEnableOff,
            spectrumEnableRecent: this.spectrumEnableTimestamps.filter(at => this.now() - at <= 60_000).length,
            spectrumEnabledAt: this.spectrumEnabledAt,
            lastError: this.lastError,
            commandCount: this.commandCount,
            lastCommand: this.lastCommand,
            lastCommandAt: this.lastCommandAt,
            decision: this.decision,
        };
    }
}

export { NativePlaybackEngine };

export const nativePlaybackEngine = new NativePlaybackEngine();

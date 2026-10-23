import { describe, expect, it, vi } from 'vitest';
import { NativePlaybackEngine, type NativePlayerPort } from '@/services/playbackEngine/nativePlaybackEngine';
import type { NativePlayerEvent } from '@/services/playbackEngine/nativePlayerPlugin';
import { audioBands, audioPower } from '@/stores/motionSignals';

// test/unit/playbackEngine/nativePlaybackEngine.test.ts
// 原生播放内核的三件容易做错的事 + 频谱写入：
//   · 位置按本地墙钟插值（原生只每 250ms 推一次采样）
//   · 只进不退（暂停/缓冲会让插值那一截凭空消失，直接给采样就是歌词回抽）
//   · 夹在 duration 之内（缓冲后插值越过结尾，进度条冲到 4:07 再弹回来）
//   · spectrum 事件直接写 audioBands / audioPower，不经过 React
// 时钟与插件都是注入的：不依赖真实 Capacitor，也不需要真的等 250ms。

type FakePort = {
    port: NativePlayerPort;
    emit: (event: NativePlayerEvent) => void;
    setSpectrum: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
};

const createFakePort = (): FakePort => {
    let listener: ((event: NativePlayerEvent) => void) | null = null;
    const prepare = vi.fn(async () => ({ ok: true }));
    const setSpectrum = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const port: NativePlayerPort = {
        prepare,
        play: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        seek: vi.fn(async () => undefined),
        setVolume: vi.fn(async () => undefined),
        setSpeed: vi.fn(async () => undefined),
        setSpectrumEnabled: setSpectrum,
        release,
        addListener: vi.fn(async (next: (event: NativePlayerEvent) => void) => {
            listener = next;
            return { remove: async () => undefined };
        }),
    };
    return { port, emit: event => listener?.(event), setSpectrum, prepare, release };
};

const createEngine = () => {
    const fake = createFakePort();
    let now = 0;
    const engine = new NativePlaybackEngine(fake.port, () => now);
    return {
        engine,
        ...fake,
        setNow: (value: number) => {
            now = value;
        },
        advance: (ms: number) => {
            now += ms;
        },
    };
};

const spectrumEvent = (overrides: Record<string, unknown> = {}) => ({
    type: 'spectrum' as const,
    bands: { bass: 200, lowMid: 120, mid: 80, vocal: 40, treble: 30, power: 160 },
    spectrum: Array.from({ length: 128 }, (_, index) => index),
    sampleRate: 44_100,
    ...overrides,
});

describe('native playback engine clock', () => {
    it('interpolates the position on the wall clock while playing', async () => {
        const { engine, emit, setNow, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        setNow(0);
        emit({ type: 'position', positionMs: 1_000, durationMs: 180_000 });

        expect(engine.getPositionSec()).toBe(1);
        advance(300);
        expect(engine.getPositionSec()).toBeCloseTo(1.3, 3);
        // 同一帧内重复读不会自己往前走。
        expect(engine.getPositionSec()).toBeCloseTo(1.3, 3);
        // 采样没跟上时插值最多领先 700ms：假领先不会无限攒下去。
        advance(2_000);
        expect(engine.getPositionSec()).toBe(1.7);
    });

    it('freezes the clock while paused and never goes backwards', async () => {
        const { engine, emit, setNow, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        setNow(0);
        emit({ type: 'position', positionMs: 5_000, durationMs: 180_000 });
        advance(100);

        const beforePause = engine.getPositionSec();
        expect(beforePause).toBeCloseTo(5.1, 3);
        emit({ type: 'paused' });
        advance(5_000);
        expect(engine.getPositionSec()).toBeCloseTo(5.1, 3);

        // 暂停后原生又推来一条更旧的采样：只进不退的夹子把它挡住。
        emit({ type: 'position', positionMs: 4_800, durationMs: 180_000 });
        expect(engine.getPositionSec()).toBeCloseTo(5.1, 3);
    });

    it('clamps the interpolated position to the duration', async () => {
        const { engine, emit, setNow, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        setNow(0);
        emit({ type: 'position', positionMs: 5_900, durationMs: 6_000 });
        advance(1_000);

        expect(engine.getDurationSec()).toBe(6);
        expect(engine.getPositionSec()).toBe(6);
    });

    it('resets the monotonic baseline on seek', async () => {
        const { engine, emit, setNow, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        setNow(0);
        emit({ type: 'position', positionMs: 5_000, durationMs: 180_000 });
        advance(500);
        expect(engine.getPositionSec()).toBeCloseTo(5.5, 3);

        await engine.seek(2);
        expect(engine.getPositionSec()).toBe(2);
        advance(300);
        expect(engine.getPositionSec()).toBeCloseTo(2.3, 3);
    });

    it('lets the clock restart when the player itself jumps back (single loop)', async () => {
        const { engine, emit, setNow, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        setNow(0);
        emit({ type: 'position', positionMs: 178_000, durationMs: 180_000 });
        advance(500);
        expect(engine.getPositionSec()).toBeCloseTo(178.5, 3);

        // 单曲循环：原生把位置放回开头。只进不退的基准跟着复位，进度条才会重新走。
        setNow(1_000);
        emit({ type: 'position', positionMs: 0, durationMs: 180_000 });
        expect(engine.getPositionSec()).toBe(0);
        advance(250);
        expect(engine.getPositionSec()).toBeCloseTo(0.25, 3);
    });

    it('starts from the position a web deck was handing over', async () => {
        const { engine, prepare } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3', { startPositionMs: 42_000 });

        expect(prepare).toHaveBeenCalledWith({
            url: 'https://cdn.example.test/a.mp3',
            startPositionMs: 42_000,
            repeatMode: 0,
        });
        expect(engine.getPositionSec()).toBe(42);
    });

    it('reports whether a source can be handed to the native player', () => {
        const { engine } = createEngine();

        expect(engine.supports('https://cdn.example.test/a.mp3')).toBe(true);
        expect(engine.supports('content://media/external/audio/1')).toBe(true);
        expect(engine.supports('blob:https://app.test/1')).toBe(false);
        expect(engine.supports('data:audio/mpeg;base64,AA')).toBe(false);
        expect(engine.supports(null)).toBe(false);
    });
});

describe('native spectrum into audioBands', () => {
    it('writes the bands straight into the motion values', async () => {
        const { engine, emit } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit(spectrumEvent());

        expect(audioBands.bass.get()).toBe(200);
        expect(audioBands.lowMid.get()).toBe(120);
        expect(audioBands.mid.get()).toBe(80);
        expect(audioBands.vocal.get()).toBe(40);
        expect(audioBands.treble.get()).toBe(30);
        expect(audioPower.get()).toBe(160);
        const spectrum = audioBands.spectrum.get();
        expect(spectrum.length).toBe(128);
        expect(spectrum[0]).toBe(0);
        expect(spectrum[127]).toBe(127);
        expect(engine.getLatestBands()?.bass).toBe(200);
    });

    it('keeps the native 0..255 spectrum verbatim (the Java contract) and clamps outliers', async () => {
        const { engine, emit } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit(spectrumEvent({
            bands: { bass: 128, lowMid: 0, mid: 0, vocal: 0, treble: 0, power: 255 },
            spectrum: [0, 128, 300],
        }));

        expect(audioBands.bass.get()).toBe(128);
        expect(audioBands.spectrum.get().length).toBe(3);
        expect(Array.from(audioBands.spectrum.get())).toEqual([0, 128, 255]);
        expect(audioPower.get()).toBe(255);
    });

    it('records the spectrum feed rate and whether it is switched on', async () => {
        const { engine, emit, setSpectrum, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');

        engine.setSpectrumEnabled(true);
        expect(setSpectrum).toHaveBeenLastCalledWith(true);
        expect(engine.isSpectrumEnabled()).toBe(true);

        emit(spectrumEvent());
        advance(50);
        emit(spectrumEvent());

        const diagnostics = engine.getDiagnostics();
        expect(diagnostics.spectrum.events).toBe(2);
        expect(diagnostics.spectrum.lastLength).toBe(128);
        expect(diagnostics.spectrum.lastSampleRate).toBe(44_100);
        expect(diagnostics.spectrum.ratePerSec).toBeCloseTo(20, 5);

        engine.setSpectrumEnabled(false);
        expect(setSpectrum).toHaveBeenLastCalledWith(false);
        expect(engine.getDiagnostics().spectrumEnableOff).toBe(1);
    });

    it('refuses the spectrum switch while there is no source', () => {
        const { engine, setSpectrum } = createEngine();

        engine.setSpectrumEnabled(true);

        expect(engine.isSpectrumEnabled()).toBe(false);
        expect(setSpectrum).not.toHaveBeenCalled();
    });
});

describe('native playback diagnostics', () => {
    it('counts the first fallback of a reason once and remembers the decision', async () => {
        const { engine } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');

        engine.noteFallback('equalizer', 'https://cdn.example.test/a.mp3');
        engine.noteFallback('equalizer', 'https://cdn.example.test/a.mp3');
        engine.noteFallback('automix', 'https://cdn.example.test/a.mp3');

        const diagnostics = engine.getDiagnostics();
        expect(diagnostics.fallbacks).toBe(2);
        expect(diagnostics.lastFallbackReason).toBe('automix');
        expect(diagnostics.fallbackReasons.map(entry => entry.reason)).toEqual(['equalizer', 'automix']);
        expect(diagnostics.decision).toMatchObject({ takes: false, reason: 'automix' });
    });

    it('counts takeovers and keeps the last events with their timing', async () => {
        const { engine, emit, advance } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        advance(250);
        emit({ type: 'position', positionMs: 1_000, durationMs: 180_000 });
        advance(250);
        emit({ type: 'position', positionMs: 1_500, durationMs: 180_000 });
        engine.noteTakeover('https://cdn.example.test/a.mp3');

        const diagnostics = engine.getDiagnostics();
        expect(diagnostics.takeovers).toBe(1);
        expect(diagnostics.positionEvents).toBe(2);
        expect(diagnostics.positionIntervalAvgMs).toBe(250);
        expect(diagnostics.lastEventType).toBe('position');
        expect(diagnostics.lastCommand).toBe('setVolume');
    });

    it('stops, keeps the stopped position for the web fallback, and switches the spectrum off', async () => {
        const { engine, emit, setSpectrum } = createEngine();
        await engine.setSource('https://cdn.example.test/a.mp3');
        emit({ type: 'playing' });
        emit({ type: 'position', positionMs: 12_000, durationMs: 180_000 });
        engine.setSpectrumEnabled(true);

        await engine.stop();

        expect(engine.ownsPlayback()).toBe(false);
        expect(engine.activeUrl()).toBeNull();
        expect(engine.lastStoppedPositionSec()).toBe(12);
        expect(setSpectrum).toHaveBeenLastCalledWith(false);
    });
});

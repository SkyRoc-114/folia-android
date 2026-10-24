import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    HifiClockUpdate,
    HifiDevice,
    HifiEngineConfig,
    HifiEngineState,
    HifiErrorEvent,
    HifiLoadRequest,
    HifiLoadResult,
} from '../../../src/types/hifi';

// 钉住 mpv 会话的状态机：假 mpv 子进程按 request_id 回话、推事件，覆盖载入落定、走带、时钟节流、无缝接续、停止和退出、崩溃熔断。

type Json = Record<string, unknown>;
type MpvRequest = { command: unknown[]; request_id: number };

interface MpvSession {
    configure: (config: Partial<HifiEngineConfig>) => Promise<void>;
    listDevices: () => Promise<HifiDevice[]>;
    load: (request: HifiLoadRequest, options?: { ownerId?: number | null }) => Promise<HifiLoadResult>;
    play: () => Promise<void>;
    pause: () => Promise<void>;
    seek: (positionSec: number) => Promise<void>;
    stop: () => Promise<void>;
    setLoopFile: (loop: boolean) => Promise<void>;
    preloadNext: (request: HifiLoadRequest, options?: { ownerId?: number | null }) => Promise<boolean>;
    clearNext: () => Promise<void>;
    getSnapshot: () => HifiEngineState;
    dispose: () => Promise<void>;
    killSync: () => void;
}

const require = createRequire(import.meta.url);
const { createMpvSession, OBSERVED_PROPERTIES } = require('../../../electron/hifi/mpvSession.cjs') as {
    createMpvSession: (options: Record<string, unknown>) => MpvSession;
    OBSERVED_PROPERTIES: readonly string[];
};

const OUT_PARAMS = { samplerate: 96000, 'channel-count': 2, channels: 'stereo', 'hr-channels': 'stereo', format: 's32' };
const TRACK_LIST = [{
    id: 1,
    type: 'audio',
    selected: true,
    codec: 'flac',
    'codec-desc': 'FLAC (Free Lossless Audio Codec)',
    decoder: 'flac',
    'demux-samplerate': 96000,
    'demux-channel-count': 2,
    'format-name': 's32',
}];

// mpv 那一端的 IPC 连接：记下会话写来的每条命令，按 request_id 在下一个微任务里回话；事件和属性变化由测试推。
class FakeMpvSocket extends EventEmitter {
    requests: MpvRequest[] = [];
    props: Record<string, unknown> = {};
    /** 这些命令不回话（模拟 mpv 卡死）。 */
    silent = new Set<string>();
    /** 这些命令回 mpv 的错误。 */
    failing = new Set<string>();
    nextEntryId = 1;
    writableFinished = false;
    ended = false;

    write(chunk: string | Buffer, callback?: (error?: Error | null) => void) {
        for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue;
            const request = JSON.parse(line) as MpvRequest;
            this.requests.push(request);
            if (!this.silent.has(String(request.command[0]))) queueMicrotask(() => this.answer(request));
        }
        callback?.();
        return true;
    }

    end() {
        this.ended = true;
        this.writableFinished = true;
    }

    destroy() {}

    answer({ command, request_id: requestId }: MpvRequest) {
        const [name, ...args] = command;
        if (this.failing.has(String(name))) {
            this.feed({ request_id: requestId, error: 'invalid parameter' });
            return;
        }
        if (name === 'loadfile') {
            this.reply(requestId, { data: { playlist_entry_id: this.nextEntryId++ } });
            return;
        }
        if (name === 'get_property') {
            const value = this.props[String(args[0])];
            this.reply(requestId, value === undefined ? { error: 'property unavailable' } : { data: value });
            return;
        }
        this.reply(requestId, {});
    }

    reply(requestId: number, fields: Json) {
        this.feed({ request_id: requestId, error: 'success', ...fields });
    }

    feed(message: Json) {
        this.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
    }

    event(name: string, fields: Json = {}) {
        this.feed({ event: name, ...fields });
    }

    prop(name: string, data?: unknown) {
        const observe = this.requests.find(request => request.command[0] === 'observe_property' && request.command[2] === name);
        if (!observe) throw new Error(`${name} is not observed`);
        this.feed({ event: 'property-change', id: observe.command[1], name, ...(data === undefined ? {} : { data }) });
    }

    hangUp() {
        this.emit('end');
        this.emit('close');
    }

    commands(name: string) {
        return this.requests.filter(request => request.command[0] === name).map(request => request.command);
    }
}

class FakeChild extends EventEmitter {
    socket = new FakeMpvSocket();
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    stdio: unknown[] = [null, this.stdout, this.stderr, this.socket];
    pid = 4242;
    killed = false;
    kill = vi.fn(() => {
        this.killed = true;
        return true;
    });

    exit(code: number | null = 0, signal: string | null = null) {
        this.emit('exit', code, signal);
    }
}

const createFakeBridge = () => {
    let counter = 0;
    const errors = new Map<string, string>();
    return {
        errors,
        start: vi.fn(async () => {}),
        registerLocal: vi.fn((source: { fileName: string }) => {
            counter += 1;
            return { token: `tok${counter}`, url: `http://127.0.0.1:9/tok${counter}/${source.fileName}` };
        }),
        registerRemote: vi.fn((source: { fileName: string }) => {
            counter += 1;
            return { token: `tok${counter}`, url: `http://127.0.0.1:9/tok${counter}/${source.fileName}` };
        }),
        revoke: vi.fn(),
        revokeAll: vi.fn(),
        getSourceError: vi.fn((token: string) => errors.get(token) ?? null),
    };
};

const flush = async () => {
    for (let round = 0; round < 60; round += 1) await Promise.resolve();
};

const localRequest = (trackKey: string, overrides: Partial<HifiLoadRequest> = {}): HifiLoadRequest => ({
    trackKey,
    songKey: trackKey.split('#')[0],
    source: { kind: 'local', sourceKey: `key-${trackKey.replace(/[^A-Za-z0-9]/g, '')}`, size: 1000, mimeType: 'audio/flac', fileName: 'song.flac' },
    startSec: 0,
    paused: false,
    loopFile: false,
    ...overrides,
});

type HarnessOptions = Record<string, unknown> & { onSpawn?: (child: FakeChild) => void };

const createHarness = ({ onSpawn, ...overrides }: HarnessOptions = {}) => {
    const children: FakeChild[] = [];
    const spawnFn = vi.fn((_path: string, _args: string[], _options: Json) => {
        const child = new FakeChild();
        children.push(child);
        onSpawn?.(child);
        return child;
    });
    const bridge = createFakeBridge();
    const states: HifiEngineState[] = [];
    const clocks: HifiClockUpdate[] = [];
    const errors: HifiErrorEvent[] = [];
    const resolveRuntime = vi.fn(async () => ({ path: '/usr/bin/mpv', version: '0.41.0' }));
    const session = createMpvSession({
        spawnFn,
        platform: 'linux',
        resolveRuntime,
        bridge,
        onState: (state: HifiEngineState) => states.push(state),
        onClock: (update: HifiClockUpdate) => clocks.push(update),
        onError: (event: HifiErrorEvent) => errors.push(event),
        logInfo: () => {},
        logWarn: () => {},
        ...overrides,
    });
    const child = () => children[children.length - 1];
    const mpv = () => child().socket;
    const lastState = () => states[states.length - 1];
    return { session, children, child, mpv, spawnFn, bridge, states, clocks, errors, lastState, resolveRuntime };
};

type Harness = ReturnType<typeof createHarness>;

// mpv 开始放第 id 项：start-file → file-loaded → playback-restart，输出参数先放进 get_property 的答案里。
const startEntry = async (harness: Harness, id: number, { outParams = OUT_PARAMS as unknown } = {}) => {
    const mpv = harness.mpv();
    mpv.props['audio-params'] = OUT_PARAMS;
    if (outParams === undefined) delete mpv.props['audio-out-params'];
    else mpv.props['audio-out-params'] = outParams;
    mpv.props['track-list'] = TRACK_LIST;
    mpv.event('start-file', { playlist_entry_id: id });
    mpv.event('file-loaded');
    mpv.event('playback-restart');
    await flush();
};

const loadAndStart = async (harness: Harness, request: HifiLoadRequest, id: number) => {
    const result = harness.session.load(request, { ownerId: 7 });
    await flush();
    await startEntry(harness, id);
    return result;
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('mpv session: spawn and load', () => {
    it('spawns mpv on the first load only, with the fd 3 socketpair, log subscription and every observed property', async () => {
        const harness = createHarness();
        expect(harness.spawnFn).not.toHaveBeenCalled();
        const first = await loadAndStart(harness, localRequest('local:a#1'), 1);
        expect((await first).ok).toBe(true);

        expect(harness.spawnFn).toHaveBeenCalledTimes(1);
        const [path, args, options] = harness.spawnFn.mock.calls[0];
        expect(path).toBe('/usr/bin/mpv');
        expect(args).toContain('--input-ipc-client=fd://3');
        expect(args).toContain('--audio-exclusive=no');
        expect(args.some(arg => arg.startsWith('--ao='))).toBe(false);
        expect(options).toEqual({ stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
        expect(harness.mpv().commands('request_log_messages')).toEqual([['request_log_messages', 'warn']]);
        expect(harness.mpv().commands('observe_property').map(command => command[2])).toEqual([...OBSERVED_PROPERTIES]);

        const second = await loadAndStart(harness, localRequest('local:b#2'), 2);
        expect((await second).ok).toBe(true);
        expect(harness.spawnFn).toHaveBeenCalledTimes(1);
    });

    it('registers the source, sets pause and loop-file, then loadfile replace with start=', async () => {
        const harness = createHarness();
        const request = localRequest('local:a#1', { startSec: 12.5, paused: true, loopFile: true });
        const result = harness.session.load(request, { ownerId: 7 });
        await flush();

        expect(harness.bridge.start).toHaveBeenCalled();
        expect(harness.bridge.registerLocal).toHaveBeenCalledWith({
            sourceKey: request.source.kind === 'local' ? request.source.sourceKey : '',
            size: 1000,
            mimeType: 'audio/flac',
            fileName: 'song.flac',
            ownerId: 7,
        });
        const commands = harness.mpv().requests.map(entry => entry.command)
            .filter(command => command[0] !== 'observe_property' && command[0] !== 'request_log_messages');
        expect(commands).toEqual([
            ['set_property', 'pause', true],
            ['set_property', 'loop-file', 'inf'],
            ['loadfile', 'http://127.0.0.1:9/tok1/song.flac', 'replace', -1, 'start=12.5'],
        ]);
        expect(harness.lastState()).toMatchObject({ status: 'loading', trackKey: 'local:a#1', songKey: 'local:a', positionSec: 12.5 });
        await startEntry(harness, 1);
        expect(await result).toMatchObject({ ok: true });
    });

    it('resolves only once audio-out-params is known for this entry, and returns the state', async () => {
        const harness = createHarness();
        let settled: HifiLoadResult | null = null;
        void harness.session.load(localRequest('local:a#1', { paused: true }), { ownerId: 7 }).then(result => {
            settled = result;
        });
        await flush();
        const mpv = harness.mpv();
        mpv.event('start-file', { playlist_entry_id: 1 });
        mpv.event('file-loaded');
        await flush();
        expect(settled).toBeNull();

        // 输出开起来了（换格式时 mpv 会推 audio-out-params）。
        mpv.prop('audio-params', OUT_PARAMS);
        mpv.prop('audio-out-params', OUT_PARAMS);
        await flush();
        expect(settled).toMatchObject({
            ok: true,
            state: {
                status: 'paused',
                trackKey: 'local:a#1',
                sourceKind: 'local',
                localSourceKey: 'key-locala1',
                audioOutParams: { samplerate: 96000, channelCount: 2, channels: 'stereo', format: 's32' },
                paused: true,
            },
        });
    });

    it('same-format replace: reads audio-out-params on playback-restart because mpv does not push it again', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const result = await loadAndStart(harness, localRequest('local:b#2'), 2);
        expect(result).toMatchObject({ ok: true, state: { trackKey: 'local:b#2', status: 'playing' } });
        expect(harness.lastState().track).toMatchObject({ codec: 'flac', demuxSamplerate: 96000 });
    });

    it('end-file error with a busy log line fails the load as DEVICE_BUSY and revokes the token', async () => {
        const harness = createHarness();
        const result = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        const mpv = harness.mpv();
        mpv.event('start-file', { playlist_entry_id: 1 });
        mpv.event('file-loaded');
        mpv.event('playback-restart');
        mpv.event('log-message', { prefix: 'ao/alsa', level: 'error', text: 'Playback open error: Device or resource busy\n' });
        mpv.event('log-message', { prefix: 'cplayer', level: 'error', text: 'Could not open/initialize audio device -> no sound.\n' });
        mpv.event('end-file', { reason: 'error', playlist_entry_id: 1, file_error: 'audio output initialization failed' });
        await flush();

        expect(await result).toEqual({ ok: false, errorCode: 'DEVICE_BUSY', detail: 'audio output initialization failed' });
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');
        expect(harness.lastState()).toMatchObject({ status: 'error', errorCode: 'DEVICE_BUSY', trackKey: 'local:a#1', processRunning: true });
        // 载入的失败经结果报，不再另推 hifi:error。
        expect(harness.errors).toEqual([]);
    });

    it('the bridge\'s recorded source error wins over mpv\'s file_error', async () => {
        const harness = createHarness();
        const result = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        harness.bridge.errors.set('tok1', 'SOURCE_REJECTED');
        harness.mpv().event('start-file', { playlist_entry_id: 1 });
        harness.mpv().event('end-file', { reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
        await flush();
        expect(await result).toMatchObject({ ok: false, errorCode: 'SOURCE_REJECTED' });
    });

    it('a newer load supersedes a pending one', async () => {
        const harness = createHarness();
        const first = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        const second = harness.session.load(localRequest('local:b#2'), { ownerId: 7 });
        expect(await first).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'superseded' });
        await flush();
        expect(harness.mpv().commands('loadfile').map(command => command[1])).toEqual([
            'http://127.0.0.1:9/tok1/song.flac',
            'http://127.0.0.1:9/tok2/song.flac',
        ]);
        // 旧的那一项开始又被停掉，它的事件不影响新的。
        harness.mpv().event('start-file', { playlist_entry_id: 1 });
        harness.mpv().event('end-file', { reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
        await startEntry(harness, 2);
        expect(await second).toMatchObject({ ok: true, state: { trackKey: 'local:b#2' } });
        expect(harness.lastState().errorCode).toBeNull();
    });

    it('times out after loadTimeoutMs, stops mpv and reports LOAD_FAILED', async () => {
        const harness = createHarness();
        const result = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        await vi.advanceTimersByTimeAsync(20000);
        expect(await result).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'timeout' });
        expect(harness.mpv().commands('stop')).toEqual([['stop']]);
        expect(harness.lastState()).toMatchObject({ status: 'error', errorCode: 'LOAD_FAILED' });
    });

    it('reports MPV_NOT_FOUND without spawning when there is no runtime', async () => {
        const harness = createHarness({ resolveRuntime: async () => null });
        expect(await harness.session.load(localRequest('local:a#1'))).toEqual({ ok: false, errorCode: 'MPV_NOT_FOUND' });
        expect(harness.spawnFn).not.toHaveBeenCalled();
    });

    it('reports MPV_SPAWN_FAILED when the process dies before IPC is up', async () => {
        const harness = createHarness({
            onSpawn: child => {
                child.socket.silent.add('observe_property');
                queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
            },
        });
        const result = harness.session.load(localRequest('local:a#1'));
        expect(await result).toMatchObject({ ok: false, errorCode: 'MPV_SPAWN_FAILED' });
        expect(harness.child().kill).toHaveBeenCalled();
    });

    it('Windows: random pipe name on the command line, then connectPipe', async () => {
        const sockets: FakeMpvSocket[] = [];
        const connectPipe = vi.fn(async () => {
            const socket = new FakeMpvSocket();
            sockets.push(socket);
            return socket;
        });
        const harness = createHarness({
            platform: 'win32',
            connectPipe,
            randomBytes: (size: number) => Buffer.alloc(size, 0xab),
        });
        const result = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        const pipe = `\\\\.\\pipe\\folia-hifi-${'ab'.repeat(16)}`;
        const [, args, options] = harness.spawnFn.mock.calls[0];
        expect(args).toContain(`--input-ipc-server=${pipe}`);
        expect(args).not.toContain('--input-ipc-client=fd://3');
        expect(options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        expect(connectPipe).toHaveBeenCalledWith(pipe, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        const socket = sockets[0];
        socket.props['audio-out-params'] = OUT_PARAMS;
        socket.event('start-file', { playlist_entry_id: 1 });
        socket.event('playback-restart');
        await flush();
        expect(await result).toMatchObject({ ok: true });
    });
});

describe('mpv session: transport and clock', () => {
    it('pause / play / seek send the matching commands; seek pushes a stopped clock at once and a running one at playback-restart', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        await harness.session.pause();
        await harness.session.play();
        harness.clocks.length = 0;
        await harness.session.seek(42.5);
        expect(mpv.commands('set_property').slice(-2)).toEqual([['set_property', 'pause', true], ['set_property', 'pause', false]]);
        expect(mpv.commands('seek')).toEqual([['seek', 42.5, 'absolute']]);
        // mpv 还在找位置：时钟按停着报，渲染端不往前外推。
        expect(harness.clocks).toEqual([{ trackKey: 'local:a#1', positionSec: 42.5, paused: true, reason: 'seek', seq: expect.any(Number) }]);
        // 状态里不算暂停：播放键不该在每次跳转时闪一下。
        await flush();
        expect(harness.lastState()).toMatchObject({ status: 'playing', paused: false });

        await vi.advanceTimersByTimeAsync(400);
        mpv.prop('time-pos', 42.5);
        expect(harness.clocks.at(-1)).toMatchObject({ reason: 'tick', paused: true });
        harness.clocks.length = 0;
        mpv.event('playback-restart');
        expect(harness.clocks).toEqual([{ trackKey: 'local:a#1', positionSec: 42.5, paused: false, reason: 'resume', seq: expect.any(Number) }]);
        // 跳完的那次已经推过了，下一个 time-pos 照常节流。
        mpv.prop('time-pos', 42.51);
        expect(harness.clocks).toHaveLength(1);
    });

    it('a seek while paused stays paused through playback-restart', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1', { paused: true }), 1);
        harness.mpv().prop('pause', true);
        harness.clocks.length = 0;
        await harness.session.seek(10);
        harness.mpv().event('playback-restart');
        expect(harness.clocks.map(({ reason, paused, positionSec }) => ({ reason, paused, positionSec }))).toEqual([
            { reason: 'seek', paused: true, positionSec: 10 },
            { reason: 'seek', paused: true, positionSec: 10 },
        ]);
    });

    it('a seek mpv refuses releases the clock at once instead of waiting for a playback-restart that never comes', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        harness.mpv().failing.add('seek');
        harness.clocks.length = 0;
        await harness.session.seek(5);
        expect(harness.clocks.map(({ reason, paused }) => ({ reason, paused }))).toEqual([
            { reason: 'seek', paused: true },
            { reason: 'seek', paused: false },
        ]);
    });

    it('reports a paused clock while mpv waits for its cache, without calling it a pause', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        mpv.prop('time-pos', 3);
        harness.clocks.length = 0;
        const statesBefore = harness.states.length;

        mpv.prop('paused-for-cache', true);
        expect(harness.clocks).toEqual([{ trackKey: 'local:a#1', positionSec: 3, paused: true, reason: 'tick', seq: expect.any(Number) }]);
        // 缓存见底期间推的 tick 也是停着的。
        await vi.advanceTimersByTimeAsync(300);
        mpv.prop('time-pos', 3.01);
        expect(harness.clocks.at(-1)).toMatchObject({ paused: true });

        mpv.prop('paused-for-cache', false);
        expect(harness.clocks.at(-1)).toMatchObject({ reason: 'tick', paused: false });
        await flush();
        expect(harness.states.length).toBe(statesBefore);
        expect(harness.lastState()).toMatchObject({ status: 'playing', paused: false });
    });

    it('throttles time-pos to at most 4 pushes a second, but pushes the first value after a restart and pause flips at once', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        harness.clocks.length = 0;
        // 跳转后的第一个 time-pos 不等节流窗口。
        mpv.prop('time-pos', 0.01);
        expect(harness.clocks.map(update => update.reason)).toEqual(['load']);

        harness.clocks.length = 0;
        for (let step = 1; step <= 50; step += 1) {
            await vi.advanceTimersByTimeAsync(20);
            mpv.prop('time-pos', 0.01 + step * 0.02);
        }
        const ticks = harness.clocks.filter(update => update.reason === 'tick');
        expect(ticks.length).toBeGreaterThanOrEqual(3);
        expect(ticks.length).toBeLessThanOrEqual(4);
        // 节流窗口里最后的位置由尾随定时器补上。
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.clocks[harness.clocks.length - 1].positionSec).toBeCloseTo(1.01, 5);

        harness.clocks.length = 0;
        mpv.prop('pause', true);
        expect(harness.clocks).toEqual([expect.objectContaining({ reason: 'pause', paused: true })]);
        mpv.prop('pause', false);
        expect(harness.clocks[1]).toMatchObject({ reason: 'resume', paused: false });

        harness.clocks.length = 0;
        await vi.advanceTimersByTimeAsync(50);
        mpv.event('playback-restart');
        mpv.prop('time-pos', 30);
        expect(harness.clocks).toEqual([expect.objectContaining({ reason: 'seek', positionSec: 30 })]);
    });

    it('coalesces the changes of one batch into a single state push with a rising seq', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const before = harness.states.length;
        const mpv = harness.mpv();
        mpv.prop('duration', 180);
        mpv.prop('volume', 100);
        mpv.prop('current-ao', 'alsa');
        await flush();
        expect(harness.states.length).toBe(before + 1);
        const state = harness.lastState();
        expect(state).toMatchObject({ durationSec: 180, currentAo: 'alsa' });
        expect(state.seq).toBeGreaterThan(harness.states[before - 1].seq);
    });

    it('eof-reached on the last entry reports ended; play then restarts from the top', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        harness.mpv().prop('eof-reached', true);
        await flush();
        expect(harness.lastState().status).toBe('ended');
        await harness.session.play();
        expect(harness.mpv().commands('seek')).toEqual([['seek', 0, 'absolute']]);
        expect(harness.mpv().commands('set_property').at(-1)).toEqual(['set_property', 'pause', false]);
    });

    it('the state reports volume 100 before mpv has said anything', async () => {
        const harness = createHarness();
        expect(harness.session.getSnapshot()).toMatchObject({ status: 'stopped', volume: 100 });
        // 软件音量的值要等 mpv 起来才下发，在那之前 mpv 会是 --volume=100。
        await harness.session.configure({ mpvPath: null, audioDevice: 'auto', exclusive: false, dsdMode: 'pcm', softwareVolume: true, volume: 0 });
        expect(harness.session.getSnapshot().volume).toBe(100);
    });

    it('setLoopFile sets loop-file inf / no', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        await harness.session.setLoopFile(true);
        await harness.session.setLoopFile(false);
        expect(harness.mpv().commands('set_property').slice(-2)).toEqual([
            ['set_property', 'loop-file', 'inf'],
            ['set_property', 'loop-file', 'no'],
        ]);
    });
});

describe('mpv session: the source breaks off mid-play', () => {
    const playAt = async (harness: Harness, positionSec: number, durationSec: number | null) => {
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        if (durationSec !== null) harness.mpv().prop('duration', durationSec);
        harness.mpv().prop('time-pos', positionSec);
        await flush();
    };

    it('eof-reached well short of the duration with a bridge error is a fatal error, not the end', async () => {
        const harness = createHarness();
        await playAt(harness, 7.8, 30);
        harness.bridge.errors.set('tok1', 'SOURCE_UNREACHABLE');
        harness.mpv().prop('eof-reached', true);
        await flush();

        expect(harness.errors).toEqual([{ code: 'SOURCE_UNREACHABLE', trackKey: 'local:a#1', detail: 'source ended early', fatal: true }]);
        expect(harness.states.some(state => state.status === 'ended')).toBe(false);
        expect(harness.lastState()).toMatchObject({ status: 'error', errorCode: 'SOURCE_UNREACHABLE', trackKey: 'local:a#1', paused: true });
        // keep-open 还开着输出：停下，独占的设备放开。
        expect(harness.mpv().commands('stop')).toEqual([['stop']]);
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');
        // 失败之后 mpv 迟到的位置不再算进这一首。
        harness.clocks.length = 0;
        harness.mpv().prop('time-pos', 0.2);
        expect(harness.clocks).toEqual([]);
    });

    it('with the duration unknown a bridge error at eof is a failure too', async () => {
        const harness = createHarness();
        await playAt(harness, 12, null);
        harness.bridge.errors.set('tok1', 'SOURCE_REJECTED');
        harness.mpv().prop('eof-reached', true);
        await flush();
        expect(harness.errors).toEqual([expect.objectContaining({ code: 'SOURCE_REJECTED', fatal: true })]);
        expect(harness.lastState().status).toBe('error');
    });

    it('a bridge error with the position at the duration still ends normally', async () => {
        const harness = createHarness();
        await playAt(harness, 29.4, 30);
        harness.bridge.errors.set('tok1', 'SOURCE_UNREACHABLE');
        harness.mpv().prop('eof-reached', true);
        await flush();
        expect(harness.errors).toEqual([]);
        expect(harness.lastState()).toMatchObject({ status: 'ended', errorCode: null });
    });

    it('no bridge error: eof-reached short of the duration is still the end (a seek past the last frame)', async () => {
        const harness = createHarness();
        await playAt(harness, 7.8, 30);
        harness.mpv().prop('eof-reached', true);
        await flush();
        expect(harness.errors).toEqual([]);
        expect(harness.lastState().status).toBe('ended');
    });

    it('end-file eof with a song queued: fails the current one, drops the queued one and stops mpv', async () => {
        const harness = createHarness();
        await playAt(harness, 5, 30);
        expect(await harness.session.preloadNext(localRequest('local:b#2'))).toBe(true);
        harness.bridge.errors.set('tok1', 'SOURCE_UNREACHABLE');
        harness.mpv().event('end-file', { reason: 'eof', playlist_entry_id: 1 });
        // mpv 已经接上了预载项，这次 start-file 不再算数。
        harness.mpv().event('start-file', { playlist_entry_id: 2 });
        await flush();

        expect(harness.errors).toEqual([expect.objectContaining({ code: 'SOURCE_UNREACHABLE', trackKey: 'local:a#1', fatal: true })]);
        expect(harness.lastState()).toMatchObject({ status: 'error', trackKey: 'local:a#1', next: null });
        expect(harness.mpv().commands('stop')).toEqual([['stop']]);
        harness.mpv().event('end-file', { reason: 'stop', playlist_entry_id: 2 });
        await flush();
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok2');
    });

    it('end-file eof without a bridge error is an ordinary gapless switch', async () => {
        const harness = createHarness();
        await playAt(harness, 5, 30);
        await harness.session.preloadNext(localRequest('local:b#2'));
        harness.mpv().event('end-file', { reason: 'eof', playlist_entry_id: 1 });
        harness.mpv().event('start-file', { playlist_entry_id: 2 });
        await flush();
        expect(harness.errors).toEqual([]);
        expect(harness.lastState()).toMatchObject({ status: 'playing', trackKey: 'local:b#2' });
    });

    it('end-file error on the playing song stops mpv from moving on to the queued one', async () => {
        const harness = createHarness();
        await playAt(harness, 5, 30);
        await harness.session.preloadNext(localRequest('local:b#2'));
        harness.mpv().event('end-file', { reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
        await flush();
        expect(harness.errors).toEqual([expect.objectContaining({ code: 'SOURCE_UNREACHABLE', trackKey: 'local:a#1', fatal: true })]);
        expect(harness.lastState()).toMatchObject({ status: 'error', next: null });
        expect(harness.mpv().commands('stop')).toEqual([['stop']]);
    });
});

describe('mpv session: gapless', () => {
    it('appends the next song, switches to it on its start-file and revokes the old token on its end-file', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const appended = harness.session.preloadNext(localRequest('local:b#2'), { ownerId: 7 });
        await flush();
        expect(await appended).toBe(true);
        expect(harness.mpv().commands('loadfile').at(-1)).toEqual(['loadfile', 'http://127.0.0.1:9/tok2/song.flac', 'append']);
        expect(harness.lastState()).toMatchObject({ trackKey: 'local:a#1', next: { trackKey: 'local:b#2', songKey: 'local:b' } });

        // 有下一首时放到头不算 ended。
        harness.mpv().prop('eof-reached', true);
        await flush();
        expect(harness.lastState().status).toBe('playing');

        harness.clocks.length = 0;
        harness.mpv().event('end-file', { reason: 'eof', playlist_entry_id: 1 });
        harness.mpv().event('start-file', { playlist_entry_id: 2 });
        await flush();
        expect(harness.lastState()).toMatchObject({ trackKey: 'local:b#2', songKey: 'local:b', next: null, status: 'playing' });
        expect(harness.clocks[0]).toMatchObject({ trackKey: 'local:b#2', reason: 'load', positionSec: 0 });
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');
        expect(harness.bridge.revoke).not.toHaveBeenCalledWith('tok2');
    });

    it('replacing a queued song removes the old entry by playlist index; clearNext removes and revokes', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        expect(await harness.session.preloadNext(localRequest('local:b#2'))).toBe(true);
        mpv.props.playlist = [{ id: 1, current: true, playing: true }, { id: 2 }];
        expect(await harness.session.preloadNext(localRequest('local:c#3'))).toBe(true);
        await flush();
        expect(mpv.commands('playlist-remove')).toEqual([['playlist-remove', 1]]);
        expect(harness.lastState().next?.trackKey).toBe('local:c#3');

        mpv.props.playlist = [{ id: 1, current: true, playing: true }, { id: 3 }];
        await harness.session.clearNext();
        expect(mpv.commands('playlist-remove')).toEqual([['playlist-remove', 1], ['playlist-remove', 1]]);
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok3');
        await flush();
        expect(harness.lastState().next).toBeNull();
    });

    it('preloadNext needs a loaded current song', async () => {
        const harness = createHarness();
        expect(await harness.session.preloadNext(localRequest('local:b#2'))).toBe(false);
        expect(harness.spawnFn).not.toHaveBeenCalled();
    });

    it('preloadNext refuses once the current song is at its end (keep-open has paused it)', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        harness.mpv().prop('eof-reached', true);
        harness.mpv().prop('pause', true);
        await flush();
        expect(harness.lastState().status).toBe('ended');
        expect(await harness.session.preloadNext(localRequest('local:b#2'))).toBe(false);
        expect(harness.mpv().commands('loadfile')).toHaveLength(1);
        expect(harness.bridge.registerLocal).toHaveBeenCalledTimes(1);
    });

    it('an append that reaches mpv after the end unpauses the song it switches to', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        mpv.silent.add('loadfile');
        const appended = harness.session.preloadNext(localRequest('local:b#2'));
        await flush();
        // append 还在路上，当前这首先到了头：keep-open 把它停在暂停里。
        mpv.prop('eof-reached', true);
        mpv.prop('pause', true);
        const append = mpv.requests.filter(request => request.command[0] === 'loadfile').at(-1)!;
        mpv.answer(append);
        expect(await appended).toBe(true);
        expect(mpv.commands('set_property').at(-1)).toEqual(['set_property', 'pause', false]);
    });

    it('a pause the user pressed while the append was on its way is kept', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        mpv.silent.add('loadfile');
        const appended = harness.session.preloadNext(localRequest('local:b#2'));
        await flush();
        mpv.prop('eof-reached', true);
        await harness.session.pause();
        mpv.answer(mpv.requests.filter(request => request.command[0] === 'loadfile').at(-1)!);
        expect(await appended).toBe(true);
        expect(mpv.commands('set_property').at(-1)).toEqual(['set_property', 'pause', true]);
    });

    it('a new load drops the queued song too (replace clears the playlist)', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        await harness.session.preloadNext(localRequest('local:b#2'));
        await loadAndStart(harness, localRequest('local:c#3'), 3);
        expect(harness.lastState()).toMatchObject({ trackKey: 'local:c#3', next: null });
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok2');
    });
});

describe('mpv session: stop and exit', () => {
    it('stop closes playback, revokes tokens, goes idle, then quits after idleExitMs and kills after 2 s', async () => {
        const harness = createHarness({ idleExitMs: 60000 });
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        await harness.session.stop();
        await flush();
        expect(harness.mpv().commands('stop')).toEqual([['stop']]);
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');
        expect(harness.lastState()).toMatchObject({ status: 'idle', trackKey: null, processRunning: true });

        await vi.advanceTimersByTimeAsync(59999);
        expect(harness.mpv().commands('quit')).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(harness.mpv().commands('quit')).toEqual([['quit']]);
        await flush();
        expect(harness.lastState()).toMatchObject({ status: 'stopped', processRunning: false });
        expect(harness.child().kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(harness.child().kill).toHaveBeenCalledTimes(1);
        // 退出是我们要的，不算崩溃。
        harness.child().exit(0);
        expect(harness.errors).toEqual([]);
    });

    it('does not kill an mpv that quits within the grace period, and spawns a new one for the next load', async () => {
        const harness = createHarness({ idleExitMs: 1000 });
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        await harness.session.stop();
        await vi.advanceTimersByTimeAsync(1000);
        const first = harness.child();
        first.exit(0);
        await vi.advanceTimersByTimeAsync(2000);
        expect(first.kill).not.toHaveBeenCalled();
        const result = await loadAndStart(harness, localRequest('local:b#2'), 1);
        expect((await result).ok).toBe(true);
        expect(harness.spawnFn).toHaveBeenCalledTimes(2);
    });

    it('killSync kills the running and the quitting process at once and settles a pending load', async () => {
        const harness = createHarness({ idleExitMs: 1000 });
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        await harness.session.stop();
        await vi.advanceTimersByTimeAsync(1000);
        const quitting = harness.child();
        const pending = harness.session.load(localRequest('local:b#2'));
        await flush();
        const running = harness.child();
        expect(running).not.toBe(quitting);
        harness.session.killSync();
        expect(quitting.kill).toHaveBeenCalledTimes(1);
        expect(running.kill).toHaveBeenCalledTimes(1);
        expect(await pending).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
        running.exit(null, 'SIGTERM');
        expect(harness.errors).toEqual([]);
    });

    it('a load cancelled by stop answers detail stopped, with mpv up and while it is still starting', async () => {
        const harness = createHarness();
        const whileUp = harness.session.load(localRequest('local:a#1'), { ownerId: 7 });
        await flush();
        await harness.session.stop();
        expect(await whileUp).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });

        let release: (runtime: { path: string; version: string }) => void = () => {};
        const slow = createHarness({
            resolveRuntime: () => new Promise(resolve => {
                release = resolve;
            }),
        });
        const whileStarting = slow.session.load(localRequest('local:b#2'), { ownerId: 7 });
        await flush();
        await slow.session.stop();
        expect(await whileStarting).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
        release({ path: '/usr/bin/mpv', version: '0.41.0' });
        await flush();
        // 拉起照常落地，但没人要了：不发 loadfile，计空闲。
        expect(slow.mpv().commands('loadfile')).toEqual([]);
        expect(slow.errors).toEqual([]);
    });

    it('after killSync nothing spawns mpv again: load answers stopped, listDevices and preloadNext refuse', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        harness.session.killSync();
        expect(harness.child().kill).toHaveBeenCalledTimes(1);

        expect(await harness.session.load(localRequest('local:b#2'))).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
        expect(await harness.session.listDevices()).toEqual([]);
        expect(await harness.session.preloadNext(localRequest('local:c#3'))).toBe(false);
        await flush();
        expect(harness.spawnFn).toHaveBeenCalledTimes(1);
        harness.child().exit(null, 'SIGTERM');
        expect(harness.errors).toEqual([]);
    });

    it('killSync while the runtime is being detected: the spawn never happens', async () => {
        let release: (runtime: { path: string; version: string }) => void = () => {};
        const harness = createHarness({
            resolveRuntime: () => new Promise(resolve => {
                release = resolve;
            }),
        });
        const result = harness.session.load(localRequest('local:a#1'));
        await flush();
        harness.session.killSync();
        expect(await result).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
        release({ path: '/usr/bin/mpv', version: '0.41.0' });
        await flush();
        expect(harness.spawnFn).not.toHaveBeenCalled();
    });

    it('killSync while mpv is connecting kills it as soon as it lands and does not count a crash', async () => {
        const harness = createHarness({
            onSpawn: child => child.socket.silent.add('observe_property'),
        });
        const result = harness.session.load(localRequest('local:a#1'));
        await flush();
        const launching = harness.child();
        harness.session.killSync();
        expect(launching.kill).toHaveBeenCalledTimes(1);
        expect(await result).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
        await flush();
        launching.exit(null, 'SIGTERM');
        expect(launching.kill).toHaveBeenCalledTimes(1);
        expect(harness.errors).toEqual([]);
        expect(harness.session.getSnapshot().circuitOpen).toBe(false);
    });

    it('killSync while the Windows pipe is being connected aborts the connect', async () => {
        let connectSignal: AbortSignal | null = null;
        const harness = createHarness({
            platform: 'win32',
            randomBytes: (size: number) => Buffer.alloc(size, 0xcd),
            connectPipe: vi.fn((_path: string, { signal }: { signal: AbortSignal }) => {
                connectSignal = signal;
                return new Promise(() => {});
            }),
        });
        const result = harness.session.load(localRequest('local:a#1'));
        await flush();
        harness.session.killSync();
        expect(connectSignal!.aborted).toBe(true);
        expect(harness.child().kill).toHaveBeenCalledTimes(1);
        expect(await result).toEqual({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
    });

    it('dispose asks mpv to quit', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const disposed = harness.session.dispose();
        expect(harness.mpv().commands('quit')).toEqual([['quit']]);
        harness.child().exit(0);
        await disposed;
        expect(harness.child().kill).not.toHaveBeenCalled();
    });
});

describe('mpv session: crashes', () => {
    it('an unexpected exit reports MPV_CRASHED, and the next load respawns', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const first = harness.child();
        first.exit(139, null);
        await flush();
        expect(harness.errors).toEqual([expect.objectContaining({ code: 'MPV_CRASHED', trackKey: 'local:a#1', fatal: true })]);
        expect(harness.lastState()).toMatchObject({ status: 'error', errorCode: 'MPV_CRASHED', processRunning: false });
        expect(harness.bridge.revoke).toHaveBeenCalledWith('tok1');

        const result = await loadAndStart(harness, localRequest('local:b#2'), 1);
        expect((await result).ok).toBe(true);
        expect(harness.spawnFn).toHaveBeenCalledTimes(2);
        expect(harness.lastState()).toMatchObject({ status: 'playing', errorCode: null });

        // 旧进程迟到的事件进不来。
        first.socket.prop('pause', true);
        first.socket.event('end-file', { reason: 'error', playlist_entry_id: 1, file_error: 'loading failed' });
        first.exit(1);
        await flush();
        expect(harness.lastState()).toMatchObject({ status: 'playing', trackKey: 'local:b#2', errorCode: null });
        expect(harness.errors).toHaveLength(1);
    });

    it('an IPC hang-up during a pending load fails it with MPV_CRASHED', async () => {
        const harness = createHarness();
        const result = harness.session.load(localRequest('local:a#1'));
        await flush();
        harness.mpv().hangUp();
        expect(await result).toMatchObject({ ok: false, errorCode: 'MPV_CRASHED' });
        expect(harness.errors[0]).toMatchObject({ code: 'MPV_CRASHED', trackKey: 'local:a#1' });
    });

    it('a command that times out kills the wedged mpv and counts as a crash', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        harness.mpv().silent.add('set_property');
        const paused = harness.session.pause();
        await vi.advanceTimersByTimeAsync(5000);
        await paused;
        expect(harness.child().kill).toHaveBeenCalled();
        expect(harness.errors).toEqual([expect.objectContaining({ code: 'IPC_TIMEOUT', fatal: true })]);
        expect(harness.lastState()).toMatchObject({ status: 'error', errorCode: 'IPC_TIMEOUT', processRunning: false });
    });

    it('opens the circuit after 3 crashes within 60 s', async () => {
        const harness = createHarness();
        for (let round = 1; round <= 3; round += 1) {
            await loadAndStart(harness, localRequest(`local:a#${round}`), 1);
            harness.child().exit(1);
            await flush();
            await vi.advanceTimersByTimeAsync(10000);
        }
        expect(harness.lastState().circuitOpen).toBe(true);
        expect(await harness.session.load(localRequest('local:b#9'))).toEqual({ ok: false, errorCode: 'CIRCUIT_OPEN' });
        expect(harness.spawnFn).toHaveBeenCalledTimes(3);
    });

    it('crashes spread over more than 60 s do not open the circuit', async () => {
        const harness = createHarness();
        for (let round = 1; round <= 3; round += 1) {
            await loadAndStart(harness, localRequest(`local:a#${round}`), 1);
            harness.child().exit(1);
            await flush();
            await vi.advanceTimersByTimeAsync(31000);
        }
        expect(harness.lastState().circuitOpen).toBe(false);
        const result = await loadAndStart(harness, localRequest('local:b#9'), 1);
        expect((await result).ok).toBe(true);
    });
});

describe('mpv session: configure and devices', () => {
    it('puts the config on the command line before the first spawn', async () => {
        const harness = createHarness();
        await harness.session.configure({ mpvPath: null, audioDevice: 'alsa/hw:CARD=D10,DEV=0', exclusive: true, dsdMode: 'dop', softwareVolume: false, volume: 40 });
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const [, args] = harness.spawnFn.mock.calls[0];
        expect(args).toEqual(expect.arrayContaining(['--audio-device=alsa/hw:CARD=D10,DEV=0', '--audio-exclusive=yes', '--audio-spdif=dsd', '--volume=100']));
        // 软件音量关着：不发 volume。
        expect(harness.mpv().commands('set_property').filter(command => command[1] === 'volume')).toEqual([]);
        expect(harness.lastState()).toMatchObject({ exclusive: true, spdif: 'dsd', volume: 100 });
    });

    it('applies changes live with set_property, only for what changed; volume is 100 unless software volume is on', async () => {
        const harness = createHarness();
        await loadAndStart(harness, localRequest('local:a#1'), 1);
        const mpv = harness.mpv();
        const before = mpv.commands('set_property').length;
        await harness.session.configure({ mpvPath: null, audioDevice: 'wasapi/{guid}', exclusive: true, dsdMode: 'dop', softwareVolume: false, volume: 30 });
        expect(mpv.commands('set_property').slice(before)).toEqual([
            ['set_property', 'audio-device', 'wasapi/{guid}'],
            ['set_property', 'audio-exclusive', true],
            ['set_property', 'audio-spdif', 'dsd'],
        ]);
        await harness.session.configure({ mpvPath: null, audioDevice: 'wasapi/{guid}', exclusive: true, dsdMode: 'pcm', softwareVolume: true, volume: 30 });
        expect(mpv.commands('set_property').slice(before + 3)).toEqual([
            ['set_property', 'audio-spdif', ''],
            ['set_property', 'volume', 30],
        ]);
        await harness.session.configure({ mpvPath: null, audioDevice: 'wasapi/{guid}', exclusive: true, dsdMode: 'pcm', softwareVolume: false, volume: 30 });
        expect(mpv.commands('set_property').slice(before + 5)).toEqual([['set_property', 'volume', 100]]);
        await harness.session.configure({ mpvPath: null, audioDevice: 'wasapi/{guid}', exclusive: true, dsdMode: 'pcm', softwareVolume: false, volume: 70 });
        expect(mpv.commands('set_property').length).toBe(before + 6);
    });

    it('lists devices from audio-device-list and marks only Linux hw: devices as direct (plughw converts behind mpv)', async () => {
        const harness = createHarness({
            idleExitMs: 1000,
            onSpawn: child => {
                child.socket.props['audio-device-list'] = [
                    { name: 'auto', description: 'Autoselect device' },
                    { name: 'pipewire', description: 'Default (pipewire)' },
                    { name: 'alsa/hw:CARD=D10,DEV=0', description: 'D10, USB Audio' },
                    { name: 'alsa/plughw:CARD=D10,DEV=0', description: 'D10, USB Audio (plug)' },
                ];
            },
        });
        expect(await harness.session.listDevices()).toEqual([
            { name: 'auto', description: 'Autoselect device', driver: 'auto', direct: false },
            { name: 'pipewire', description: 'Default (pipewire)', driver: 'pipewire', direct: false },
            { name: 'alsa/hw:CARD=D10,DEV=0', description: 'D10, USB Audio', driver: 'alsa', direct: true },
            { name: 'alsa/plughw:CARD=D10,DEV=0', description: 'D10, USB Audio (plug)', driver: 'alsa', direct: false },
        ]);
        // 只为列设备拉起的进程空闲后退出。
        await vi.advanceTimersByTimeAsync(1000);
        expect(harness.mpv().commands('quit')).toEqual([['quit']]);
    });
});

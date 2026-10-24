import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// test/manual/hifiMpvSmoke.mjs

/**
 * 用真的 mpv 跑一遍 HiFi 主进程那几块（electron/hifi/mpvSession.cjs + sourceBridge.cjs），不起 Electron：
 * 渲染端换成进程内的假实现，按 sourceKey 直接从磁盘读字节回给来源桥；输出用 --ao=null，不出声。
 *
 * 走一遍：载入 → 等到在放 → 看时钟节流 → 跳转 → 暂停 / 继续 → stop（输出关掉）→ 无缝接下一首 → 短文件放到底
 * （ended，之后预载被拒）→ 源读不出时的错误码 → 源在播放途中断掉（报错而不是 ended）→ killSync 之后不再拉起；
 * 每步打印 HifiEngineState 里的 audioParams / audioOutParams / track。
 *
 * 用法：
 *   node test/manual/hifiMpvSmoke.mjs <第一首，如 96k/24 FLAC> <第二首，如 DSD64 .dsf> [--mpv /usr/bin/mpv]
 *
 * 退出码 0 表示每一步都符合预期；不符合的步骤打 FAIL 并以 1 退出。
 */

const require = createRequire(import.meta.url);
const { createMpvSession } = require('../../electron/hifi/mpvSession.cjs');
const { createSourceBridge } = require('../../electron/hifi/sourceBridge.cjs');

const parseArgs = () => {
    const args = process.argv.slice(2);
    const files = [];
    let mpvPath = '/usr/bin/mpv';
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--mpv') {
            mpvPath = args[index + 1];
            index += 1;
        } else {
            files.push(args[index]);
        }
    }
    if (files.length < 2) {
        console.error('usage: node test/manual/hifiMpvSmoke.mjs <first audio file> <second audio file> [--mpv <path>]');
        process.exit(2);
    }
    return { files: files.map(file => path.resolve(file)), mpvPath };
};

const { files, mpvPath } = parseArgs();
const startedAt = Date.now();
const stamp = () => `${String(Date.now() - startedAt).padStart(6)} ms`;
let failures = 0;
const check = (ok, what) => {
    console.log(`${stamp()} ${ok ? 'PASS' : 'FAIL'} ${what}`);
    if (!ok) failures += 1;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 假渲染端：sourceKey → 磁盘上的文件。未登记的 key 回 unknown-source，标成坏的 key 回 failed，
// 设了断点的 key 读到那个字节以后回 failed（源在播放途中断掉）。
const registeredFiles = new Map();
const brokenKeys = new Set();
const failFromOffset = new Map();
const requestRead = async (_ownerId, { sourceKey, offset, length }) => {
    if (brokenKeys.has(sourceKey)) return { status: 'failed' };
    if (failFromOffset.has(sourceKey) && offset >= failFromOffset.get(sourceKey)) return { status: 'failed' };
    const file = registeredFiles.get(sourceKey);
    if (!file) return { status: 'unknown-source' };
    const handle = openSync(file, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const read = readSync(handle, buffer, 0, length, offset);
        return { status: 'ok', data: new Uint8Array(buffer.buffer, buffer.byteOffset, read) };
    } finally {
        closeSync(handle);
    }
};
const quiet = () => {};
// 块小一点，源中途断掉那一步才断在文件中间。
const bridge = createSourceBridge({ requestRead, chunkSize: 64 * 1024, unknownSourceGiveUpMs: 600, logInfo: quiet });

let lastState = null;
const stateWaiters = new Set();
const clockLog = [];
const errorLog = [];
const statusLog = [];
const children = [];
const session = createMpvSession({
    spawnFn: (...args) => {
        const child = spawn(...args);
        children.push(child);
        return child;
    },
    platform: process.platform,
    resolveRuntime: async () => ({ path: mpvPath, version: null }),
    bridge,
    ao: 'null',
    idleExitMs: 60000,
    onState: state => {
        if (lastState?.status !== state.status || lastState?.trackKey !== state.trackKey) {
            console.log(`${stamp()} state #${state.seq} ${state.status} track=${state.trackKey} pos=${state.positionSec.toFixed(2)} ao=${state.currentAo}`);
        }
        lastState = state;
        statusLog.push({ status: state.status, trackKey: state.trackKey });
        for (const waiter of [...stateWaiters]) waiter(state);
    },
    onClock: update => {
        clockLog.push({ at: Date.now(), ...update });
        if (update.reason !== 'tick') console.log(`${stamp()} clock ${update.reason} pos=${update.positionSec.toFixed(3)} paused=${update.paused}`);
    },
    onError: event => {
        errorLog.push(event);
        console.log(`${stamp()} error ${JSON.stringify(event)}`);
    },
    logInfo: (...args) => console.log(`${stamp()}`, ...args),
    logWarn: (...args) => console.log(`${stamp()}`, ...args),
});

const waitForState = (predicate, what, timeoutMs = 10000) => new Promise((resolve) => {
    if (lastState && predicate(lastState)) {
        resolve(lastState);
        return;
    }
    const timer = setTimeout(() => {
        stateWaiters.delete(waiter);
        check(false, `timed out waiting for ${what}`);
        resolve(lastState);
    }, timeoutMs);
    const waiter = state => {
        if (!predicate(state)) return;
        clearTimeout(timer);
        stateWaiters.delete(waiter);
        resolve(state);
    };
    stateWaiters.add(waiter);
});

const mimeFor = file => (file.endsWith('.flac') ? 'audio/flac' : file.endsWith('.dsf') ? 'audio/dsf' : 'application/octet-stream');
let trackCounter = 0;
const requestFor = (file, { startSec = 0, paused = false, sourceKey = randomBytes(16).toString('hex') } = {}) => {
    registeredFiles.set(sourceKey, file);
    trackCounter += 1;
    const songKey = `local:${path.basename(file)}`;
    return {
        trackKey: `${songKey}#${trackCounter}`,
        songKey,
        source: { kind: 'local', sourceKey, size: statSync(file).size, mimeType: mimeFor(file), fileName: path.basename(file) },
        startSec,
        paused,
        loopFile: false,
    };
};

const printFormat = (label, state) => {
    console.log(`${stamp()} ${label}`);
    console.log(`         audioParams    ${JSON.stringify(state.audioParams)}`);
    console.log(`         audioOutParams ${JSON.stringify(state.audioOutParams)}`);
    console.log(`         track          ${JSON.stringify(state.track)}`);
    console.log(`         durationSec ${state.durationSec} currentAo ${state.currentAo} device ${state.audioDevice} volume ${state.volume} exclusive ${state.exclusive} spdif ${state.spdif}`);
};

const [first, second] = files;
try {
    await session.configure({ mpvPath: null, audioDevice: 'auto', exclusive: false, dsdMode: 'pcm', softwareVolume: false, volume: 100 });

    console.log(`${stamp()} --- load ${path.basename(first)}`);
    const firstRequest = requestFor(first);
    const loaded = await session.load(firstRequest, { ownerId: 1 });
    check(loaded.ok === true, `load resolves ok (${JSON.stringify(loaded.ok ? loaded.state.status : loaded)})`);
    const playing = await waitForState(state => state.status === 'playing' && state.trackKey === firstRequest.trackKey, 'playing');
    check(playing.audioOutParams !== null, 'audioOutParams is known once playing');
    await sleep(300);
    printFormat('first track format', lastState);

    clockLog.length = 0;
    await sleep(1000);
    const ticks = clockLog.filter(update => update.reason === 'tick');
    check(ticks.length >= 2 && ticks.length <= 5, `clock ticks in 1 s: ${ticks.length} (want 2..5, <= 4 Hz)`);
    const gaps = ticks.slice(1).map((update, index) => update.at - ticks[index].at);
    check(gaps.every(gap => gap >= 200), `tick gaps ${gaps.join(', ')} ms all >= 200`);

    console.log(`${stamp()} --- seek 2.0`);
    clockLog.length = 0;
    await session.seek(2);
    const seekPush = clockLog.find(update => update.reason === 'seek');
    check(Boolean(seekPush) && Math.abs(seekPush.positionSec - 2) < 0.01, 'seek pushes the clock at once with the target');
    check(seekPush?.paused === true, 'the seek push is paused until mpv has found the position');
    await sleep(400);
    const restartPush = clockLog.find(update => update.reason === 'resume');
    check(Boolean(restartPush) && !restartPush.paused && Math.abs(restartPush.positionSec - 2) < 0.1,
        `playback-restart pushes a running clock (${restartPush ? `pos=${restartPush.positionSec.toFixed(3)}` : 'none'})`);
    check(lastState.positionSec >= 2 && lastState.positionSec < 3, `position after seek ${lastState.positionSec.toFixed(3)}`);

    console.log(`${stamp()} --- pause / play`);
    clockLog.length = 0;
    await session.pause();
    await waitForState(state => state.status === 'paused', 'paused');
    check(clockLog.some(update => update.reason === 'pause' && update.paused), 'pause pushes a pause clock');
    const pausedAt = lastState.positionSec;
    await sleep(400);
    check(Math.abs(lastState.positionSec - pausedAt) < 0.05, 'position holds while paused');
    await session.play();
    await waitForState(state => state.status === 'playing', 'playing again');
    check(clockLog.some(update => update.reason === 'resume' && !update.paused), 'play pushes a resume clock');

    console.log(`${stamp()} --- stop`);
    await session.stop();
    const idle = await waitForState(state => state.status === 'idle', 'idle after stop');
    await sleep(200);
    check(idle.trackKey === null && lastState.currentAo === null && lastState.audioOutParams === null, `stop closes the output (ao=${lastState.currentAo})`);

    console.log(`${stamp()} --- gapless: ${path.basename(first)} near its end, then ${path.basename(second)}`);
    const nearEnd = requestFor(first, { startSec: Math.max(0, (playing.durationSec ?? 4) - 1.2) });
    const nearEndLoad = await session.load(nearEnd, { ownerId: 1 });
    check(nearEndLoad.ok === true, 'near-end load resolves ok');
    const queued = requestFor(second);
    const preloaded = await session.preloadNext(queued, { ownerId: 1 });
    check(preloaded === true, 'preloadNext appends the second track');
    check(lastState.next?.trackKey === queued.trackKey || lastState.trackKey === queued.trackKey, 'state shows the queued track');
    const switched = await waitForState(state => state.trackKey === queued.trackKey, 'gapless switch', 6000);
    check(switched.trackKey === queued.trackKey && switched.next === null, 'start-file of the queued entry makes it current');
    // 换到 DSD 时 mpv 要重开输出，track-list 的回复会晚几百毫秒。
    await waitForState(state => state.trackKey === queued.trackKey && state.track !== null
        && state.audioOutParams?.samplerate === state.audioParams?.samplerate, 'second format', 4000);
    printFormat('second track format (after gapless switch)', lastState);

    console.log(`${stamp()} --- eof on a short file: ${path.basename(second)} from near its end`);
    const tail = requestFor(second, { startSec: Math.max(0, (lastState.durationSec ?? 4) - 0.8) });
    const tailLoad = await session.load(tail, { ownerId: 1 });
    check(tailLoad.ok === true, 'tail load resolves ok');
    const ended = await waitForState(state => state.status === 'ended' && state.trackKey === tail.trackKey, 'ended', 6000);
    check(ended.status === 'ended', 'eof-reached on the last entry reports ended');
    printFormat('state at the end', ended);
    const lateQueue = await session.preloadNext(requestFor(first), { ownerId: 1 });
    check(lateQueue === false, 'preloadNext after the end answers false (the renderer loads normally)');

    console.log(`${stamp()} --- source that cannot be read`);
    const broken = requestFor(first);
    brokenKeys.add(broken.source.sourceKey);
    const brokenLoad = await session.load(broken, { ownerId: 1 });
    check(brokenLoad.ok === false && brokenLoad.errorCode === 'SOURCE_UNREACHABLE', `unreadable source fails with ${brokenLoad.ok ? 'ok' : brokenLoad.errorCode}`);

    console.log(`${stamp()} --- source the renderer does not know`);
    const unknown = requestFor(first);
    registeredFiles.delete(unknown.source.sourceKey);
    const unknownLoad = await session.load(unknown, { ownerId: 1 });
    check(unknownLoad.ok === false, `unknown source fails with ${unknownLoad.ok ? 'ok' : unknownLoad.errorCode}`);

    console.log(`${stamp()} --- source that breaks off mid-play: ${path.basename(first)} fails from byte 256 KiB`);
    const midway = requestFor(first);
    failFromOffset.set(midway.source.sourceKey, 256 * 1024);
    errorLog.length = 0;
    statusLog.length = 0;
    clockLog.length = 0;
    const midwayLoad = await session.load(midway, { ownerId: 1 });
    check(midwayLoad.ok === true, 'mid-play failure: the load itself resolves ok');
    // ffmpeg 会重连几次（约 1 s、3 s、7 s）才放弃。
    const brokeOff = await waitForState(state => state.trackKey === midway.trackKey && state.status === 'error', 'error after the source broke off', 25000);
    const midwayError = errorLog.find(event => event.trackKey === midway.trackKey);
    check(midwayError?.code === 'SOURCE_UNREACHABLE' && midwayError.fatal === true,
        `the break is a fatal ${midwayError?.code ?? 'nothing'} at ${brokeOff.positionSec.toFixed(2)} / ${brokeOff.durationSec} s`);
    check(!statusLog.some(entry => entry.trackKey === midway.trackKey && entry.status === 'ended'), 'the broken song never reports ended');
    check(clockLog.some(update => update.trackKey === midway.trackKey && update.reason === 'tick' && update.paused),
        'the clock stops while mpv waits for data that never comes');
    await sleep(300);
    check(lastState.audioOutParams === null && lastState.currentAo === null, `the output is closed after the failure (ao=${lastState.currentAo})`);

    console.log(`${stamp()} --- snapshot`);
    const snapshot = session.getSnapshot();
    console.log(`${stamp()} ${JSON.stringify({ status: snapshot.status, processRunning: snapshot.processRunning, errorCode: snapshot.errorCode, circuitOpen: snapshot.circuitOpen, seq: snapshot.seq })}`);

    console.log(`${stamp()} --- killSync`);
    session.killSync();
    await sleep(300);
    check(children.every(child => child.exitCode !== null || child.signalCode !== null), `every mpv is gone (${children.length} spawned)`);
    const afterKill = await session.load(requestFor(first), { ownerId: 1 });
    check(!afterKill.ok && afterKill.detail === 'stopped', `load after killSync answers ${afterKill.ok ? 'ok' : `${afterKill.errorCode} / ${afterKill.detail}`}`);
    const devicesAfterKill = await session.listDevices();
    check(devicesAfterKill.length === 0, 'listDevices after killSync spawns nothing');
    await sleep(300);
    check(children.every(child => child.exitCode !== null || child.signalCode !== null), `still no mpv running (${children.length} spawned)`);
} catch (error) {
    check(false, `threw: ${error?.stack ?? error}`);
} finally {
    await session.dispose();
    await bridge.stop();
    check(true, 'disposed');
    console.log(`${stamp()} ${failures === 0 ? 'all steps passed' : `${failures} step(s) failed`}`);
    process.exitCode = failures === 0 ? 0 : 1;
}

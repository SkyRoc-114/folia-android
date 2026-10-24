'use strict';

const { spawn: childSpawn } = require('child_process');
const { randomBytes: cryptoRandomBytes } = require('crypto');
const { createHifiError, isHifiErrorCode, toHifiErrorCode, sanitizeDetail, classifyEndFile } = require('./hifiErrors.cjs');
const { buildMpvArgs, buildPipeName, buildLoadfileCommand, sanitizeAudioDevice } = require('./mpvArgs.cjs');
const { createMpvIpcClient, connectNamedPipe } = require('./mpvIpcClient.cjs');

// mpv 会话的状态机：按需拉起 mpv，经 JSON IPC 下发载入和走带，把事件和属性变化归成 HifiEngineState 和节流后的时钟。

const OBSERVED_PROPERTIES = Object.freeze([
    'time-pos',
    'pause',
    'duration',
    'eof-reached',
    'audio-params',
    'audio-out-params',
    'current-ao',
    'audio-device',
    'playlist-pos',
    'playlist-count',
    'volume',
    'loop-file',
]);
const RECENT_LOG_LIMIT = 20;
const QUIT_GRACE_MS = 2000;
const STDERR_TAIL_CHARS = 2000;
const FAILURE_LOG_LEVELS = new Set(['fatal', 'error', 'warn']);
// Linux 上绕过混音器直连声卡的 ALSA 设备名。
const DIRECT_ALSA_DEVICE = /^alsa\/(plug)?hw:/i;

// 渲染端还没推设置时的取值：不独占，免得没人要求就把设备锁住。
const DEFAULT_CONFIG = Object.freeze({
    mpvPath: null,
    audioDevice: 'auto',
    exclusive: false,
    dsdMode: 'pcm',
    softwareVolume: false,
    volume: 100,
});

const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = value => (typeof value === 'string' && value !== '' ? value : null);

/** mpv 的 audio-params / audio-out-params 换成驼峰键；属性不可用（undefined）或不像样时为 null。 */
const toAudioParams = value => {
    if (!value || typeof value !== 'object') return null;
    const samplerate = numberOrNull(value.samplerate);
    if (samplerate === null) return null;
    return {
        samplerate,
        channelCount: numberOrNull(value['channel-count']) ?? 0,
        channels: typeof value.channels === 'string' ? value.channels : '',
        format: typeof value.format === 'string' ? value.format : '',
    };
};

/** track-list 里选中的音轨；没有音轨时为 null。 */
const toTrackInfo = trackList => {
    if (!Array.isArray(trackList)) return null;
    const audioTracks = trackList.filter(item => item && item.type === 'audio');
    const track = audioTracks.find(item => item.selected) ?? audioTracks[0];
    if (!track) return null;
    return {
        codec: stringOrNull(track.codec),
        codecDesc: stringOrNull(track['codec-desc']),
        decoder: stringOrNull(track.decoder),
        demuxSamplerate: numberOrNull(track['demux-samplerate']),
        demuxChannelCount: numberOrNull(track['demux-channel-count']),
        demuxBitrate: numberOrNull(track['demux-bitrate']),
        formatName: stringOrNull(track['format-name']),
    };
};

/** audio-device-list 的一项换成 HifiDevice；没有名字的项丢掉。 */
const toDevice = (platform, item) => {
    if (!item || typeof item.name !== 'string' || item.name === '') return null;
    const slash = item.name.indexOf('/');
    return {
        name: item.name,
        description: typeof item.description === 'string' ? item.description : item.name,
        driver: slash === -1 ? item.name : item.name.slice(0, slash),
        direct: platform === 'linux' && DIRECT_ALSA_DEVICE.test(item.name),
    };
};

const normalizeConfig = (config, previous) => {
    const source = config && typeof config === 'object' ? config : {};
    const volume = typeof source.volume === 'number' && Number.isFinite(source.volume)
        ? Math.min(100, Math.max(0, source.volume))
        : previous.volume;
    return {
        mpvPath: typeof source.mpvPath === 'string' && source.mpvPath.trim() !== '' ? source.mpvPath : null,
        audioDevice: sanitizeAudioDevice(source.audioDevice),
        exclusive: typeof source.exclusive === 'boolean' ? source.exclusive : previous.exclusive,
        dsdMode: source.dsdMode === 'dop' ? 'dop' : 'pcm',
        softwareVolume: source.softwareVolume === true,
        volume,
    };
};

// 关掉软件音量时 mpv 固定 100：音量交给 DAC / 功放，数据不过乘法。
const volumeFor = config => (config.softwareVolume ? config.volume : 100);
const spdifFor = config => (config.dsdMode === 'dop' ? 'dsd' : '');
const isLoopFileOn = value => value !== undefined && value !== false && value !== 'no' && value !== 0;
// 带码的错只留它的说明（码已经单独报了），别的错原样留着给说明。
const detailOf = error => (error && isHifiErrorCode(error.code) ? error.hifiDetail ?? null : error);

const createFileProps = () => ({
    timePos: null,
    duration: null,
    eofReached: false,
    audioParams: null,
    audioOutParams: null,
});

const createMpvProps = () => ({
    ...createFileProps(),
    paused: false,
    currentAo: null,
    audioDevice: null,
    volume: null,
    loopFile: null,
    playlistPos: -1,
    playlistCount: 0,
});

const createMpvSession = ({
    spawnFn = childSpawn,
    platform = process.platform,
    resolveRuntime,
    bridge,
    createIpcClient = createMpvIpcClient,
    connectPipe = connectNamedPipe,
    randomBytes = cryptoRandomBytes,
    now = () => Date.now(),
    setTimeoutFn = (callback, ms) => setTimeout(callback, ms),
    clearTimeoutFn = timer => clearTimeout(timer),
    onState = () => {},
    onClock = () => {},
    onError = () => {},
    logInfo = (...args) => console.info(...args),
    logWarn = (...args) => console.warn(...args),
    idleExitMs = 300000,
    crashWindowMs = 60000,
    crashLimit = 3,
    loadTimeoutMs = 20000,
    clockIntervalMs = 250,
    ao,
} = {}) => {
    if (typeof resolveRuntime !== 'function') throw new TypeError('HiFi mpv session needs resolveRuntime');
    if (!bridge) throw new TypeError('HiFi mpv session needs a source bridge');

    const isWindows = platform === 'win32';
    let config = { ...DEFAULT_CONFIG };
    /** 已连上、在用的进程：{ child, client, exited, intentional, ... }。 */
    let proc = null;
    /** 正在拉起、还没连好 IPC 的进程；它的事件也要收（订阅后 mpv 马上推一遍初值）。 */
    let launching = null;
    let starting = null;
    /** 已发 quit、等它退出的进程。 */
    const dying = new Set();
    let disposed = false;

    /** 状态里报告的那一项；载入中就是正在载入的那一项。 */
    let current = null;
    /** loadfile append 预载的下一项。 */
    let next = null;
    /** 还没落定的载入：{ entry, settle, timer, done }。 */
    let pending = null;
    /** 被替换下来、等 mpv 放手后撤销令牌的项。 */
    const retired = new Set();
    let startedEntryId = null;
    let recentLogs = [];

    let mpv = createMpvProps();
    let track = null;
    let applied = { audioDevice: config.audioDevice, exclusive: config.exclusive, spdif: spdifFor(config), volume: 100 };
    let loopFile = false;
    let errorCode = null;
    let circuitOpen = false;
    const crashTimes = [];
    let idleTimer = null;

    let stateSeq = 0;
    let stateScheduled = false;
    let clockSeq = 0;
    let lastClockAt = Number.NEGATIVE_INFINITY;
    let clockTimer = null;
    let forcedClockReason = null;

    const owns = record => record !== null && (record === proc || record === launching);
    const isPlayingEntry = () => Boolean(current && !current.failed);

    const callListener = (listener, value, what) => {
        try {
            listener(value);
        } catch (error) {
            logWarn(`[HiFi] ${what} listener threw`, error);
        }
    };

    const position = () => {
        if (!current) return 0;
        if (current.started && mpv.timePos !== null) return Math.max(0, mpv.timePos);
        return current.startSec;
    };

    const deriveStatus = () => {
        if (errorCode) return 'error';
        if (!proc) return starting ? 'starting' : 'stopped';
        if (pending) return 'loading';
        if (!current || !current.loaded) return 'idle';
        if (mpv.eofReached && !next) return 'ended';
        return mpv.paused ? 'paused' : 'playing';
    };

    const buildState = () => ({
        status: deriveStatus(),
        processRunning: proc !== null,
        trackKey: current?.trackKey ?? null,
        songKey: current?.songKey ?? null,
        sourceKind: current?.sourceKind ?? null,
        localSourceKey: current?.localSourceKey ?? null,
        durationSec: mpv.duration,
        positionSec: position(),
        paused: isPlayingEntry() ? mpv.paused : true,
        loopFile: proc && mpv.loopFile !== null ? mpv.loopFile : loopFile,
        audioParams: mpv.audioParams,
        audioOutParams: mpv.audioOutParams,
        currentAo: mpv.currentAo,
        audioDevice: mpv.audioDevice ?? applied.audioDevice,
        exclusive: applied.exclusive,
        spdif: applied.spdif || null,
        volume: mpv.volume ?? applied.volume,
        track,
        next: next ? { trackKey: next.trackKey, songKey: next.songKey } : null,
        errorCode,
        circuitOpen,
        seq: stateSeq,
    });

    const emitState = () => {
        stateScheduled = false;
        if (disposed) return;
        stateSeq += 1;
        callListener(onState, buildState(), 'state');
    };

    // 同一批 IPC 行里的多处变化合成一次推送。
    const scheduleState = () => {
        if (stateScheduled || disposed) return;
        stateScheduled = true;
        queueMicrotask(emitState);
    };

    const clearClockTimer = () => {
        if (clockTimer === null) return;
        clearTimeoutFn(clockTimer);
        clockTimer = null;
    };

    const pushClock = reason => {
        clearClockTimer();
        if (disposed) return;
        lastClockAt = now();
        clockSeq += 1;
        callListener(onClock, {
            trackKey: current?.trackKey ?? null,
            positionSec: position(),
            paused: isPlayingEntry() ? mpv.paused : true,
            reason,
            seq: clockSeq,
        }, 'clock');
    };

    // time-pos 每帧都变：最多每 clockIntervalMs 推一次，窗口内最后一个值用尾随定时器补上；跳转后的第一个值立刻推。
    const noteTimePos = value => {
        if (typeof value !== 'number' || !Number.isFinite(value) || !current?.started) return;
        mpv.timePos = value;
        if (forcedClockReason) {
            const reason = forcedClockReason;
            forcedClockReason = null;
            pushClock(reason);
            return;
        }
        const waitMs = lastClockAt + clockIntervalMs - now();
        if (waitMs <= 0) {
            pushClock('tick');
            return;
        }
        if (clockTimer === null) {
            clockTimer = setTimeoutFn(() => {
                clockTimer = null;
                pushClock('tick');
            }, waitMs);
        }
    };

    const clearIdleTimer = () => {
        if (idleTimer === null) return;
        clearTimeoutFn(idleTimer);
        idleTimer = null;
    };

    const hasActiveEntry = () => Boolean(pending || next || (current && current.loaded));

    // 进程开着却什么都没放：过 idleExitMs 让它退出，不在后台一直挂着。
    const armIdleTimer = () => {
        clearIdleTimer();
        if (!proc || disposed || hasActiveEntry()) return;
        idleTimer = setTimeoutFn(() => {
            idleTimer = null;
            if (!proc || hasActiveEntry()) return;
            logInfo(`[HiFi] mpv idle for ${Math.round(idleExitMs / 1000)} s, asking it to quit`);
            errorCode = null;
            void retireProcess(proc, { graceful: true });
            scheduleState();
        }, idleExitMs);
        idleTimer?.unref?.();
    };

    const revokeEntry = entry => {
        if (!entry?.token) return;
        try {
            bridge.revoke(entry.token);
        } catch (error) {
            logWarn('[HiFi] bridge revoke failed', error);
        }
        entry.token = null;
    };

    const retire = entry => {
        if (entry?.token) retired.add(entry);
    };

    const flushRetired = () => {
        for (const entry of retired) revokeEntry(entry);
        retired.clear();
    };

    const revokeAllEntries = () => {
        flushRetired();
        revokeEntry(pending?.entry);
        revokeEntry(current);
        revokeEntry(next);
    };

    const entryById = id => {
        if (typeof id !== 'number') return null;
        for (const entry of [pending?.entry, current, next]) {
            if (entry && entry.mpvId === id) return entry;
        }
        return null;
    };

    const retiredById = id => {
        for (const entry of retired) {
            if (entry.mpvId === id) return entry;
        }
        return null;
    };

    const send = (record, args) => {
        if (!record?.client) return Promise.reject(createHifiError('MPV_CRASHED', 'mpv is not running'));
        return record.client.command(args).catch(error => {
            // mpv 不回话就是卡死了：杀掉，按崩溃记一次。
            if (error?.code === 'IPC_TIMEOUT' && record === proc) {
                logWarn(`[HiFi] mpv did not answer ${args[0]}, killing it`, error);
                handleCrash(record, 'IPC_TIMEOUT', String(args[0]));
            }
            throw error;
        });
    };

    // 走带这类命令失败了只记一行：调用方是 void 接口，崩溃另有通道报。
    const runCommand = async (record, args) => {
        try {
            await send(record, args);
        } catch (error) {
            logWarn(`[HiFi] mpv ${args[0]} ${args[1] ?? ''} failed`.trimEnd(), error);
        }
    };

    const getProperty = (record, name) => send(record, ['get_property', name]).catch(() => null);

    const settleQuietly = attempt => {
        if (!attempt || attempt.done) return;
        attempt.done = true;
        clearTimeoutFn(attempt.timer);
        if (pending === attempt) pending = null;
        attempt.settle({ ok: false, errorCode: 'LOAD_FAILED', detail: 'stopped' });
    };

    const failAttempt = (attempt, code, detail, { stopPlayback = false } = {}) => {
        if (!attempt || attempt.done) return;
        attempt.done = true;
        clearTimeoutFn(attempt.timer);
        if (pending === attempt) pending = null;
        const { entry } = attempt;
        const cleanDetail = sanitizeDetail(detail);
        if (current === entry) {
            errorCode = code;
            entry.failed = true;
            if (stopPlayback && proc && entry.mpvId !== null) void runCommand(proc, ['stop']);
        }
        revokeEntry(entry);
        if (cleanDetail === 'superseded') logInfo(`[HiFi] load of ${entry.trackKey} superseded`);
        else logWarn(`[HiFi] load of ${entry.trackKey} failed (${code})${cleanDetail ? `: ${cleanDetail}` : ''}`);
        attempt.settle({ ok: false, errorCode: code, ...(cleanDetail ? { detail: cleanDetail } : {}) });
        armIdleTimer();
        scheduleState();
    };

    const resolveAttempt = attempt => {
        if (!attempt || attempt.done) return;
        attempt.done = true;
        clearTimeoutFn(attempt.timer);
        if (pending === attempt) pending = null;
        const { entry } = attempt;
        entry.loaded = true;
        flushRetired();
        const out = mpv.audioOutParams;
        logInfo(`[HiFi] loaded ${entry.sourceKind} ${entry.trackKey}`
            + (out ? ` -> ${mpv.currentAo ? `${mpv.currentAo} ` : ''}${out.samplerate} Hz ${out.format} ${out.channels}` : ''));
        if (entry.seekAfterLoad !== null && proc) {
            const target = entry.seekAfterLoad;
            entry.seekAfterLoad = null;
            void runCommand(proc, ['seek', target, 'absolute']);
        }
        attempt.settle({ ok: true, state: buildState() });
        scheduleState();
    };

    const noteCrash = () => {
        const at = now();
        crashTimes.push(at);
        while (crashTimes.length > 0 && at - crashTimes[0] > crashWindowMs) crashTimes.shift();
        if (!circuitOpen && crashTimes.length >= crashLimit) {
            circuitOpen = true;
            logWarn(`[HiFi] mpv failed ${crashTimes.length} times within ${Math.round(crashWindowMs / 1000)} s, HiFi stays off for this session`);
        }
    };

    const killChild = record => {
        if (record.exited) return;
        try {
            record.child.kill();
        } catch (error) {
            logWarn('[HiFi] mpv kill failed', error);
        }
    };

    const closeClient = record => {
        try {
            record.client?.close();
        } catch (error) {
            logWarn('[HiFi] mpv ipc close failed', error);
        }
    };

    // 不再用这个进程：先摘掉引用（它迟到的事件就进不来），再请它退出或直接杀掉。
    const retireProcess = (record, { graceful }) => {
        if (proc === record) {
            proc = null;
            mpv = createMpvProps();
            track = null;
            startedEntryId = null;
            forcedClockReason = null;
            clearClockTimer();
        }
        if (launching === record) launching = null;
        record.intentional = true;
        clearIdleTimer();
        if (record.exited) {
            closeClient(record);
            return Promise.resolve();
        }
        dying.add(record);
        const exited = new Promise(resolve => record.exitWaiters.push(resolve));
        if (graceful && record.client && !record.client.isClosed()) {
            record.client.command(['quit']).catch(() => {});
            record.killTimer = setTimeoutFn(() => {
                record.killTimer = null;
                if (record.exited) return;
                logWarn('[HiFi] mpv did not quit in time, killing it');
                closeClient(record);
                killChild(record);
            }, QUIT_GRACE_MS);
        } else {
            closeClient(record);
            killChild(record);
        }
        return exited;
    };

    // mpv 不是我们让它走的却没了（进程退出、IPC 断开、命令超时）：这一曲停了，下次载入重新拉起。
    const handleCrash = (record, code, detail) => {
        if (record !== proc) return;
        const trackKey = pending?.entry.trackKey ?? current?.trackKey ?? null;
        const stderrTail = record.stderrTail.trim();
        void retireProcess(record, { graceful: false });
        const attempt = pending;
        revokeAllEntries();
        next = null;
        if (current) {
            current.loaded = false;
            current.failed = true;
        }
        errorCode = code;
        noteCrash();
        logWarn(`[HiFi] mpv went away (${code}): ${sanitizeDetail(detail)}${stderrTail ? ` | stderr: ${sanitizeDetail(stderrTail)}` : ''}`);
        if (attempt) failAttempt(attempt, code, detail);
        callListener(onError, { code, trackKey, detail: sanitizeDetail(detail), fatal: true }, 'error');
        scheduleState();
    };

    const noteLog = message => {
        if (!FAILURE_LOG_LEVELS.has(message.level)) return;
        const line = {
            prefix: typeof message.prefix === 'string' ? message.prefix : '',
            level: message.level,
            text: typeof message.text === 'string' ? message.text.trim() : '',
        };
        recentLogs.push(line);
        if (recentLogs.length > RECENT_LOG_LIMIT) recentLogs.shift();
        if (line.level !== 'warn') logWarn(`[HiFi] mpv ${line.prefix}: ${sanitizeDetail(line.text)}`);
    };

    const startEntry = entry => {
        if (entry === next) {
            // 无缝接上了预载的那一首：它成为当前项，上一首的令牌等会儿撤销。
            if (current && current !== entry) retire(current);
            current = entry;
            next = null;
            entry.loaded = true;
            errorCode = null;
            logInfo(`[HiFi] gapless switch to ${entry.trackKey}`);
        }
        entry.started = true;
        mpv.timePos = null;
        mpv.eofReached = false;
        track = null;
        flushRetired();
        if (entry.loaded) pushClock('load');
        scheduleState();
    };

    const refreshTrack = (record, entry) => {
        void getProperty(record, 'track-list').then(list => {
            if (!owns(record) || current !== entry) return;
            track = toTrackInfo(list);
            scheduleState();
        });
    };

    // 同格式换曲时 mpv 不重开输出，audio-out-params 不会再推一次：开始播放时主动读一遍，读到非空就算载入成功。
    const refreshFormat = (record, entry) => {
        void Promise.all([getProperty(record, 'audio-params'), getProperty(record, 'audio-out-params')])
            .then(([params, outParams]) => {
                if (!owns(record) || current !== entry) return;
                mpv.audioParams = toAudioParams(params);
                mpv.audioOutParams = toAudioParams(outParams);
                scheduleState();
                if (mpv.audioOutParams && pending?.entry === entry && entry.started) resolveAttempt(pending);
            });
    };

    const handleEndFile = message => {
        const id = message.playlist_entry_id;
        const retiredEntry = retiredById(id);
        if (retiredEntry) {
            retired.delete(retiredEntry);
            revokeEntry(retiredEntry);
            return;
        }
        const entry = entryById(id);
        if (!entry) return;
        if (message.reason === 'redirect' && pending?.entry === entry) {
            failAttempt(pending, 'FORMAT_UNSUPPORTED', 'redirect', { stopPlayback: true });
            return;
        }
        if (message.reason !== 'error') return;
        const sourceError = entry.token ? bridge.getSourceError(entry.token) : null;
        const code = classifyEndFile({ reason: message.reason, fileError: message.file_error }, recentLogs, sourceError);
        const detail = typeof message.file_error === 'string' ? message.file_error : 'error';
        if (pending?.entry === entry) {
            failAttempt(pending, code, detail);
            return;
        }
        if (entry === next) {
            logWarn(`[HiFi] queued ${entry.trackKey} failed before it started (${code})`);
            revokeEntry(entry);
            next = null;
            scheduleState();
            return;
        }
        if (entry.failed) return;
        // 已经在放的那一首中途出错（源断了、输出设备没了）：报给渲染端回落。
        entry.loaded = false;
        entry.failed = true;
        errorCode = code;
        revokeEntry(entry);
        logWarn(`[HiFi] ${entry.trackKey} stopped with an error (${code}): ${sanitizeDetail(detail)}`);
        callListener(onError, { code, trackKey: entry.trackKey, detail: sanitizeDetail(detail), fatal: true }, 'error');
        armIdleTimer();
        scheduleState();
    };

    const handleEvent = (record, message) => {
        if (!owns(record)) return;
        switch (message.event) {
        case 'log-message':
            noteLog(message);
            break;
        case 'start-file': {
            startedEntryId = typeof message.playlist_entry_id === 'number' ? message.playlist_entry_id : null;
            const entry = entryById(startedEntryId);
            if (entry) startEntry(entry);
            break;
        }
        case 'end-file':
            handleEndFile(message);
            break;
        case 'file-loaded':
            if (current?.started && current.mpvId === startedEntryId) refreshTrack(record, current);
            break;
        case 'playback-restart':
            if (current?.started && current.mpvId === startedEntryId) {
                forcedClockReason = current.restarted ? 'seek' : 'load';
                current.restarted = true;
                refreshFormat(record, current);
            }
            break;
        case 'idle':
            scheduleState();
            break;
        default:
            break;
        }
    };

    const handlePropertyChange = (record, name, value) => {
        if (!owns(record)) return;
        switch (name) {
        case 'time-pos':
            noteTimePos(value);
            return;
        case 'pause': {
            const paused = value === true;
            if (paused === mpv.paused) return;
            mpv.paused = paused;
            if (current?.started) pushClock(paused ? 'pause' : 'resume');
            break;
        }
        case 'duration':
            mpv.duration = numberOrNull(value);
            break;
        case 'eof-reached':
            mpv.eofReached = value === true;
            if (mpv.eofReached && current?.loaded && !next) logInfo(`[HiFi] ${current.trackKey} reached the end`);
            break;
        case 'audio-params':
            mpv.audioParams = toAudioParams(value);
            break;
        case 'audio-out-params':
            mpv.audioOutParams = toAudioParams(value);
            // 开了新的输出（换了格式或设备），说明这一项的声音出来了。
            if (mpv.audioOutParams && pending?.entry.started && pending.entry === current) resolveAttempt(pending);
            break;
        case 'current-ao':
            mpv.currentAo = stringOrNull(value);
            break;
        case 'audio-device':
            mpv.audioDevice = stringOrNull(value);
            break;
        case 'volume':
            mpv.volume = numberOrNull(value);
            break;
        case 'loop-file':
            mpv.loopFile = isLoopFileOn(value);
            break;
        case 'playlist-pos':
            mpv.playlistPos = numberOrNull(value) ?? -1;
            return;
        case 'playlist-count':
            mpv.playlistCount = numberOrNull(value) ?? 0;
            return;
        default:
            return;
        }
        scheduleState();
    };

    const handleExit = (record, code, signal) => {
        record.exited = true;
        if (record.killTimer !== null) {
            clearTimeoutFn(record.killTimer);
            record.killTimer = null;
        }
        dying.delete(record);
        for (const resolve of record.exitWaiters.splice(0)) resolve();
        if (record === launching) {
            record.failStartup(createHifiError('MPV_SPAWN_FAILED', `exited during startup (code ${code}, signal ${signal})`));
            return;
        }
        if (record !== proc || record.intentional) {
            closeClient(record);
            return;
        }
        handleCrash(record, 'MPV_CRASHED', `exit code ${code}, signal ${signal}`);
    };

    // 拉起一个 mpv 并连好 IPC：Unix 走 spawn 出的 socketpair（fd 3，父进程没了 mpv 也跟着退），Windows 走随机命名管道。
    const spawnProcess = async () => {
        const runtime = await resolveRuntime();
        if (!runtime || typeof runtime.path !== 'string' || runtime.path === '') throw createHifiError('MPV_NOT_FOUND');
        if (disposed) throw createHifiError('LOAD_FAILED', 'session disposed');
        const spawnConfig = { ...config };
        const pipePath = isWindows ? buildPipeName(randomBytes(16).toString('hex')) : null;
        const args = buildMpvArgs({
            platform,
            ipc: isWindows ? { kind: 'pipe', path: pipePath } : { kind: 'fd' },
            audioDevice: spawnConfig.audioDevice,
            exclusive: spawnConfig.exclusive,
            dsdMode: spawnConfig.dsdMode,
            ao,
        });
        let child;
        try {
            child = spawnFn(runtime.path, args, {
                stdio: isWindows ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            logWarn('[HiFi] mpv spawn threw', error);
            throw createHifiError('MPV_SPAWN_FAILED', error);
        }
        const record = {
            child,
            client: null,
            exited: false,
            intentional: false,
            stderrTail: '',
            killTimer: null,
            exitWaiters: [],
            nextEntryId: 1,
            abort: new AbortController(),
            failStartup: () => {},
        };
        const startupFailed = new Promise((_resolve, reject) => {
            record.failStartup = error => {
                record.abort.abort();
                reject(error);
            };
        });
        startupFailed.catch(() => {});
        launching = record;
        child.on('error', error => {
            logWarn('[HiFi] mpv process error', error);
            if (record === launching) record.failStartup(createHifiError('MPV_SPAWN_FAILED', error));
        });
        child.on('exit', (code, signal) => handleExit(record, code, signal));
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', chunk => {
            record.stderrTail = `${record.stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
        });

        try {
            const socket = isWindows
                ? await Promise.race([connectPipe(pipePath, { signal: record.abort.signal }), startupFailed])
                : child.stdio?.[3];
            if (!socket) throw createHifiError('MPV_SPAWN_FAILED', 'mpv has no ipc socket');
            const client = createIpcClient({ socket, setTimeoutFn, clearTimeoutFn, logWarn });
            record.client = client;
            client.onEvent(message => handleEvent(record, message));
            for (const name of OBSERVED_PROPERTIES) {
                client.onPropertyChange(name, value => handlePropertyChange(record, name, value));
            }
            client.onClose(info => {
                if (info?.intentional || record.intentional) return;
                if (record === launching) {
                    record.failStartup(createHifiError('MPV_SPAWN_FAILED', info?.error || 'ipc closed during startup'));
                    return;
                }
                handleCrash(record, 'MPV_CRASHED', info?.error || 'ipc closed');
            });
            await Promise.race([
                Promise.all([
                    client.command(['request_log_messages', 'warn']),
                    ...OBSERVED_PROPERTIES.map(name => client.observeProperty(name)),
                ]),
                startupFailed,
            ]);
        } catch (error) {
            if (launching === record) launching = null;
            void retireProcess(record, { graceful: false });
            logWarn('[HiFi] mpv did not start', error);
            throw createHifiError('MPV_SPAWN_FAILED', detailOf(error) ?? error?.code);
        }
        // 启动期间被 dispose / killSync 收掉了：不算 mpv 的错。
        if (disposed || launching !== record) {
            if (launching === record) launching = null;
            void retireProcess(record, { graceful: false });
            throw createHifiError('LOAD_FAILED', 'session stopped during startup');
        }
        launching = null;
        proc = record;
        applied = {
            audioDevice: spawnConfig.audioDevice,
            exclusive: spawnConfig.exclusive,
            spdif: spdifFor(spawnConfig),
            volume: 100,
        };
        logInfo(`[HiFi] ${runtime.version ? `mpv ${runtime.version}` : 'mpv'} started (pid ${child.pid ?? '?'})`);
        // 启动期间设置又变了，或开着软件音量：补发和启动参数不同的那几项。
        void applyConfig(record);
        return record;
    };

    const ensureProcess = () => {
        if (proc) return Promise.resolve(proc);
        if (!starting) {
            starting = spawnProcess().then(
                record => {
                    starting = null;
                    // 拉起期间载入被 stop 收掉了：没人用它，照常计空闲。
                    armIdleTimer();
                    scheduleState();
                    return record;
                },
                error => {
                    starting = null;
                    if (toHifiErrorCode(error) === 'MPV_SPAWN_FAILED') noteCrash();
                    scheduleState();
                    throw error;
                },
            );
            scheduleState();
        }
        return starting;
    };

    const createEntry = (request, ownerId) => ({
        trackKey: request.trackKey,
        songKey: request.songKey,
        sourceKind: request.source.kind,
        localSourceKey: request.source.kind === 'local' ? request.source.sourceKey : null,
        startSec: typeof request.startSec === 'number' && request.startSec > 0 ? request.startSec : 0,
        ownerId,
        token: null,
        mpvId: null,
        started: false,
        restarted: false,
        loaded: false,
        failed: false,
        seekAfterLoad: null,
    });

    // 在来源桥上登记，拿到给 mpv 的 127.0.0.1 地址；Navidrome 带凭据的地址只留在桥里。
    const registerSource = (entry, source) => {
        const registered = source.kind === 'local'
            ? bridge.registerLocal({
                sourceKey: source.sourceKey,
                size: source.size,
                mimeType: source.mimeType,
                fileName: source.fileName,
                ownerId: entry.ownerId,
            })
            : bridge.registerRemote({ url: source.url, fileName: source.fileName });
        entry.token = registered.token;
        return registered.url;
    };

    // mpv 的 playlist_entry_id 从 1 起逐个分配；发 loadfile 时就记下预计的 id，start-file 可能比回复先到。
    const sendLoadfile = async (record, entry, url, mode, startSec) => {
        entry.mpvId = record.nextEntryId;
        record.nextEntryId += 1;
        const reply = await send(record, buildLoadfileCommand(url, mode, { startSec }));
        const actualId = reply && typeof reply.playlist_entry_id === 'number' ? reply.playlist_entry_id : null;
        if (actualId !== null && actualId !== entry.mpvId) {
            logWarn(`[HiFi] mpv gave entry id ${actualId}, expected ${entry.mpvId}`);
            entry.mpvId = actualId;
            record.nextEntryId = actualId + 1;
        }
    };

    const runLoad = async (attempt, request) => {
        const record = await ensureProcess();
        if (pending !== attempt) return;
        await bridge.start();
        if (pending !== attempt || proc !== record) return;
        const url = registerSource(attempt.entry, request.source);
        loopFile = request.loopFile === true;
        await send(record, ['set_property', 'pause', request.paused === true]);
        await send(record, ['set_property', 'loop-file', loopFile ? 'inf' : 'no']);
        if (pending !== attempt || proc !== record) return;
        await sendLoadfile(record, attempt.entry, url, 'replace', attempt.entry.startSec);
    };

    /** 用 loadfile replace 载入一首；声音输出真的开起来（audio-out-params 非空）才算成功。 */
    const load = (request, { ownerId = null } = {}) => {
        if (disposed) return Promise.resolve({ ok: false, errorCode: 'LOAD_FAILED', detail: 'disposed' });
        if (circuitOpen) return Promise.resolve({ ok: false, errorCode: 'CIRCUIT_OPEN' });
        if (!request || !request.source || (request.source.kind !== 'local' && request.source.kind !== 'navidrome')) {
            return Promise.resolve({ ok: false, errorCode: 'INVALID_REQUEST' });
        }
        const entry = createEntry(request, ownerId);
        const previousAttempt = pending;
        const attempt = { entry, settle: null, timer: null, done: false };
        const result = new Promise(resolve => {
            attempt.settle = resolve;
        });
        clearIdleTimer();
        // replace 会清掉整个播放列表：当前项和预载项都退下。
        if (current && current !== previousAttempt?.entry) retire(current);
        if (next) {
            retire(next);
            next = null;
        }
        pending = attempt;
        current = entry;
        errorCode = null;
        recentLogs = [];
        track = null;
        mpv = { ...mpv, ...createFileProps(), paused: request.paused === true };
        forcedClockReason = null;
        if (previousAttempt) failAttempt(previousAttempt, 'LOAD_FAILED', 'superseded');
        attempt.timer = setTimeoutFn(() => {
            failAttempt(attempt, 'LOAD_FAILED', 'timeout', { stopPlayback: true });
        }, loadTimeoutMs);
        pushClock('load');
        scheduleState();
        runLoad(attempt, request).catch(error => {
            failAttempt(attempt, toHifiErrorCode(error, 'LOAD_FAILED'), detailOf(error));
        });
        return result;
    };

    const play = async () => {
        const record = proc;
        if (!record || !current || current.failed) return;
        // keep-open 停在了末尾：像 <audio> 那样从头再放。
        if (current.loaded && mpv.eofReached && !next) await runCommand(record, ['seek', 0, 'absolute']);
        await runCommand(record, ['set_property', 'pause', false]);
    };

    const pause = async () => {
        const record = proc;
        if (!record || !current || current.failed) return;
        await runCommand(record, ['set_property', 'pause', true]);
    };

    const seek = async positionSec => {
        if (typeof positionSec !== 'number' || !Number.isFinite(positionSec)) return;
        const target = Math.max(0, positionSec);
        const record = proc;
        if (!record || !current || current.failed) return;
        if (!current.loaded) {
            current.seekAfterLoad = target;
            return;
        }
        // 先按目标位置推一次，跳完的 playback-restart 之后再按 mpv 的实际位置推一次。
        mpv.timePos = target;
        mpv.eofReached = false;
        pushClock('seek');
        await runCommand(record, ['seek', target, 'absolute']);
    };

    const setLoopFile = async loop => {
        loopFile = loop === true;
        if (proc) await runCommand(proc, ['set_property', 'loop-file', loopFile ? 'inf' : 'no']);
        scheduleState();
    };

    // 按 id 在 mpv 的播放列表里找到预载项再删；它要是已经开始播了就不动。
    const removeQueuedEntry = async (record, entry) => {
        if (entry.mpvId === null) return;
        const playlist = await getProperty(record, 'playlist');
        if (!Array.isArray(playlist) || proc !== record || current === entry || pending) return;
        const index = playlist.findIndex(item => item && item.id === entry.mpvId);
        if (index === -1 || playlist[index].current || playlist[index].playing) return;
        await runCommand(record, ['playlist-remove', index]);
    };

    /** 用 loadfile append 预载下一首，接在当前这首后面无缝播放；当前没在放时返回 false。 */
    const preloadNext = async (request, { ownerId = null } = {}) => {
        if (disposed || circuitOpen || !proc || pending || !current?.loaded) return false;
        if (!request || !request.source || (request.source.kind !== 'local' && request.source.kind !== 'navidrome')) return false;
        const record = proc;
        const base = current;
        const entry = createEntry({ ...request, startSec: 0 }, ownerId);
        try {
            await bridge.start();
        } catch (error) {
            logWarn('[HiFi] bridge did not start for the queued song', error);
            return false;
        }
        if (proc !== record || current !== base || pending || !current.loaded) return false;
        let url;
        try {
            url = registerSource(entry, request.source);
        } catch (error) {
            logWarn('[HiFi] could not register the queued song', error);
            return false;
        }
        clearIdleTimer();
        const previousNext = next;
        next = entry;
        if (previousNext) {
            retire(previousNext);
            void removeQueuedEntry(record, previousNext);
        }
        scheduleState();
        try {
            await sendLoadfile(record, entry, url, 'append', 0);
        } catch (error) {
            logWarn(`[HiFi] could not queue ${entry.trackKey}`, error);
            if (next === entry) next = null;
            revokeEntry(entry);
            scheduleState();
            return false;
        }
        return next === entry || current === entry;
    };

    const clearNext = async () => {
        const entry = next;
        if (!entry) return;
        next = null;
        retire(entry);
        scheduleState();
        if (proc) await removeQueuedEntry(proc, entry);
        if (retired.has(entry)) {
            retired.delete(entry);
            revokeEntry(entry);
        }
    };

    /** 停下并让 mpv 关掉音频输出（独占的设备立刻还给系统），进程留着，空闲一段时间后再退出。 */
    const stop = async () => {
        settleQuietly(pending);
        const record = proc;
        const stopped = record ? runCommand(record, ['stop']) : Promise.resolve();
        revokeAllEntries();
        current = null;
        next = null;
        errorCode = null;
        track = null;
        mpv = { ...mpv, ...createFileProps() };
        forcedClockReason = null;
        clearClockTimer();
        scheduleState();
        await stopped;
        armIdleTimer();
    };

    // 运行中的 mpv 和设置对不上的项逐个 set_property；只发变了的，audio-device / audio-exclusive / audio-spdif 一改 mpv 就重开输出。
    const applyConfig = async record => {
        const target = {
            audioDevice: config.audioDevice,
            exclusive: config.exclusive,
            spdif: spdifFor(config),
            volume: volumeFor(config),
        };
        const commands = [];
        if (target.audioDevice !== applied.audioDevice) commands.push(['set_property', 'audio-device', target.audioDevice]);
        if (target.exclusive !== applied.exclusive) commands.push(['set_property', 'audio-exclusive', target.exclusive]);
        if (target.spdif !== applied.spdif) commands.push(['set_property', 'audio-spdif', target.spdif]);
        if (target.volume !== applied.volume) commands.push(['set_property', 'volume', target.volume]);
        applied = target;
        await Promise.all(commands.map(command => runCommand(record, command)));
    };

    const configure = async nextConfig => {
        config = normalizeConfig(nextConfig, config);
        scheduleState();
        if (proc) await applyConfig(proc);
    };

    const listDevices = async () => {
        if (disposed || circuitOpen) return [];
        const record = await ensureProcess();
        try {
            const list = await send(record, ['get_property', 'audio-device-list']);
            return Array.isArray(list) ? list.map(item => toDevice(platform, item)).filter(Boolean) : [];
        } finally {
            armIdleTimer();
        }
    };

    const getSnapshot = () => buildState();

    /** 慢慢退：请 mpv 自己 quit，2 秒不走再杀。 */
    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        clearIdleTimer();
        clearClockTimer();
        settleQuietly(pending);
        revokeAllEntries();
        current = null;
        next = null;
        const records = [proc, launching].filter(Boolean);
        await Promise.all(records.map(record => retireProcess(record, { graceful: true })));
    };

    /** app.exit 之类马上就走的路径：同步杀掉所有 mpv，不等也不推状态。 */
    const killSync = () => {
        clearIdleTimer();
        clearClockTimer();
        for (const record of [proc, launching, ...dying]) {
            if (!record) continue;
            record.intentional = true;
            if (record.killTimer !== null) {
                clearTimeoutFn(record.killTimer);
                record.killTimer = null;
            }
            killChild(record);
            closeClient(record);
        }
        proc = null;
        launching = null;
        dying.clear();
        settleQuietly(pending);
    };

    return {
        configure,
        listDevices,
        load,
        play,
        pause,
        seek,
        stop,
        setLoopFile,
        preloadNext,
        clearNext,
        getSnapshot,
        dispose,
        killSync,
    };
};

module.exports = {
    OBSERVED_PROPERTIES,
    toAudioParams,
    toTrackInfo,
    toDevice,
    createMpvSession,
};

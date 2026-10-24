'use strict';

const path = require('path');
const { randomUUID: cryptoRandomUUID } = require('crypto');
const { createSenderGuardedHandler } = require('../ipcAccessGuard.cjs');
const { createHifiError } = require('./hifiErrors.cjs');

// HiFi 的 IPC 层：只认主窗口的调用并校验每个载荷，把状态推回主窗口，替来源桥向持有 File 的渲染进程要字节。

const MAX_TEXT_CHARS = 4096;
const MAX_KEY_CHARS = 256;
const DEFAULT_READ_TIMEOUT_MS = 10000;
const SOURCE_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const INVOKE_CHANNELS = Object.freeze([
    'hifi:get-runtime-status',
    'hifi:detect-runtime',
    'hifi:pick-runtime-path',
    'hifi:install-runtime',
    'hifi:cancel-install',
    'hifi:configure',
    'hifi:list-devices',
    'hifi:load',
    'hifi:play',
    'hifi:pause',
    'hifi:seek',
    'hifi:stop',
    'hifi:set-loop-file',
    'hifi:preload-next',
    'hifi:clear-next',
    'hifi:get-snapshot',
]);
const READ_RESULT_CHANNEL = 'hifi:read-result';
const PUSH_CHANNELS = Object.freeze({
    state: 'hifi:state',
    clock: 'hifi:clock',
    error: 'hifi:error',
    installProgress: 'hifi:install-progress',
    read: 'hifi:read',
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.length <= MAX_TEXT_CHARS;
// trackKey 是 `${songKey}#${随机}`，songKey 里是任意的曲目 id：只限长度和控制字符。
const isKeyLabel = value => typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_KEY_CHARS
    && !CONTROL_CHARS.test(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

const isHttpUrl = value => {
    if (!isText(value) || value === '') return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

const validateSource = source => {
    if (!isPlainObject(source)) return null;
    if (source.kind === 'local') {
        const { sourceKey, size, mimeType, fileName } = source;
        if (typeof sourceKey !== 'string' || !SOURCE_KEY_PATTERN.test(sourceKey)) return null;
        if (!Number.isSafeInteger(size) || size < 0) return null;
        if (!isText(mimeType) || !isText(fileName)) return null;
        return { kind: 'local', sourceKey, size, mimeType, fileName };
    }
    if (source.kind === 'navidrome') {
        const { url, fileName } = source;
        if (!isHttpUrl(url) || !isText(fileName)) return null;
        return { kind: 'navidrome', url, fileName };
    }
    return null;
};

/** HifiLoadRequest 的校验；不合格时为 null。返回的是只含已知字段的副本。 */
const validateLoadRequest = request => {
    if (!isPlainObject(request)) return null;
    const { trackKey, songKey, startSec, paused, loopFile } = request;
    if (!isKeyLabel(trackKey) || !isKeyLabel(songKey)) return null;
    if (!isFiniteNumber(startSec) || startSec < 0) return null;
    if (typeof paused !== 'boolean' || typeof loopFile !== 'boolean') return null;
    const source = validateSource(request.source);
    if (!source) return null;
    return { trackKey, songKey, source, startSec, paused, loopFile };
};

/** HifiEngineConfig 的校验；不合格时为 null。 */
const validateEngineConfig = config => {
    if (!isPlainObject(config)) return null;
    const { mpvPath, audioDevice, exclusive, dsdMode, softwareVolume, volume } = config;
    if (mpvPath !== null && !(isText(mpvPath) && !CONTROL_CHARS.test(mpvPath))) return null;
    if (!isText(audioDevice)) return null;
    if (typeof exclusive !== 'boolean' || typeof softwareVolume !== 'boolean') return null;
    if (dsdMode !== 'pcm' && dsdMode !== 'dop') return null;
    if (!isFiniteNumber(volume) || volume < 0 || volume > 100) return null;
    return {
        mpvPath: mpvPath !== null && mpvPath.trim() !== '' ? mpvPath : null,
        audioDevice,
        exclusive,
        dsdMode,
        softwareVolume,
        volume,
    };
};

const toUint8Array = data => {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
};

/** 渲染端的读回应收成 HifiReadResponse；多给的字节截掉，认不出的一律算 failed。 */
const normalizeReadResponse = (response, length) => {
    if (isPlainObject(response) && response.status === 'ok') {
        const data = toUint8Array(response.data);
        if (!data) return { status: 'failed' };
        return { status: 'ok', data: data.byteLength > length ? data.subarray(0, length) : data };
    }
    if (isPlainObject(response) && response.status === 'unknown-source') return { status: 'unknown-source' };
    return { status: 'failed' };
};

/** macOS 上选中的是 mpv.app 时换成包里的可执行文件。 */
const resolvePickedRuntimePath = (picked, platform) => {
    if (platform !== 'darwin' || !/\.app\/?$/i.test(picked)) return picked;
    return path.posix.join(picked.replace(/\/+$/, ''), 'Contents', 'MacOS', 'mpv');
};

const registerHifiIpc = ({
    ipcMain,
    isTrustedSender,
    session,
    runtime,
    installer,
    dialog,
    getMainWindow,
    webContentsFromId,
    onRuntimeChanged = () => {},
    platform = process.platform,
    randomUUID = cryptoRandomUUID,
    setTimeoutFn = (callback, ms) => setTimeout(callback, ms),
    clearTimeoutFn = timer => clearTimeout(timer),
    readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    logWarn = (...args) => console.warn(...args),
} = {}) => {
    /** 渲染端设置里的手动 mpv 路径；检测和拉起都用它。 */
    let manualPath = null;
    /** 运行时缓存是按哪个手动路径测出来的；undefined 表示还没测过。 */
    let detectedFor;
    /** readId → { webContentsId, length, settle } */
    const pendingReads = new Map();

    const handle = (channel, handler, onUntrusted) => {
        ipcMain.handle(channel, createSenderGuardedHandler({
            channel,
            isTrusted: isTrustedSender,
            ...(onUntrusted ? { onUntrusted } : {}),
            handler,
        }));
    };

    const notifyRuntime = status => {
        try {
            onRuntimeChanged(status);
        } catch (error) {
            logWarn('[HiFi] runtime change listener threw', error);
        }
    };

    const detect = async () => {
        const forPath = manualPath;
        const status = await runtime.detect({ manualPath: forPath });
        detectedFor = forPath;
        notifyRuntime(status);
        return status;
    };

    const currentRuntimeStatus = async () => {
        const cached = runtime.getCachedStatus();
        if (cached && detectedFor === manualPath) return cached;
        return detect();
    };

    /** 给会话拉起 mpv 用：每次重新检测，路径换过、文件删了都能及时知道。 */
    const resolveRuntime = async () => {
        const status = await detect();
        return status?.available && status.path ? { path: status.path, version: status.version ?? null } : null;
    };

    const sendToMainWindow = (channel, payload) => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return;
        const contents = win.webContents;
        if (!contents || contents.isDestroyed()) return;
        try {
            contents.send(channel, payload);
        } catch (error) {
            logWarn(`[HiFi] could not push ${channel}`, error);
        }
    };

    // 读请求发给登记这个源的那个渲染进程；它已经没了（窗口重建）就发给现在的主窗口。
    const resolveReadTarget = ownerId => {
        let owner = null;
        try {
            owner = Number.isInteger(ownerId) ? webContentsFromId(ownerId) : null;
        } catch {
            owner = null;
        }
        if (owner && !owner.isDestroyed()) return owner;
        const win = getMainWindow();
        const contents = win && !win.isDestroyed() ? win.webContents : null;
        return contents && !contents.isDestroyed() ? contents : null;
    };

    /** 向渲染端要本地源的一段字节；10 秒不回算 failed，目标页面没了算 unknown-source（来源桥会改问新窗口）。 */
    const requestRead = (ownerId, request) => new Promise(resolve => {
        const target = resolveReadTarget(ownerId);
        if (!target) {
            resolve({ status: 'unknown-source' });
            return;
        }
        const readId = randomUUID();
        let timer = null;
        const onDestroyed = () => settle({ status: 'unknown-source' });
        const settle = response => {
            if (!pendingReads.has(readId)) return;
            pendingReads.delete(readId);
            clearTimeoutFn(timer);
            target.removeListener?.('destroyed', onDestroyed);
            resolve(response);
        };
        pendingReads.set(readId, { webContentsId: target.id, length: request.length, settle });
        timer = setTimeoutFn(() => {
            logWarn(`[HiFi] renderer did not answer read ${readId.slice(0, 8)} within ${readTimeoutMs} ms`);
            settle({ status: 'failed' });
        }, readTimeoutMs);
        target.once?.('destroyed', onDestroyed);
        try {
            target.send(PUSH_CHANNELS.read, {
                readId,
                sourceKey: request.sourceKey,
                offset: request.offset,
                length: request.length,
            });
        } catch (error) {
            logWarn('[HiFi] could not send a read request to the renderer', error);
            settle({ status: 'unknown-source' });
        }
    });

    handle('hifi:get-runtime-status', () => currentRuntimeStatus(), () => null);
    handle('hifi:detect-runtime', () => detect());
    handle('hifi:pick-runtime-path', async () => {
        const win = getMainWindow();
        const options = { properties: ['openFile'] };
        const result = win && !win.isDestroyed()
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options);
        if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) return null;
        return resolvePickedRuntimePath(result.filePaths[0], platform);
    });
    handle('hifi:install-runtime', async () => {
        const result = await installer.install();
        const status = await detect();
        const ok = result?.ok === true;
        return { ok, errorCode: ok ? null : (result?.errorCode ?? 'INSTALL_FAILED'), status };
    });
    handle('hifi:cancel-install', () => {
        installer.cancel();
    });
    handle('hifi:configure', async (_event, config) => {
        const valid = validateEngineConfig(config);
        if (!valid) throw createHifiError('INVALID_REQUEST', 'configure');
        manualPath = valid.mpvPath;
        await session.configure(valid);
    });
    handle('hifi:list-devices', async () => {
        try {
            return await session.listDevices();
        } catch (error) {
            logWarn('[HiFi] could not list audio devices', error);
            return [];
        }
    });
    handle('hifi:load', async (event, request) => {
        const valid = validateLoadRequest(request);
        if (!valid) return { ok: false, errorCode: 'INVALID_REQUEST' };
        return session.load(valid, { ownerId: event.sender.id });
    });
    handle('hifi:play', async () => {
        await session.play();
    });
    handle('hifi:pause', async () => {
        await session.pause();
    });
    handle('hifi:seek', async (_event, positionSec) => {
        if (!isFiniteNumber(positionSec) || positionSec < 0) throw createHifiError('INVALID_REQUEST', 'seek');
        await session.seek(positionSec);
    });
    handle('hifi:stop', async () => {
        await session.stop();
    });
    handle('hifi:set-loop-file', async (_event, loop) => {
        if (typeof loop !== 'boolean') throw createHifiError('INVALID_REQUEST', 'set-loop-file');
        await session.setLoopFile(loop);
    });
    handle('hifi:preload-next', async (event, request) => {
        const valid = validateLoadRequest(request);
        if (!valid) return false;
        return (await session.preloadNext(valid, { ownerId: event.sender.id })) === true;
    });
    handle('hifi:clear-next', async () => {
        await session.clearNext();
    });
    handle('hifi:get-snapshot', () => session.getSnapshot(), () => null);

    // 读回应不看主窗口，只认这次读请求发去的那个页面：窗口重建时旧窗口还在回它手里那个 File 的字节。
    ipcMain.handle(READ_RESULT_CHANNEL, (event, readId, response) => {
        if (typeof readId !== 'string') throw createHifiError('INVALID_REQUEST', 'read-result');
        const read = pendingReads.get(readId);
        if (!read) return;
        if (event?.sender?.id !== read.webContentsId) {
            throw new Error(`Untrusted renderer attempted to call the ${READ_RESULT_CHANNEL} channel.`);
        }
        read.settle(normalizeReadResponse(response, read.length));
    });

    return {
        requestRead,
        resolveRuntime,
        broadcastState: state => sendToMainWindow(PUSH_CHANNELS.state, state),
        broadcastClock: update => sendToMainWindow(PUSH_CHANNELS.clock, update),
        broadcastError: event => sendToMainWindow(PUSH_CHANNELS.error, event),
        broadcastInstallProgress: progress => sendToMainWindow(PUSH_CHANNELS.installProgress, progress),
    };
};

module.exports = {
    INVOKE_CHANNELS,
    READ_RESULT_CHANNEL,
    PUSH_CHANNELS,
    validateLoadRequest,
    validateEngineConfig,
    normalizeReadResponse,
    resolvePickedRuntimePath,
    registerHifiIpc,
};

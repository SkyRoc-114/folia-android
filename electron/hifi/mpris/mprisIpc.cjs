'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSenderGuardedHandler } = require('../../ipcAccessGuard.cjs');
const { connectBus } = require('./dbusConnection.cjs');
const { sessionBusAddress } = require('./dbusWire.cjs');
const { createMprisService } = require('./mprisService.cjs');

// Linux 的 MPRIS 接入点：只认主窗口推来的 HiFi 播放状态和封面并逐项校验，把系统媒体面板的按键转回主窗口。

const STATE_CHANNEL = 'hifi:mpris-state';
const ARTWORK_CHANNEL = 'hifi:mpris-artwork';
const COMMAND_CHANNEL = 'hifi:mpris-command';

const MAX_TEXT_CHARS = 1024;
const MAX_ARTISTS = 32;
const MAX_KEY_CHARS = 256;
const MAX_ARTWORK_BYTES = 16 * 1024 * 1024;
const MAX_URL_CHARS = 8192;
const STATUSES = new Set(['Playing', 'Paused', 'Stopped']);
const ARTWORK_EXTENSIONS = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
});
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ARTWORK_FILE_PATTERN = /^cover-[0-9a-f]{40}\.[a-z]+$/;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isKeyLabel = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_CHARS && !CONTROL_CHARS.test(value);
// D-Bus 的字符串里不能有 NUL；别的控制字符换成空格，免得面板里出怪字。
const cleanText = value => (typeof value === 'string' ? value.slice(0, MAX_TEXT_CHARS).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '');

/** 推来的状态；不合规的一律当作不活动（交还总线名），不抛。 */
const validateMprisState = value => {
    if (!isPlainObject(value) || value.active !== true) return { active: false };
    const { trackKey, title, artists, album, durationSec, status, positionSec, atMs, seeked } = value;
    if (!isKeyLabel(trackKey) || !STATUSES.has(status)) return { active: false };
    if (!isFiniteNumber(positionSec) || !isFiniteNumber(atMs)) return { active: false };
    return {
        active: true,
        trackKey,
        title: cleanText(title),
        artists: Array.isArray(artists) ? artists.slice(0, MAX_ARTISTS).map(cleanText).filter(Boolean) : [],
        album: cleanText(album),
        durationSec: isFiniteNumber(durationSec) && durationSec > 0 ? durationSec : null,
        status,
        positionSec: Math.max(0, positionSec),
        atMs,
        seeked: seeked === true,
    };
};

const isHttpUrl = value => {
    if (typeof value !== 'string' || value === '' || value.length > MAX_URL_CHARS) return false;
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

/** 封面：{ bytes, mimeType }（渲染进程读到的图片字节）或 { url }（读不到时的 http(s) 原址）；别的为 null。 */
const validateArtwork = value => {
    if (!isPlainObject(value)) return null;
    if (value.bytes instanceof Uint8Array) {
        const extension = ARTWORK_EXTENSIONS[value.mimeType];
        if (!extension || value.bytes.byteLength === 0 || value.bytes.byteLength > MAX_ARTWORK_BYTES) return null;
        return { bytes: Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength), extension };
    }
    if (isHttpUrl(value.url)) return { url: value.url };
    return null;
};

// 封面写进 userData 下的一个目录，只留当前这首的；文件名是内容的哈希。
const createArtworkFiles = ({ getDirectory, fsImpl = fs.promises }) => {
    let currentFile = null;

    const removeOthers = async keep => {
        const directory = getDirectory();
        let names;
        try {
            names = await fsImpl.readdir(directory);
        } catch {
            return;
        }
        await Promise.all(names
            .filter(name => ARTWORK_FILE_PATTERN.test(name) && name !== keep)
            .map(name => fsImpl.rm(path.join(directory, name), { force: true }).catch(() => {})));
    };

    return {
        write: async ({ bytes, extension }) => {
            const directory = getDirectory();
            const name = `cover-${crypto.createHash('sha1').update(bytes).digest('hex')}.${extension}`;
            const filePath = path.join(directory, name);
            await fsImpl.mkdir(directory, { recursive: true });
            if (currentFile !== name) await fsImpl.writeFile(filePath, bytes, { mode: 0o600 });
            currentFile = name;
            await removeOthers(name);
            return filePath;
        },
        clear: async () => {
            currentFile = null;
            await removeOthers(null);
        },
    };
};

const fileUrl = filePath => `file://${filePath.split('/').map(encodeURIComponent).join('/')}`;

/**
 * 只在 Linux 上调。getMainWindow() 给按键的去处和 Raise 要拿到前面的窗口；getArtworkDirectory() 是放封面的目录。
 * 返回 dispose()，退出时关掉总线连接、删掉封面。
 */
const registerMprisIpc = ({
    ipcMain,
    isTrustedSender,
    getMainWindow,
    getArtworkDirectory,
    env = process.env,
    uid = process.getuid(),
    connect = () => connectBus({ address: sessionBusAddress(env), uid }),
    readMachineId = () => {
        try {
            return fs.readFileSync('/etc/machine-id', 'utf8').trim();
        } catch {
            return '';
        }
    },
}) => {
    const sendToMainWindow = (channel, payload) => {
        const window = getMainWindow();
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
        window.webContents.send(channel, payload);
    };
    const artworkFiles = createArtworkFiles({ getDirectory: getArtworkDirectory });

    const service = createMprisService({
        connect: async () => {
            if (sessionBusAddress(env) === null) throw new Error('No session bus address');
            return connect();
        },
        onCommand: command => sendToMainWindow(COMMAND_CHANNEL, command),
        onRaise: () => {
            const window = getMainWindow();
            if (!window || window.isDestroyed()) return;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
        },
        readMachineId,
    });

    const handle = (channel, handler) => {
        ipcMain.handle(channel, createSenderGuardedHandler({ channel, isTrusted: isTrustedSender, handler }));
    };

    handle(STATE_CHANNEL, (_event, state) => {
        const valid = validateMprisState(state);
        service.update(valid);
        if (!valid.active) void artworkFiles.clear();
    });
    handle(ARTWORK_CHANNEL, async (_event, trackKey, artwork) => {
        if (!isKeyLabel(trackKey) || service.currentTrackKey() !== trackKey) return;
        const valid = validateArtwork(artwork);
        if (!valid) {
            service.setArtwork(trackKey, null);
            return;
        }
        if (valid.url) {
            service.setArtwork(trackKey, valid.url);
            return;
        }
        try {
            const filePath = await artworkFiles.write(valid);
            if (service.currentTrackKey() === trackKey) service.setArtwork(trackKey, fileUrl(filePath));
        } catch (error) {
            console.warn('[MPRIS] could not write the cover for the system media controls', error);
            service.setArtwork(trackKey, null);
        }
    });

    return {
        dispose: () => {
            service.dispose();
            void artworkFiles.clear();
        },
    };
};

module.exports = {
    STATE_CHANNEL,
    ARTWORK_CHANNEL,
    COMMAND_CHANNEL,
    validateMprisState,
    validateArtwork,
    createArtworkFiles,
    fileUrl,
    registerMprisIpc,
};

'use strict';

// mpv 的启动参数和 loadfile 命令（纯函数）：只开音频、不读用户配置、不做任何处理，源只经 IPC 下发，不上命令行。

const MAX_AUDIO_DEVICE_CHARS = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const AO_OVERRIDE_PATTERN = /^[a-z0-9_,-]+$/i;
const PIPE_HEX_PATTERN = /^[0-9a-f]+$/i;
const LOADFILE_MODES = new Set(['replace', 'append']);

// 顺序固定：先关掉一切会碰声音或界面的东西，再是位精确要的那几项。不设 --audio-samplerate / --audio-format，
// 让 mpv 按源的格式开输出。
const BASE_ARGS = Object.freeze([
    '--idle=yes',
    '--no-config',
    '--no-video',
    '--audio-display=no',
    '--load-scripts=no',
    '--ytdl=no',
    '--osc=no',
    '--input-default-bindings=no',
    '--input-terminal=no',
    '--input-media-keys=no',
    '--media-controls=no',
    '--terminal=no',
    '--msg-level=all=warn',
    '--keep-open=yes',
    '--gapless-audio=weak',
    '--prefetch-playlist=yes',
    '--replaygain=no',
    '--af=',
    '--audio-pitch-correction=no',
    '--audio-normalize-downmix=no',
    '--audio-channels=auto',
    '--volume=100',
    '--volume-max=100',
    '--audio-fallback-to-null=no',
]);

/** 设置里存的设备名；空、不是字符串、过长或带控制字符时回落到 'auto'。 */
const sanitizeAudioDevice = value => {
    if (typeof value !== 'string') return 'auto';
    if (value.trim() === '' || value.length > MAX_AUDIO_DEVICE_CHARS || CONTROL_CHARS.test(value)) return 'auto';
    return value;
};

/** Windows 上 mpv 的 IPC 命名管道，hex 是随机串。 */
const buildPipeName = hex => {
    if (typeof hex !== 'string' || !PIPE_HEX_PATTERN.test(hex)) {
        throw new TypeError('HiFi pipe name needs a hex string');
    }
    return `\\\\.\\pipe\\folia-hifi-${hex}`;
};

const buildIpcArg = (platform, ipc) => {
    if (ipc?.kind === 'fd') {
        // fd://3 要 spawn 时把 stdio[3] 开成 socketpair，Windows 上没有这条路。
        if (platform === 'win32') throw new TypeError('HiFi fd IPC is not available on Windows');
        return '--input-ipc-client=fd://3';
    }
    if (ipc?.kind === 'pipe') {
        if (typeof ipc.path !== 'string' || ipc.path === '' || CONTROL_CHARS.test(ipc.path)) {
            throw new TypeError('HiFi pipe IPC needs a path');
        }
        return `--input-ipc-server=${ipc.path}`;
    }
    throw new TypeError('HiFi IPC kind must be fd or pipe');
};

/** 启动参数；ao 只给测试用（'null'、'pcm'），正式路径不传。 */
const buildMpvArgs = ({ platform, ipc, audioDevice, exclusive, dsdMode, ao } = {}) => {
    const args = [
        ...BASE_ARGS,
        `--audio-device=${sanitizeAudioDevice(audioDevice)}`,
        `--audio-exclusive=${exclusive ? 'yes' : 'no'}`,
    ];
    if (dsdMode === 'dop') args.push('--audio-spdif=dsd');
    args.push(buildIpcArg(platform, ipc));
    if (ao !== undefined && ao !== null && ao !== '') {
        if (typeof ao !== 'string' || !AO_OVERRIDE_PATTERN.test(ao)) throw new TypeError('HiFi ao override is invalid');
        args.push(`--ao=${ao}`);
    }
    return args;
};

// 起播位置写成最多三位小数的秒数，不出现指数写法。
const formatStartSec = startSec => String(Number(startSec.toFixed(3)));

/** loadfile 命令数组；startSec 大于 0 时带上 index -1 和 start= 选项（mpv 0.38 起的四参写法）。 */
const buildLoadfileCommand = (url, mode, { startSec = 0 } = {}) => {
    if (typeof url !== 'string' || url === '') throw new TypeError('HiFi loadfile needs a url');
    if (!LOADFILE_MODES.has(mode)) throw new TypeError('HiFi loadfile mode must be replace or append');
    const command = ['loadfile', url, mode];
    if (typeof startSec === 'number' && Number.isFinite(startSec) && startSec > 0) {
        command.push(-1, `start=${formatStartSec(startSec)}`);
    }
    return command;
};

module.exports = {
    buildMpvArgs,
    sanitizeAudioDevice,
    buildPipeName,
    buildLoadfileCommand,
};

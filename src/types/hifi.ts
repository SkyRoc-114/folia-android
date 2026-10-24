// HiFi 后端的跨进程契约：主进程 electron/hifi/* 经 preload 的 window.electron.hifi 与渲染端 src/services/hifi/* 共用这些形状。

/** 当前这首歌由哪套引擎发声：web 是 <audio> + Web Audio，hifi 是 mpv。 */
export type PlaybackRoute = 'web' | 'hifi';

/** 主进程只回传错误码，文案由渲染端按 hifi.errors.<code> 取。 */
export type HifiErrorCode =
    | 'MPV_NOT_FOUND'
    /** 找到的 mpv 比 0.39.0 旧，认不得我们的启动参数。 */
    | 'MPV_TOO_OLD'
    | 'MPV_SPAWN_FAILED'
    | 'MPV_CRASHED'
    | 'IPC_TIMEOUT'
    | 'CIRCUIT_OPEN'
    | 'DEVICE_BUSY'
    | 'DEVICE_UNAVAILABLE'
    | 'SOURCE_UNREACHABLE'
    | 'SOURCE_REJECTED'
    | 'FORMAT_UNSUPPORTED'
    | 'LOAD_FAILED'
    | 'INVALID_REQUEST'
    | 'UNSUPPORTED_PLATFORM'
    | 'INSTALL_FAILED'
    | 'INSTALL_CHECKSUM_MISMATCH'
    | 'INSTALL_CANCELLED'
    | 'UNKNOWN';

export type HifiRuntimeSource = 'manual' | 'downloaded' | 'system';

export type HifiRuntimeDownloadInfo = {
    /** 清单里有这个平台和架构的构建。Linux 恒为 false。 */
    supported: boolean;
    /** 清单推荐的版本。 */
    version: string | null;
    /** userData 里已装好的最新版本；只算 `--version` 探测得通的，装了但起不来的不算。 */
    installedVersion: string | null;
    updateAvailable: boolean;
    /** 正在下载、校验或解压。 */
    installing: boolean;
};

export type HifiRuntimeStatus = {
    available: boolean;
    path: string | null;
    /** 解析出的版本号，如 '0.41.0' 或 git 构建的 '0.41.0-123-gabcdef0'。 */
    version: string | null;
    source: HifiRuntimeSource | null;
    /**
     * 没找到时为 MPV_NOT_FOUND；手动路径不可用时也写在这里。只找到比 0.39.0 旧的 mpv（或手动路径指向它）时为
     * MPV_TOO_OLD：available 为 false 时 path / version / source 填的就是那个太旧的。
     */
    errorCode: HifiErrorCode | null;
    /** 设置了手动路径，但它不存在、不可执行、不是 mpv 或版本太旧。 */
    manualPathRejected: boolean;
    platform: string;
    arch: string;
    download: HifiRuntimeDownloadInfo;
    /** 这个 mpv 预计能做 DoP：Windows，且版本比 0.41.0 新。最终以实际输出格式为准。 */
    dopCapable: boolean;
};

export type HifiInstallPhase = 'downloading' | 'verifying' | 'extracting' | 'done' | 'error' | 'cancelled';

export type HifiInstallProgress = {
    phase: HifiInstallPhase;
    version: string;
    receivedBytes: number;
    totalBytes: number;
    errorCode: HifiErrorCode | null;
};

export type HifiInstallResult = {
    ok: boolean;
    errorCode: HifiErrorCode | null;
    status: HifiRuntimeStatus;
};

export type HifiDevice = {
    /** mpv 的 audio-device 值，如 'auto'、'wasapi/{guid}'、'alsa/hw:CARD=D10,DEV=0'。 */
    name: string;
    description: string;
    /** name 里 '/' 之前的驱动名，'auto' 为 'auto'。 */
    driver: string;
    /** Linux 上绕过混音器的 ALSA hw: 直连设备。 */
    direct: boolean;
};

export type HifiDsdMode = 'pcm' | 'dop';

/** 渲染端设置推给主进程的那部分；主进程只在内存里保存，变化时对运行中的 mpv 直接 set_property。 */
export type HifiEngineConfig = {
    /** 手动指定的 mpv 路径，null 表示自动检测。 */
    mpvPath: string | null;
    audioDevice: string;
    exclusive: boolean;
    dsdMode: HifiDsdMode;
    softwareVolume: boolean;
    /** 0–100，只在 softwareVolume 时下发；否则 mpv 固定 100。 */
    volume: number;
};

export type HifiSourceRequest =
    | {
        kind: 'local';
        /** 渲染端为这个 File 生成的随机键；主进程据此向渲染端拉块。 */
        sourceKey: string;
        size: number;
        mimeType: string;
        fileName: string;
    }
    | {
        kind: 'navidrome';
        /** 带凭据的 stream 地址（format=raw）；只在主进程内用于 net.fetch，不进 mpv 参数和日志。 */
        url: string;
        fileName: string;
    };

export type HifiLoadRequest = {
    /** 渲染端为这一次起播生成的不透明键（songKey + 随机后缀），用来丢弃过时事件。 */
    trackKey: string;
    /** getPlaybackSongKey(song)。 */
    songKey: string;
    source: HifiSourceRequest;
    startSec: number;
    paused: boolean;
    loopFile: boolean;
};

export type HifiLoadResult =
    | { ok: true; state: HifiEngineState }
    | { ok: false; errorCode: HifiErrorCode; detail?: string };

export type HifiPlaybackStatus = 'stopped' | 'starting' | 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

/** mpv 的 audio-params / audio-out-params，键名换成驼峰。format 如 's16'、's32'、'float'、'floatp'。 */
export type HifiMpvAudioParams = {
    samplerate: number;
    channelCount: number;
    channels: string;
    format: string;
};

/** track-list 里选中的音轨。 */
export type HifiMpvTrackInfo = {
    codec: string | null;
    codecDesc: string | null;
    decoder: string | null;
    demuxSamplerate: number | null;
    demuxChannelCount: number | null;
    demuxBitrate: number | null;
    formatName: string | null;
};

export type HifiQueuedTrack = {
    trackKey: string;
    songKey: string;
};

export type HifiEngineState = {
    status: HifiPlaybackStatus;
    processRunning: boolean;
    trackKey: string | null;
    songKey: string | null;
    sourceKind: 'local' | 'navidrome' | null;
    /** 本地源的 sourceKey；窗口重建后新渲染进程用它重新登记同一个 File。 */
    localSourceKey: string | null;
    durationSec: number | null;
    positionSec: number;
    paused: boolean;
    loopFile: boolean;
    audioParams: HifiMpvAudioParams | null;
    audioOutParams: HifiMpvAudioParams | null;
    /** mpv 的 current-ao，如 'wasapi'、'coreaudio'、'alsa'、'pipewire'。 */
    currentAo: string | null;
    audioDevice: string | null;
    exclusive: boolean;
    /** mpv 的 audio-spdif，DoP 时为 'dsd'。 */
    spdif: string | null;
    volume: number;
    track: HifiMpvTrackInfo | null;
    /** 已用 loadfile append 预载、等着无缝接上的下一首。 */
    next: HifiQueuedTrack | null;
    errorCode: HifiErrorCode | null;
    circuitOpen: boolean;
    /** 每次推送加一，渲染端丢弃乱序到达的旧状态。 */
    seq: number;
};

export type HifiClockReason = 'tick' | 'seek' | 'pause' | 'resume' | 'load';

export type HifiClockUpdate = {
    trackKey: string | null;
    positionSec: number;
    paused: boolean;
    reason: HifiClockReason;
    seq: number;
};

export type HifiErrorEvent = {
    code: HifiErrorCode;
    trackKey: string | null;
    /** 已去掉查询串和凭据的说明，只用于日志。 */
    detail?: string;
    /** true 表示这次播放已经停了，渲染端要回落。 */
    fatal: boolean;
};

/** 主进程向渲染端要本地文件的一段字节。 */
export type HifiReadRequest = {
    readId: string;
    sourceKey: string;
    offset: number;
    length: number;
};

export type HifiReadResponse =
    | { status: 'ok'; data: Uint8Array }
    | { status: 'unknown-source' }
    | { status: 'failed' };

/** 源的格式：本地取自 music-metadata，Navidrome 取自 Subsonic 的 bitDepth / samplingRate / channelCount。 */
export type HifiSourceSpec = {
    origin: 'local' | 'navidrome';
    codec: string | null;
    container: string | null;
    bitDepth: number | null;
    sampleRate: number | null;
    channels: number | null;
    lossless: boolean | null;
    isDsd: boolean;
    /** DSD 的位速率，如 2822400（DSD64）。 */
    dsdRate: number | null;
    bitrate: number | null;
};

export type HifiSignalVerdict = 'bit-perfect' | 'dop' | 'converted' | 'shared-mixer' | 'unknown';

export type HifiSignalStageId = 'source' | 'transport' | 'decode' | 'process' | 'output';

export type HifiSignalStageStatus = 'passthrough' | 'converted' | 'bypassed' | 'unknown';

export type HifiSignalConversion = 'resample' | 'format' | 'channels' | 'dsd-to-pcm' | 'dop' | 'volume' | 'shared-mixer';

export type HifiSignalFormat = {
    sampleRate: number | null;
    bitDepth: number | null;
    /** mpv 的采样格式名（'s16'、's32'、'floatp'…）或源的编码名。 */
    sampleFormat: string | null;
    channels: number | null;
    dsdRate: number | null;
};

export type HifiSignalStage = {
    id: HifiSignalStageId;
    status: HifiSignalStageStatus;
    conversions: HifiSignalConversion[];
    format: HifiSignalFormat | null;
    /** 这一级的补充说明，不翻译：编码名、'format=raw'、AO 名加设备名。 */
    detail: string | null;
};

export type HifiSignalPath = {
    verdict: HifiSignalVerdict;
    stages: HifiSignalStage[];
    conversions: HifiSignalConversion[];
    output: {
        ao: string | null;
        device: string | null;
        exclusive: boolean;
    };
};

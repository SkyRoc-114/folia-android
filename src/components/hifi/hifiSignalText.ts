import type { TFunction } from 'i18next';
import type {
    HifiSignalConversion,
    HifiSignalFormat,
    HifiSignalPath,
    HifiSignalStage,
    HifiSignalStageId,
    HifiSignalStageStatus,
    HifiSignalVerdict,
} from '../../types/hifi';

// src/components/hifi/hifiSignalText.ts
// 信号链路的文字：徽标上那一行、面板里每一级的格式和改动。数字按界面语言写，单位和措辞都走 i18n（hifi.signal.* / hifi.player.*）。

/** accent：采样原样到达 DAC（逐位直通或 DoP）；muted：别的情况。 */
export type HifiVerdictTone = 'accent' | 'muted';

const VERDICT_KEY: Record<HifiSignalVerdict, string> = {
    'bit-perfect': 'bitPerfect',
    dop: 'dop',
    converted: 'converted',
    'shared-mixer': 'sharedMixer',
    unknown: 'unknown',
};

const STAGE_KEY: Record<HifiSignalStageId, string> = {
    source: 'source',
    transport: 'transport',
    decode: 'decode',
    process: 'process',
    output: 'output',
};

const STATUS_KEY: Record<HifiSignalStageStatus, string> = {
    passthrough: 'passthrough',
    converted: 'converted',
    bypassed: 'bypassed',
    unknown: 'unknown',
};

const FLOAT_FORMAT = /^(float|double)p?$/i;

export const verdictTone = (verdict: HifiSignalVerdict): HifiVerdictTone => (
    verdict === 'bit-perfect' || verdict === 'dop' ? 'accent' : 'muted'
);

/** 徽标和格子用的短说法：原生直通、原生 DSD、已转换… */
export const verdictLabel = (verdict: HifiSignalVerdict, t: TFunction) => t(`hifi.signal.verdictShort.${VERDICT_KEY[verdict]}`);

/** 面板顶上那行大字。 */
export const verdictTitle = (verdict: HifiSignalVerdict, t: TFunction) => t(`hifi.signal.verdict.${VERDICT_KEY[verdict]}`);

export const verdictDescription = (verdict: HifiSignalVerdict, t: TFunction) => t(`hifi.signal.verdictDesc.${VERDICT_KEY[verdict]}`);

export const stageLabel = (id: HifiSignalStageId, t: TFunction) => t(`hifi.signal.stage.${STAGE_KEY[id]}`);

export const stageStatusLabel = (status: HifiSignalStageStatus, t: TFunction) => t(`hifi.signal.status.${STATUS_KEY[status]}`);

const usableNumber = (value: number | null | undefined): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
);

/** 按界面语言写数字（印尼语用逗号作小数点）；语言代码 Intl 不认时退回英文写法。 */
const formatNumber = (value: number, locale: string, maximumFractionDigits = 3) => {
    const options = { maximumFractionDigits, useGrouping: false };
    try {
        return new Intl.NumberFormat(locale || 'en', options).format(value);
    } catch {
        return new Intl.NumberFormat('en', options).format(value);
    }
};

/** 96000 → '96 kHz'，44100 → '44.1 kHz'。 */
export const formatSampleRate = (hz: number | null | undefined, t: TFunction, locale: string): string | null => (
    usableNumber(hz) ? t('hifi.signal.sampleRate', { value: formatNumber(hz / 1000, locale) }) : null
);

/** 位速率 → DSD64 / DSD128…（44.1k 和 48k 两族都按倍数叫）；不是整倍数时写成 MHz。 */
export const formatDsdRate = (rate: number | null | undefined, t: TFunction, locale: string): string | null => {
    if (!usableNumber(rate)) return null;
    if (rate % 44100 === 0) return t('hifi.signal.dsdRate', { multiple: rate / 44100 });
    if (rate % 48000 === 0) return t('hifi.signal.dsdRate', { multiple: rate / 48000 });
    return t('hifi.signal.dsdRateMhz', { value: formatNumber(rate / 1_000_000, locale) });
};

export const formatBitDepth = (bits: number | null | undefined, t: TFunction): string | null => (
    usableNumber(bits) ? t('hifi.signal.bitDepth', { bits }) : null
);

/** mpv 的采样格式写成位宽：s32 → '32 bit'，floatp → '32 bit float'；认不出的格式名原样给出。 */
export const formatSampleDepth = (format: HifiSignalFormat | null, t: TFunction): string | null => {
    if (!format) return null;
    const name = format.sampleFormat?.trim() ?? '';
    if (FLOAT_FORMAT.test(name)) {
        const bits = usableNumber(format.bitDepth) ? format.bitDepth : /^double/i.test(name) ? 64 : 32;
        return t('hifi.signal.floatDepth', { bits });
    }
    return formatBitDepth(format.bitDepth, t) ?? (name || null);
};

export const formatChannels = (count: number | null | undefined, t: TFunction): string | null => {
    if (!usableNumber(count)) return null;
    if (count === 1) return t('hifi.signal.channelsMono');
    if (count === 2) return t('hifi.signal.channelsStereo');
    return t('hifi.signal.channelsCount', { count });
};

/**
 * 一级的格式写成一行，如 '96 kHz · 24 bit · Stereo'。源文件这一级的位深来自文件本身（sampleFormat 是编码名），
 * DSD 源只写 DSD64；解码和输出两级按 mpv 的采样格式写位宽，DoP 时在前面加上 DSD 速率。
 */
export const formatStageFormat = (stage: HifiSignalStage, t: TFunction, locale: string): string | null => {
    const format = stage.format;
    if (!format) return null;
    const dsd = formatDsdRate(format.dsdRate, t, locale);
    const parts: (string | null)[] = stage.id === 'source'
        ? (dsd ? [dsd] : [formatSampleRate(format.sampleRate, t, locale), formatBitDepth(format.bitDepth, t)])
        : [dsd, formatSampleRate(format.sampleRate, t, locale), formatSampleDepth(format, t)];
    parts.push(formatChannels(format.channels, t));
    const text = parts.filter((part): part is string => Boolean(part)).join(' · ');
    return text || null;
};

const findStage = (path: HifiSignalPath, id: HifiSignalStageId) => path.stages.find(stage => stage.id === id) ?? null;

/**
 * 徽标里的格式：采样率取输出级；逐位直通（或只经过系统混音器、mpv 没改数据）时位深取源文件，不然取输出级的采样格式。
 * DoP 写 DSD64。什么都不知道时为 null。
 */
export const formatBadgeFormat = (path: HifiSignalPath, t: TFunction, locale: string): string | null => {
    const source = findStage(path, 'source')?.format ?? null;
    const output = findStage(path, 'output')?.format ?? null;
    if (path.verdict === 'dop') {
        const dsd = formatDsdRate(output?.dsdRate ?? source?.dsdRate, t, locale);
        if (dsd) return dsd;
    }
    if (!output) return null;
    const rate = formatSampleRate(output.sampleRate, t, locale);
    const sourceBits = source && !usableNumber(source.dsdRate) && usableNumber(source.bitDepth) && source.bitDepth > 1
        ? formatBitDepth(source.bitDepth, t)
        : null;
    const untouched = path.verdict === 'bit-perfect' || path.verdict === 'shared-mixer';
    const depth = (untouched ? sourceBits : null) ?? formatSampleDepth(output, t);
    const text = [rate, depth].filter((part): part is string => Boolean(part)).join(' / ');
    return text || null;
};

export type HifiBadgeText = {
    /** 'HiFi · 原生直通 · 96 kHz / 24 bit'。 */
    text: string;
    /** 窄屏上放不下格式时的 'HiFi · 原生直通'。 */
    shortText: string;
};

export const formatHifiBadge = (path: HifiSignalPath, t: TFunction, locale: string): HifiBadgeText => {
    const verdict = verdictLabel(path.verdict, t);
    const format = formatBadgeFormat(path, t, locale);
    const shortText = t('hifi.player.badge', { verdict });
    return {
        text: format ? t('hifi.player.badgeWithFormat', { verdict, format }) : shortText,
        shortText,
    };
};

/** 把一处改动说成人话；有前后两端的数值就带上，如「重采样：44.1 kHz → 48 kHz」。 */
export const describeConversion = (
    conversion: HifiSignalConversion,
    path: HifiSignalPath,
    t: TFunction,
    locale: string,
): string => {
    const decoded = findStage(path, 'decode')?.format ?? null;
    const output = findStage(path, 'output')?.format ?? null;
    const between = (key: string, from: string | null, to: string | null) => (
        from && to ? t(`hifi.signal.conversion.${key}`, { from, to }) : t(`hifi.signal.conversion.${key}Plain`)
    );
    switch (conversion) {
        case 'resample':
            return between('resample', formatSampleRate(decoded?.sampleRate, t, locale), formatSampleRate(output?.sampleRate, t, locale));
        case 'format':
            return between('format', formatSampleDepth(decoded, t), formatSampleDepth(output, t));
        case 'channels':
            return between('channels', formatChannels(decoded?.channels, t), formatChannels(output?.channels, t));
        case 'dsd-to-pcm':
            return t('hifi.signal.conversion.dsdToPcm');
        case 'dop':
            return t('hifi.signal.conversion.dop');
        case 'volume': {
            const volume = findStage(path, 'process')?.detail ?? null;
            return volume ? t('hifi.signal.conversion.volume', { volume }) : t('hifi.signal.conversion.volumePlain');
        }
        case 'shared-mixer':
            return t('hifi.signal.conversion.sharedMixer');
    }
};

/** 只有 DoP 打包是原样送达，别的改动都改了数据或交给了系统混音器。 */
export const isConversionLossless = (conversion: HifiSignalConversion) => conversion === 'dop';

/**
 * 每一级格式之外的一句说明：传输看来源（本机曲库还是 Navidrome 原文件），处理级说绕过了什么，输出级说独占还是共享。
 * 没什么可说时为 null。
 */
export const describeStage = (
    stage: HifiSignalStage,
    path: HifiSignalPath,
    origin: 'local' | 'navidrome' | null,
    t: TFunction,
): string | null => {
    if (stage.id === 'transport' && origin) {
        return t(origin === 'navidrome' ? 'hifi.signal.transportNavidrome' : 'hifi.signal.transportLocal');
    }
    if (stage.id === 'process' && stage.status === 'bypassed') return t('hifi.signal.processBypassed');
    if (stage.id === 'output' && stage.status !== 'unknown') {
        // PulseAudio、PipeWire 这类输出不管独占开没开都混音：按实际有没有经过混音器说。
        const shared = !path.output.exclusive || stage.conversions.includes('shared-mixer');
        return t(shared ? 'hifi.signal.outputShared' : 'hifi.signal.outputExclusive');
    }
    return null;
};

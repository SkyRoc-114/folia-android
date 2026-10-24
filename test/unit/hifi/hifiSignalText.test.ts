import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { HifiMpvAudioParams, HifiSignalVerdict, HifiSourceSpec } from '@/types/hifi';
import { buildSignalPath, type SignalPathEngineState, type SignalPathSettings } from '@/services/hifi/signalPath';
import {
    describeConversion,
    describeStage,
    formatBadgeFormat,
    formatDsdRate,
    formatHifiBadge,
    formatSampleRate,
    formatStageFormat,
    stageStatusLabel,
    verdictDescription,
    verdictLabel,
    verdictTitle,
    verdictTone,
} from '@/components/hifi/hifiSignalText';

// test/unit/hifi/hifiSignalText.test.ts
// The words of the HiFi badge and signal-path sheet: the verdict labels and tones, the badge line
// (output rate, source bit depth when bit-perfect, DSD64 for DoP), the stage format lines and the
// conversions said in plain words, and the advice for a shared output by system. Paths come from the real
// buildSignalPath; the translator is a stand-in with the English texts these keys get.

const EN: Record<string, string> = {
    'hifi.player.badgeChip': 'HiFi',
    'hifi.player.badge': 'HiFi · {{verdict}}',
    'hifi.player.badgeWithFormat': 'HiFi · {{verdict}} · {{format}}',
    'hifi.signal.verdictShort.bitPerfect': 'Bit-perfect',
    'hifi.signal.verdictShort.dop': 'Native DSD',
    'hifi.signal.verdictShort.converted': 'Converted',
    'hifi.signal.verdictShort.sharedMixer': 'System mixer',
    'hifi.signal.verdictShort.unknown': 'Unverified',
    'hifi.signal.verdict.bitPerfect': 'Bit-perfect',
    'hifi.signal.verdict.dop': 'Native DSD via DoP',
    'hifi.signal.verdict.converted': 'Converted on the way',
    'hifi.signal.verdict.sharedMixer': 'Through the system mixer',
    'hifi.signal.verdict.unknown': 'Not verified yet',
    'hifi.signal.verdictDesc.bitPerfect': 'Every sample reaches your DAC exactly as it is in the file.',
    'hifi.signal.verdictDesc.sharedMixer': 'The output device is shared with other apps. Turn on exclusive mode in the HiFi settings.',
    'hifi.signal.verdictDesc.sharedMixerExclusiveOn': 'Exclusive mode is on, but this output device does not take it. Choose another output device.',
    'hifi.signal.verdictDesc.sharedMixerLinux': 'PipeWire or PulseAudio mixes this output. Choose a device marked direct.',
    'hifi.signal.status.passthrough': 'Passthrough',
    'hifi.signal.status.converted': 'Converted',
    'hifi.signal.status.bypassed': 'Bypassed',
    'hifi.signal.status.unknown': 'Unknown',
    'hifi.signal.sampleRate': '{{value}} kHz',
    'hifi.signal.dsdRate': 'DSD{{multiple}}',
    'hifi.signal.dsdRateMhz': 'DSD {{value}} MHz',
    'hifi.signal.bitDepth': '{{bits}} bit',
    'hifi.signal.floatDepth': '{{bits}} bit float',
    'hifi.signal.channelsMono': 'Mono',
    'hifi.signal.channelsStereo': 'Stereo',
    'hifi.signal.channelsCount': '{{count}} channels',
    'hifi.signal.conversion.resample': 'Resampled from {{from}} to {{to}}',
    'hifi.signal.conversion.resamplePlain': 'Resampled',
    'hifi.signal.conversion.format': 'Sample format changed from {{from}} to {{to}}',
    'hifi.signal.conversion.formatPlain': 'Sample format changed',
    'hifi.signal.conversion.channels': 'Channels changed from {{from}} to {{to}}',
    'hifi.signal.conversion.channelsPlain': 'Channels changed',
    'hifi.signal.conversion.dsdToPcm': 'DSD converted to PCM',
    'hifi.signal.conversion.dop': 'DSD packed into PCM frames (DoP), unchanged',
    'hifi.signal.conversion.volume': 'Software volume scales every sample ({{volume}})',
    'hifi.signal.conversion.volumePlain': 'Software volume scales every sample',
    'hifi.signal.conversion.sharedMixer': 'Mixed by the system mixer, which may resample it',
    'hifi.signal.transportLocal': "Read byte for byte from your library through Folia's local bridge",
    'hifi.signal.transportNavidrome': 'The original file from Navidrome, not transcoded',
    'hifi.signal.processBypassed': 'No equalizer, effects, ReplayGain or volume change',
    'hifi.signal.outputExclusive': 'Exclusive mode',
    'hifi.signal.outputDirect': 'Direct to the device',
    'hifi.signal.outputShared': 'Shared mode',
};

const t = ((key: string, options?: Record<string, unknown>) => {
    const template = EN[key];
    if (template === undefined) throw new Error(`no text for ${key}`);
    return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name]));
}) as unknown as TFunction;

const params = (format: string, samplerate: number, channelCount = 2): HifiMpvAudioParams => ({
    format,
    samplerate,
    channelCount,
    channels: channelCount === 2 ? 'stereo' : `${channelCount}ch`,
});

const pcmSpec = (bitDepth: number, sampleRate: number): HifiSourceSpec => ({
    origin: 'local',
    codec: 'FLAC',
    container: 'FLAC',
    bitDepth,
    sampleRate,
    channels: 2,
    lossless: true,
    isDsd: false,
    dsdRate: null,
    bitrate: null,
});

const dsdSpec: HifiSourceSpec = {
    origin: 'local',
    codec: 'DSD',
    container: 'DSF',
    bitDepth: 1,
    sampleRate: 2822400,
    channels: 2,
    lossless: true,
    isDsd: true,
    dsdRate: 2822400,
    bitrate: 5644800,
};

const engine = (fields: Partial<SignalPathEngineState>): SignalPathEngineState => ({
    sourceKind: 'local',
    audioParams: null,
    audioOutParams: null,
    currentAo: 'wasapi',
    audioDevice: 'wasapi/{0.0.0.00000000}.{d10}',
    exclusive: true,
    spdif: null,
    volume: 100,
    track: null,
    ...fields,
});

const settings: SignalPathSettings = { exclusive: true, dsdMode: 'pcm', softwareVolume: false, volume: 100 };

const bitPerfect96 = () => buildSignalPath(
    pcmSpec(24, 96000),
    engine({ audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }),
    settings,
);

const dop64 = () => buildSignalPath(
    dsdSpec,
    engine({ spdif: 'dsd', audioParams: params('s32', 176400), audioOutParams: params('s32', 176400) }),
    { ...settings, dsdMode: 'dop' },
);

const resampledToFloat = () => buildSignalPath(
    pcmSpec(16, 44100),
    engine({ audioParams: params('s16', 44100), audioOutParams: params('float', 48000) }),
    settings,
);

const sharedPulse = () => buildSignalPath(
    pcmSpec(16, 44100),
    engine({ currentAo: 'pulse', audioDevice: 'pulse/alsa_output.usb', audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
    settings,
);

const sharedPipewire = () => buildSignalPath(
    pcmSpec(16, 44100),
    engine({ currentAo: 'pipewire', audioDevice: 'auto', exclusive: true, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
    settings,
);

/** A direct ALSA hw: device with the exclusive switch off: nothing mixes it all the same. */
const alsaHwSwitchOff = () => buildSignalPath(
    pcmSpec(16, 44100),
    engine({ currentAo: 'alsa', audioDevice: 'alsa/hw:CARD=D10,DEV=0', exclusive: false, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
    { ...settings, exclusive: false },
);

/** WASAPI with the exclusive switch off: the Windows mixer has it. */
const sharedWasapi = () => buildSignalPath(
    pcmSpec(16, 44100),
    engine({ exclusive: false, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
    { ...settings, exclusive: false },
);

const stageOf = (path: ReturnType<typeof bitPerfect96>, id: string) => path.stages.find(stage => stage.id === id)!;

describe('verdict labels', () => {
    const VERDICTS: HifiSignalVerdict[] = ['bit-perfect', 'dop', 'converted', 'shared-mixer', 'unknown'];

    it('names every verdict short for the badge and in full for the sheet', () => {
        expect(VERDICTS.map(verdict => verdictLabel(verdict, t))).toEqual([
            'Bit-perfect', 'Native DSD', 'Converted', 'System mixer', 'Unverified',
        ]);
        expect(VERDICTS.map(verdict => verdictTitle(verdict, t))).toEqual([
            'Bit-perfect', 'Native DSD via DoP', 'Converted on the way', 'Through the system mixer', 'Not verified yet',
        ]);
    });

    it('draws only an untouched path in the accent colour', () => {
        expect(VERDICTS.map(verdictTone)).toEqual(['accent', 'accent', 'muted', 'muted', 'muted']);
    });

    it('names the stage states', () => {
        expect(stageStatusLabel('passthrough', t)).toBe('Passthrough');
        expect(stageStatusLabel('bypassed', t)).toBe('Bypassed');
    });
});

describe('the badge line', () => {
    it('takes the rate from the output and the bit depth from the source when bit-perfect', () => {
        // mpv decodes 24-bit FLAC as s32: the badge still says what the file holds.
        expect(formatHifiBadge(bitPerfect96(), t, 'en')).toEqual({
            text: 'HiFi · Bit-perfect · 96 kHz / 24 bit',
            shortText: 'HiFi · Bit-perfect',
            chipText: 'HiFi',
        });
    });

    it('leaves the bit depth out while the source format is unknown, rather than calling the s32 container 32 bit', () => {
        // A 24-bit FLAC that music-metadata has not read yet (or a Navidrome answer without bitDepth): mpv decodes it as s32.
        const path = buildSignalPath(null, engine({ audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }), settings);
        expect(path.verdict).toBe('bit-perfect');
        expect(formatBadgeFormat(path, t, 'en')).toBe('96 kHz');
        expect(formatHifiBadge(path, t, 'en').text).toBe('HiFi · Bit-perfect · 96 kHz');

        const shared = buildSignalPath({ ...pcmSpec(24, 96000), bitDepth: null }, engine({
            currentAo: 'pipewire', audioDevice: 'auto', audioParams: params('s32', 96000), audioOutParams: params('s32', 96000),
        }), settings);
        expect(shared.verdict).toBe('shared-mixer');
        expect(formatBadgeFormat(shared, t, 'en')).toBe('96 kHz');
    });

    it('says only HiFi for a restored track that mpv has not loaded yet', () => {
        const path = buildSignalPath(pcmSpec(24, 96000), null, settings);
        expect(formatHifiBadge(path, t, 'en', { deferred: true })).toEqual({ text: 'HiFi', shortText: 'HiFi', chipText: 'HiFi' });
    });

    it('says DSD64 for DoP', () => {
        const path = dop64();
        expect(path.verdict).toBe('dop');
        expect(formatHifiBadge(path, t, 'en').text).toBe('HiFi · Native DSD · DSD64');
    });

    it('shows what reaches the output once mpv converted it', () => {
        const path = resampledToFloat();
        expect(path.verdict).toBe('converted');
        expect(formatHifiBadge(path, t, 'en').text).toBe('HiFi · Converted · 48 kHz / 32 bit float');
    });

    it('keeps the source bit depth when only the system mixer is in the way', () => {
        const path = sharedPulse();
        expect(path.verdict).toBe('shared-mixer');
        expect(formatHifiBadge(path, t, 'en').text).toBe('HiFi · System mixer · 44.1 kHz / 16 bit');
    });

    it('has no format while mpv has not reported one', () => {
        const path = buildSignalPath(pcmSpec(24, 96000), null, settings);
        expect(path.verdict).toBe('unknown');
        expect(formatHifiBadge(path, t, 'en')).toEqual({ text: 'HiFi · Unverified', shortText: 'HiFi · Unverified', chipText: 'HiFi' });
    });

    it('writes the numbers the way the interface language does', () => {
        expect(formatBadgeFormat(sharedPulse(), t, 'in')).toBe('44,1 kHz / 16 bit');
        expect(formatSampleRate(44100, t, 'zh-CN')).toBe('44.1 kHz');
        // A language code Intl does not take falls back to the English way.
        expect(formatSampleRate(88200, t, 'not a locale!')).toBe('88.2 kHz');
    });
});

describe('formats', () => {
    it('names DSD rates by their multiple, for both families', () => {
        expect(formatDsdRate(2822400, t, 'en')).toBe('DSD64');
        expect(formatDsdRate(5644800, t, 'en')).toBe('DSD128');
        expect(formatDsdRate(3072000, t, 'en')).toBe('DSD64');
        expect(formatDsdRate(2000000, t, 'en')).toBe('DSD 2 MHz');
        expect(formatDsdRate(null, t, 'en')).toBeNull();
    });

    it('writes each stage as rate, depth and channels', () => {
        const path = bitPerfect96();
        expect(formatStageFormat(stageOf(path, 'source'), t, 'en')).toBe('96 kHz · 24 bit · Stereo');
        expect(formatStageFormat(stageOf(path, 'decode'), t, 'en')).toBe('96 kHz · 32 bit · Stereo');
        expect(formatStageFormat(stageOf(path, 'transport'), t, 'en')).toBeNull();
    });

    it('writes a DSD source as its rate and the DoP output with its carrier', () => {
        const path = dop64();
        expect(formatStageFormat(stageOf(path, 'source'), t, 'en')).toBe('DSD64 · Stereo');
        expect(formatStageFormat(stageOf(path, 'output'), t, 'en')).toBe('DSD64 · 176.4 kHz · 32 bit · Stereo');
    });
});

describe('conversions and stage notes', () => {
    it('says each conversion in plain words, with the values on both ends', () => {
        const path = resampledToFloat();
        expect(stageOf(path, 'output').conversions).toEqual(['resample', 'format']);
        expect(describeConversion('resample', path, t, 'en')).toBe('Resampled from 44.1 kHz to 48 kHz');
        expect(describeConversion('format', path, t, 'en')).toBe('Sample format changed from 16 bit to 32 bit float');
        expect(describeConversion('dsd-to-pcm', path, t, 'en')).toBe('DSD converted to PCM');
    });

    it('names the software volume and the channel remix', () => {
        const path = buildSignalPath(
            pcmSpec(24, 48000),
            engine({ volume: 72, audioParams: params('float', 48000, 6), audioOutParams: params('float', 48000, 2) }),
            { ...settings, softwareVolume: true, volume: 72 },
        );
        expect(describeConversion('volume', path, t, 'en')).toBe('Software volume scales every sample (72%)');
        expect(describeConversion('channels', path, t, 'en')).toBe('Channels changed from 6 channels to Stereo');
    });

    it('falls back to the plain words when an end is unknown', () => {
        const path = buildSignalPath(pcmSpec(24, 96000), null, settings);
        expect(describeConversion('resample', path, t, 'en')).toBe('Resampled');
        expect(describeConversion('volume', path, t, 'en')).toBe('Software volume scales every sample');
    });

    it('explains transport, a bypassed process stage and the output mode', () => {
        const path = bitPerfect96();
        expect(describeStage(stageOf(path, 'transport'), path, 'navidrome', t)).toBe('The original file from Navidrome, not transcoded');
        expect(describeStage(stageOf(path, 'transport'), path, 'local', t)).toBe("Read byte for byte from your library through Folia's local bridge");
        expect(describeStage(stageOf(path, 'process'), path, 'local', t)).toBe('No equalizer, effects, ReplayGain or volume change');
        expect(describeStage(stageOf(path, 'output'), path, 'local', t)).toBe('Exclusive mode');
        // PulseAudio mixes whatever the exclusive setting says.
        expect(describeStage(stageOf(sharedPulse(), 'output'), sharedPulse(), 'local', t)).toBe('Shared mode');
        expect(describeStage(stageOf(path, 'source'), path, 'local', t)).toBeNull();
    });

    it('names the output mode after what the output does, not after the exclusive switch', () => {
        // A direct hw: device with the switch off is not mixed: the verdict and the note must agree.
        const direct = alsaHwSwitchOff();
        expect(direct.verdict).toBe('bit-perfect');
        expect(describeStage(stageOf(direct, 'output'), direct, 'local', t, 'linux')).toBe('Direct to the device');
        // PipeWire with the switch on is mixed all the same.
        const pipewire = sharedPipewire();
        expect(pipewire.verdict).toBe('shared-mixer');
        expect(describeStage(stageOf(pipewire, 'output'), pipewire, 'local', t, 'linux')).toBe('Shared mode');
        // WASAPI follows the switch; Windows has an exclusive mode to name.
        expect(describeStage(stageOf(sharedWasapi(), 'output'), sharedWasapi(), 'local', t, 'win32')).toBe('Shared mode');
        expect(describeStage(stageOf(bitPerfect96(), 'output'), bitPerfect96(), 'local', t, 'win32')).toBe('Exclusive mode');
    });
});

describe('the advice for a shared output', () => {
    it('points Linux at a direct device, whatever the exclusive switch says', () => {
        expect(verdictDescription(sharedPipewire(), t, 'linux')).toBe('PipeWire or PulseAudio mixes this output. Choose a device marked direct.');
        expect(verdictDescription(sharedPulse(), t, 'linux')).toBe('PipeWire or PulseAudio mixes this output. Choose a device marked direct.');
    });

    it('asks Windows and macOS to turn exclusive mode on only while it is off', () => {
        expect(verdictDescription(sharedWasapi(), t, 'win32')).toBe('The output device is shared with other apps. Turn on exclusive mode in the HiFi settings.');
        // Exclusive is on and the output still mixes: this device does not take exclusive mode.
        expect(verdictDescription(sharedPulse(), t, 'darwin')).toBe('Exclusive mode is on, but this output device does not take it. Choose another output device.');
    });

    it('leaves the other verdicts as they are', () => {
        expect(verdictDescription(bitPerfect96(), t, 'linux')).toBe('Every sample reaches your DAC exactly as it is in the file.');
    });
});

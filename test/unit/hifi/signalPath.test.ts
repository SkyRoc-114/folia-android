import { describe, expect, it } from 'vitest';
import type { HifiMpvAudioParams, HifiSignalConversion, HifiSignalVerdict, HifiSourceSpec } from '@/types/hifi';
import { buildSignalPath, type SignalPathEngineState, type SignalPathSettings } from '@/services/hifi/signalPath';

// test/unit/hifi/signalPath.test.ts
// The bit-perfect verdict: source format against mpv's decoded and output formats, the output driver,
// exclusive mode, DSD (as PCM or as DoP) and software volume.

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

/** Navidrome without the OpenSubsonic fields: the suffix says DSD, the rates are unknown. */
const dsdSpecWithoutRates: HifiSourceSpec = { ...dsdSpec, origin: 'navidrome', bitDepth: null, sampleRate: null, dsdRate: null, bitrate: null };

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

type Case = {
    name: string;
    spec: HifiSourceSpec | null;
    state: SignalPathEngineState;
    settings?: Partial<SignalPathSettings>;
    verdict: HifiSignalVerdict;
    conversions: HifiSignalConversion[];
};

const cases: Case[] = [
    {
        name: '24-bit FLAC decoded as s32 and sent as s32 to WASAPI exclusive',
        spec: pcmSpec(24, 96000),
        state: engine({ audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: '16-bit source padded into s32',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16', 44100), audioOutParams: params('s32', 44100) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: '24-bit source in s32 trimmed back to s24',
        spec: pcmSpec(24, 96000),
        state: engine({ audioParams: params('s32', 96000), audioOutParams: params('s24', 96000) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: 'planar to packed of the same width',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16p', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: 'float output from s16 input',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16', 44100), audioOutParams: params('float', 44100) }),
        verdict: 'converted',
        conversions: ['format'],
    },
    {
        name: '32-bit source narrowed to s16',
        spec: pcmSpec(32, 44100),
        state: engine({ audioParams: params('s32', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'converted',
        conversions: ['format'],
    },
    {
        name: '44.1 kHz resampled to 48 kHz',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16', 44100), audioOutParams: params('s16', 48000) }),
        verdict: 'converted',
        conversions: ['resample'],
    },
    {
        name: 'channel count changed',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16', 44100, 6), audioOutParams: params('s16', 44100, 2) }),
        verdict: 'converted',
        conversions: ['channels'],
    },
    {
        name: 'PipeWire without exclusive, identical params',
        spec: pcmSpec(16, 44100),
        state: engine({
            currentAo: 'pipewire',
            audioDevice: 'pipewire',
            exclusive: false,
            audioParams: params('s16', 44100),
            audioOutParams: params('s16', 44100),
        }),
        settings: { exclusive: false },
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        // mpv's pipewire AO has no exclusive mode: PipeWire still resamples to the graph rate and mixes.
        name: 'PipeWire with exclusive asked for still goes through the mixer',
        spec: pcmSpec(24, 96000),
        state: engine({
            currentAo: 'pipewire',
            audioDevice: 'pipewire',
            exclusive: true,
            audioParams: params('s32', 96000),
            audioOutParams: params('s32', 96000),
        }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'a PipeWire sink picked by name with exclusive asked for',
        spec: pcmSpec(16, 44100),
        state: engine({
            currentAo: 'pipewire',
            audioDevice: 'pipewire/alsa_output.usb-Topping_D10-00.analog-stereo',
            exclusive: true,
            audioParams: params('s16', 44100),
            audioOutParams: params('s16', 44100),
        }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'JACK with exclusive asked for',
        spec: pcmSpec(16, 44100),
        state: engine({ currentAo: 'jack', audioDevice: 'auto', audioParams: params('float', 44100), audioOutParams: params('float', 44100) }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'a driver without exclusive support, such as SDL',
        spec: pcmSpec(16, 44100),
        state: engine({ currentAo: 'sdl', audioDevice: 'auto', audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'Core Audio in hog mode (coreaudio_exclusive)',
        spec: pcmSpec(24, 96000),
        state: engine({ currentAo: 'coreaudio_exclusive', audioDevice: 'auto', audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: 'Core Audio without exclusive',
        spec: pcmSpec(24, 96000),
        state: engine({ currentAo: 'coreaudio', audioDevice: 'auto', exclusive: false, audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }),
        settings: { exclusive: false },
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'driver not reported yet: inferred from exclusive',
        spec: pcmSpec(16, 44100),
        state: engine({ currentAo: null, audioDevice: 'auto', audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: 'WASAPI shared mode',
        spec: pcmSpec(16, 44100),
        state: engine({ exclusive: false, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'PulseAudio even with exclusive asked for',
        spec: pcmSpec(16, 44100),
        state: engine({ currentAo: 'pulse', audioDevice: 'auto', audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'ALSA hw: device without exclusive goes direct',
        spec: pcmSpec(24, 96000),
        state: engine({
            currentAo: 'alsa',
            audioDevice: 'alsa/hw:CARD=D10,DEV=0',
            exclusive: false,
            audioParams: params('s32', 96000),
            audioOutParams: params('s32', 96000),
        }),
        settings: { exclusive: false },
        verdict: 'bit-perfect',
        conversions: [],
    },
    {
        name: 'ALSA default device goes through the mixer',
        spec: pcmSpec(16, 44100),
        state: engine({ currentAo: 'alsa', audioDevice: 'alsa/default', audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        verdict: 'shared-mixer',
        conversions: ['shared-mixer'],
    },
    {
        name: 'resampled and shared: converted wins',
        spec: pcmSpec(16, 44100),
        state: engine({ exclusive: false, audioParams: params('s16', 44100), audioOutParams: params('float', 48000) }),
        verdict: 'converted',
        conversions: ['resample', 'format', 'shared-mixer'],
    },
    {
        name: 'DSD decoded to floatp 352.8 kHz PCM',
        spec: dsdSpec,
        state: engine({ audioParams: params('floatp', 352800), audioOutParams: params('floatp', 352800) }),
        verdict: 'converted',
        conversions: ['dsd-to-pcm'],
    },
    {
        name: 'DSD with audio-spdif=dsd and s32 at a 16th of the DSD rate (DoP)',
        spec: dsdSpec,
        state: engine({ spdif: 'dsd', audioParams: params('s32', 176400), audioOutParams: params('s32', 176400) }),
        settings: { dsdMode: 'dop' },
        verdict: 'dop',
        conversions: ['dop'],
    },
    {
        name: 'DSD whose output format names DoP',
        spec: dsdSpec,
        state: engine({ spdif: 'dsd', audioParams: params('spdif-dsd', 176400), audioOutParams: params('spdif-dsd', 176400) }),
        settings: { dsdMode: 'dop' },
        verdict: 'dop',
        conversions: ['dop'],
    },
    {
        name: 'DSD with audio-spdif=dsd but PCM at the wrong rate is not DoP',
        spec: dsdSpec,
        state: engine({ spdif: 'dsd', audioParams: params('floatp', 352800), audioOutParams: params('s32', 352800) }),
        settings: { dsdMode: 'dop' },
        verdict: 'converted',
        conversions: ['dsd-to-pcm', 'format'],
    },
    {
        // A float decode proves mpv converted DSD to PCM, even though 352.8 kHz is a DoP rate for DSD128.
        name: 'DSD decoded to floatp and sent as s32 at a DoP rate, DSD rate unknown, is not DoP',
        spec: dsdSpecWithoutRates,
        state: engine({ spdif: 'dsd', audioParams: params('floatp', 352800), audioOutParams: params('s32', 352800) }),
        settings: { dsdMode: 'dop' },
        verdict: 'converted',
        conversions: ['dsd-to-pcm', 'format'],
    },
    {
        name: 'DSD decoded to floatp and resampled to s32 at a 16th of the DSD rate is not DoP',
        spec: dsdSpec,
        state: engine({ spdif: 'dsd', audioParams: params('floatp', 352800), audioOutParams: params('s32', 176400) }),
        settings: { dsdMode: 'dop' },
        verdict: 'converted',
        conversions: ['dsd-to-pcm', 'resample', 'format'],
    },
    {
        name: 'DSD with integer output at a 16th of the DSD rate but resampled on the way is not DoP',
        spec: dsdSpec,
        state: engine({ spdif: 'dsd', audioParams: params('s32', 352800), audioOutParams: params('s32', 176400) }),
        settings: { dsdMode: 'dop' },
        verdict: 'converted',
        conversions: ['dsd-to-pcm', 'resample'],
    },
    {
        name: 'DSD recognised from the mpv codec when the spec is missing',
        spec: null,
        state: engine({
            spdif: 'dsd',
            track: {
                codec: 'dsd_lsbf_planar',
                codecDesc: 'DSD (Direct Stream Digital), least significant bit first, planar',
                decoder: 'dsd_lsbf_planar',
                demuxSamplerate: 352800,
                demuxChannelCount: 2,
                demuxBitrate: 5644800,
                formatName: null,
            },
            audioParams: params('s32', 176400),
            audioOutParams: params('s32', 176400),
        }),
        verdict: 'dop',
        conversions: ['dop'],
    },
    {
        name: 'software volume',
        spec: pcmSpec(16, 44100),
        state: engine({ volume: 80, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
        settings: { softwareVolume: true, volume: 80 },
        verdict: 'converted',
        conversions: ['volume'],
    },
    {
        name: 'no output params yet',
        spec: pcmSpec(16, 44100),
        state: engine({ audioParams: params('s16', 44100), audioOutParams: null }),
        verdict: 'unknown',
        conversions: [],
    },
];

describe('buildSignalPath', () => {
    it.each(cases)('$name → $verdict', ({ spec, state, settings: overrides, verdict, conversions }) => {
        const path = buildSignalPath(spec, state, { ...settings, ...overrides });
        expect(path.verdict).toBe(verdict);
        expect(path.conversions).toEqual(conversions);
    });

    it('lays out five stages and bypasses processing on a clean path', () => {
        const path = buildSignalPath(
            pcmSpec(24, 96000),
            engine({ sourceKind: 'navidrome', audioParams: params('s32', 96000), audioOutParams: params('s32', 96000) }),
            settings,
        );
        expect(path.stages.map(stage => stage.id)).toEqual(['source', 'transport', 'decode', 'process', 'output']);
        expect(path.stages.map(stage => stage.status)).toEqual(['passthrough', 'passthrough', 'passthrough', 'bypassed', 'passthrough']);
        expect(path.stages[0].format).toEqual({ sampleRate: 96000, bitDepth: 24, sampleFormat: 'FLAC', channels: 2, dsdRate: null });
        expect(path.stages[1].detail).toBe('format=raw');
        expect(path.stages[4].format).toEqual({ sampleRate: 96000, bitDepth: 32, sampleFormat: 's32', channels: 2, dsdRate: null });
        expect(path.output).toEqual({ ao: 'wasapi', device: 'wasapi/{0.0.0.00000000}.{d10}', exclusive: true });
    });

    it('marks the stage that converts', () => {
        const dsd = buildSignalPath(dsdSpec, engine({ audioParams: params('floatp', 352800), audioOutParams: params('floatp', 352800) }), settings);
        expect(dsd.stages[2]).toMatchObject({ id: 'decode', status: 'converted', conversions: ['dsd-to-pcm'] });
        expect(dsd.stages[4]).toMatchObject({ id: 'output', status: 'passthrough', conversions: [] });

        // 应用音量 65% 时 mpv 的 volume 是它的立方根乘 100（selectHifiEngineConfig）。
        const volume = buildSignalPath(
            pcmSpec(16, 44100),
            engine({ volume: Math.cbrt(0.65) * 100, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
            { ...settings, softwareVolume: true, volume: 65 },
        );
        expect(volume.stages[3]).toMatchObject({ id: 'process', status: 'converted', conversions: ['volume'], detail: '65%' });

        const dop = buildSignalPath(dsdSpec, engine({ spdif: 'dsd', audioParams: params('s32', 176400), audioOutParams: params('s32', 176400) }), settings);
        expect(dop.stages[4]).toMatchObject({ status: 'passthrough', conversions: ['dop'] });
        expect(dop.stages[4].format?.dsdRate).toBe(2822400);
    });

    it('shows the app volume, not the cube-root value mpv holds', () => {
        const at = (mpvVolume: number) => buildSignalPath(
            pcmSpec(16, 44100),
            engine({ volume: mpvVolume, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }),
            { ...settings, softwareVolume: true, volume: 50 },
        ).stages[3];
        // 应用 50% → mpv 79.37；mpv 自己的数字是 79%。
        expect(at(79.37)).toMatchObject({ status: 'converted', conversions: ['volume'], detail: '50%' });
        expect(at(Math.cbrt(0.2) * 100).detail).toBe('20%');
        expect(at(0).detail).toBe('0%');
        // 软件音量开着时，满音量也算改了采样值（规则没变）。
        expect(at(100)).toMatchObject({ status: 'converted', conversions: ['volume'], detail: '100%' });
    });

    it('does not apply software volume to DoP', () => {
        const path = buildSignalPath(
            dsdSpec,
            engine({ spdif: 'dsd', audioParams: params('s32', 176400), audioOutParams: params('s32', 176400) }),
            { ...settings, dsdMode: 'dop', softwareVolume: true, volume: 50 },
        );
        expect(path.verdict).toBe('dop');
        expect(path.stages[3].status).toBe('bypassed');
    });

    it('treats an mpv volume below 100 as a conversion even with software volume off', () => {
        const path = buildSignalPath(pcmSpec(16, 44100), engine({ volume: 90, audioParams: params('s16', 44100), audioOutParams: params('s16', 44100) }), settings);
        expect(path.verdict).toBe('converted');
        expect(path.conversions).toEqual(['volume']);
    });

    it('is unknown without an engine state or without decoded params', () => {
        const noEngine = buildSignalPath(pcmSpec(16, 44100), null, settings);
        expect(noEngine.verdict).toBe('unknown');
        expect(noEngine.stages).toHaveLength(5);
        expect(noEngine.stages[0].status).toBe('passthrough');
        expect(noEngine.stages.slice(1).every(stage => stage.status === 'unknown')).toBe(true);

        const noInput = buildSignalPath(pcmSpec(16, 44100), engine({ audioOutParams: params('s16', 44100) }), settings);
        expect(noInput.verdict).toBe('unknown');
    });

    it('names the output by its driver and device', () => {
        const alsa = buildSignalPath(null, engine({ currentAo: 'alsa', audioDevice: 'alsa/hw:CARD=D10,DEV=0' }), settings);
        expect(alsa.stages[4].detail).toBe('alsa/hw:CARD=D10,DEV=0');
        const auto = buildSignalPath(null, engine({ currentAo: 'coreaudio', audioDevice: 'auto' }), settings);
        expect(auto.stages[4].detail).toBe('coreaudio');
        const other = buildSignalPath(null, engine({ currentAo: 'wasapi', audioDevice: '{guid}' }), settings);
        expect(other.stages[4].detail).toBe('wasapi {guid}');
    });
});

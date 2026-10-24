import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// 钉住 mpv 的启动参数（顺序、位精确要的开关、不上命令行的东西）、设备名清洗、管道名和 loadfile 命令。

type MpvArgsOptions = {
    platform?: string;
    ipc?: { kind: 'fd' } | { kind: 'pipe'; path: string } | { kind: string; path?: unknown };
    audioDevice?: unknown;
    exclusive?: boolean;
    dsdMode?: string;
    ao?: unknown;
};

const require = createRequire(import.meta.url);
const { buildMpvArgs, sanitizeAudioDevice, buildPipeName, buildLoadfileCommand } = require('../../../electron/hifi/mpvArgs.cjs') as {
    buildMpvArgs: (options: MpvArgsOptions) => string[];
    sanitizeAudioDevice: (value: unknown) => string;
    buildPipeName: (hex: unknown) => string;
    buildLoadfileCommand: (url: unknown, mode: unknown, options?: { startSec?: unknown }) => Array<string | number>;
};

const BASE_ARGS = [
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
];

describe('buildMpvArgs', () => {
    it('builds the Unix argument list in order, with socketpair IPC on fd 3', () => {
        expect(buildMpvArgs({
            platform: 'linux',
            ipc: { kind: 'fd' },
            audioDevice: 'alsa/hw:CARD=D10,DEV=0',
            exclusive: true,
            dsdMode: 'pcm',
        })).toEqual([
            ...BASE_ARGS,
            '--audio-device=alsa/hw:CARD=D10,DEV=0',
            '--audio-exclusive=yes',
            '--input-ipc-client=fd://3',
        ]);
    });

    it('uses a named pipe server on Windows and adds DoP only in dop mode', () => {
        const pipePath = buildPipeName('0123abcd');
        expect(buildMpvArgs({
            platform: 'win32',
            ipc: { kind: 'pipe', path: pipePath },
            audioDevice: 'wasapi/{0.0.0.00000000}.{guid}',
            exclusive: false,
            dsdMode: 'dop',
        })).toEqual([
            ...BASE_ARGS,
            '--audio-device=wasapi/{0.0.0.00000000}.{guid}',
            '--audio-exclusive=no',
            '--audio-spdif=dsd',
            `--input-ipc-server=${pipePath}`,
        ]);
    });

    it('appends the test ao override last', () => {
        const args = buildMpvArgs({ platform: 'linux', ipc: { kind: 'fd' }, audioDevice: 'auto', exclusive: false, dsdMode: 'pcm', ao: 'null' });
        expect(args[args.length - 1]).toBe('--ao=null');
        expect(args).toContain('--audio-device=auto');
        expect(args).not.toContain('--audio-spdif=dsd');
    });

    it('never forces a sample rate or format, and carries no source', () => {
        const args = buildMpvArgs({ platform: 'darwin', ipc: { kind: 'fd' }, audioDevice: 'coreaudio/AppleUSBAudioEngine:x', exclusive: true, dsdMode: 'dop' });
        expect(args.some(arg => arg.startsWith('--audio-samplerate') || arg.startsWith('--audio-format'))).toBe(false);
        expect(args.every(arg => arg.startsWith('--'))).toBe(true);
        expect(args.some(arg => /^--(ao|playlist)=/.test(arg))).toBe(false);
    });

    it('falls back to the auto device for bad device names', () => {
        const args = buildMpvArgs({ platform: 'linux', ipc: { kind: 'fd' }, audioDevice: 'bad\ndevice', exclusive: true, dsdMode: 'pcm' });
        expect(args).toContain('--audio-device=auto');
    });

    it('rejects IPC setups that cannot work', () => {
        expect(() => buildMpvArgs({ platform: 'win32', ipc: { kind: 'fd' } })).toThrow(TypeError);
        expect(() => buildMpvArgs({ platform: 'win32', ipc: { kind: 'pipe', path: '' } })).toThrow(TypeError);
        expect(() => buildMpvArgs({ platform: 'linux', ipc: { kind: 'tcp' } })).toThrow(TypeError);
        expect(() => buildMpvArgs({ platform: 'linux' })).toThrow(TypeError);
        expect(() => buildMpvArgs({ platform: 'linux', ipc: { kind: 'fd' }, ao: 'null --input-ipc-server=/tmp/x' })).toThrow(TypeError);
    });
});

describe('sanitizeAudioDevice', () => {
    it('keeps real device names', () => {
        expect(sanitizeAudioDevice('pipewire/alsa_output.usb-Topping_D10-00.analog-stereo')).toBe('pipewire/alsa_output.usb-Topping_D10-00.analog-stereo');
        expect(sanitizeAudioDevice('auto')).toBe('auto');
    });

    it('turns empty, non-string, oversized and control-character values into auto', () => {
        expect(sanitizeAudioDevice('')).toBe('auto');
        expect(sanitizeAudioDevice('   ')).toBe('auto');
        expect(sanitizeAudioDevice(null)).toBe('auto');
        expect(sanitizeAudioDevice(3)).toBe('auto');
        expect(sanitizeAudioDevice('a'.repeat(513))).toBe('auto');
        expect(sanitizeAudioDevice('a'.repeat(512))).toBe('a'.repeat(512));
        expect(sanitizeAudioDevice('alsa/hw:0\u0000')).toBe('auto');
        expect(sanitizeAudioDevice('alsa/hw:0\u007f')).toBe('auto');
    });
});

describe('buildPipeName', () => {
    it('names the pipe under the local pipe namespace', () => {
        expect(buildPipeName('deadBEEF01')).toBe('\\\\.\\pipe\\folia-hifi-deadBEEF01');
    });

    it('rejects anything that is not hex', () => {
        expect(() => buildPipeName('')).toThrow(TypeError);
        expect(() => buildPipeName('..\\evil')).toThrow(TypeError);
        expect(() => buildPipeName(12)).toThrow(TypeError);
    });
});

describe('buildLoadfileCommand', () => {
    const url = 'http://127.0.0.1:41234/0123456789abcdef0123456789abcdef/Song%20Name.flac';

    it('starts from the top without index or options', () => {
        expect(buildLoadfileCommand(url, 'replace', { startSec: 0 })).toEqual(['loadfile', url, 'replace']);
        expect(buildLoadfileCommand(url, 'append')).toEqual(['loadfile', url, 'append']);
        expect(buildLoadfileCommand(url, 'replace', { startSec: -3 })).toEqual(['loadfile', url, 'replace']);
        expect(buildLoadfileCommand(url, 'replace', { startSec: Number.NaN })).toEqual(['loadfile', url, 'replace']);
    });

    it('passes the start position with at most three decimals', () => {
        expect(buildLoadfileCommand(url, 'replace', { startSec: 83.123456 })).toEqual(['loadfile', url, 'replace', -1, 'start=83.123']);
        expect(buildLoadfileCommand(url, 'replace', { startSec: 12 })).toEqual(['loadfile', url, 'replace', -1, 'start=12']);
        expect(buildLoadfileCommand(url, 'append', { startSec: 0.5 })).toEqual(['loadfile', url, 'append', -1, 'start=0.5']);
        expect(buildLoadfileCommand(url, 'replace', { startSec: 1e-7 })).toEqual(['loadfile', url, 'replace', -1, 'start=0']);
    });

    it('rejects unknown modes and missing urls', () => {
        expect(() => buildLoadfileCommand(url, 'insert-next')).toThrow(TypeError);
        expect(() => buildLoadfileCommand('', 'replace')).toThrow(TypeError);
        expect(() => buildLoadfileCommand(undefined, 'replace')).toThrow(TypeError);
    });
});

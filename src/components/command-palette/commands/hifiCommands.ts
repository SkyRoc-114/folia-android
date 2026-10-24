import { AudioWaveform, Waypoints } from 'lucide-react';
import type { CommandPaletteCommand } from '../types';
import { createSettingsCommand, createToggleCommand, defineCommand } from '../commandFactories';

// src/components/command-palette/commands/hifiCommands.ts
// The HiFi (mpv) commands of the desktop app: the switch, its settings page, and the signal-path
// panel of the song that is playing through it.

export const hifiCommands: CommandPaletteCommand[] = [
    createToggleCommand(
        'hifi-toggle',
        'settings',
        'HiFi bit-perfect output',
        'Toggle playing local and Navidrome songs through mpv, straight to the output device',
        ['hifi', 'bit perfect', 'bitperfect', 'mpv', 'exclusive output', 'wasapi', 'dac', '原生直通', '无损直通', '比特完美', '独占输出'],
        (context) => {
            const { settings } = context;
            if (settings.isHifiEnabled()) {
                settings.setHifiEnabled(false);
                return;
            }
            // The full-volume warning is asked on the settings page, never skipped from here.
            if (!settings.isHifiVolumeConfirmed()) {
                settings.openSettings('options', 'hifi', null, 'hifiEngine');
                return;
            }
            settings.setHifiEnabled(true);
        },
        {
            platform: ['electron'],
            icon: AudioWaveform,
            // Same answer the settings page gates its switch on.
            isAvailable: context => (context ? context.settings.isHifiSupported() : true),
        },
    ),
    createSettingsCommand(
        'hifi-settings',
        'HiFi settings',
        'Open the HiFi settings: mpv, output device, exclusive mode and DSD',
        ['hifi', 'mpv', 'bit perfect', 'dsd', 'dop', 'exclusive mode', 'audio device', '原生直通', '独占模式', '输出设备', '直通设置'],
        'options',
        'hifi',
        { platform: ['electron'] },
    ),
    defineCommand({
        id: 'hifi-signal-path',
        group: 'playback',
        title: 'HiFi signal path',
        description: 'Show how the current song reaches your DAC and whether it stays bit-perfect',
        keywords: ['signal chain', 'audio path', 'bit perfect check', 'sample rate', 'bit depth', 'output format', 'hifi', '信号链路', '信号路径', '采样率', '位深'],
        icon: Waypoints,
        platform: ['electron'],
        // Only a song on the HiFi route has a path to show.
        isAvailable: context => context?.playback.isHifiRoute() ?? false,
        execute: (_input, context) => {
            context.playback.openHifiSignalPath();
            return true;
        },
    }),
];

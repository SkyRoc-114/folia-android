import { AudioWaveform, Download, Lock, RefreshCw, Server, SlidersHorizontal, Waypoints } from 'lucide-react';
import type { CommandPaletteCommand, CommandPaletteSharedContext } from '../types';
import { createSettingsCommand, createToggleCommand, defineCommand } from '../commandFactories';
import { runtimeLine, type RuntimeTranslate } from '../../modal/settings/pages/hifi/runtimeState';

// src/components/command-palette/commands/hifiCommands.ts
// The HiFi (mpv) commands of the desktop app: the switch, its settings page, the switches and the
// mpv actions of that page, and the signal-path panel of the song that is playing through it.
// DoP has no command on purpose: a DAC without DoP plays it as a hiss instead of the music, so that
// choice is made on the settings page, beside its warning.

/** The palette's t takes no values: fill the `{{name}}` places of the text it gives. */
const translateWith = (t: CommandPaletteSharedContext['t']): RuntimeTranslate => (key, values = {}) => (
    Object.entries(values).reduce((text, [name, value]) => text.split(`{{${name}}}`).join(value), t(key))
);

/** The switches of the HiFi page are offered where it enables them: in a build with the engine. */
const whereHifiIsSupported: CommandPaletteCommand['isAvailable'] = context => (context ? context.settings.isHifiSupported() : true);

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
            isAvailable: whereHifiIsSupported,
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
    createToggleCommand(
        'hifi-exclusive-toggle',
        'settings',
        'HiFi exclusive mode',
        'Turn on or off whether HiFi takes the output device for itself, so the system mixer stays out of the way',
        ['exclusive', 'wasapi exclusive', 'hog mode', 'device busy', 'system mixer', '独占', '系统混音器', '设备被占用', '独占设备'],
        context => context.settings.toggleHifiExclusive(),
        { platform: ['electron'], icon: Lock, isAvailable: whereHifiIsSupported },
    ),
    createToggleCommand(
        'hifi-navidrome-toggle',
        'settings',
        'Navidrome through HiFi',
        'Turn on or off playing Navidrome songs through HiFi, as the original file without transcoding',
        ['navidrome', 'subsonic', 'original file', 'no transcoding', 'raw stream', '原文件', '不转码', '音乐服务器', '服务器原文件'],
        context => context.settings.toggleHifiNavidrome(),
        { platform: ['electron'], icon: Server, isAvailable: whereHifiIsSupported },
    ),
    createToggleCommand(
        'hifi-software-volume-toggle',
        'settings',
        'HiFi software volume',
        "Turn on or off letting Folia's volume slider set mpv's volume; not bit-perfect while on",
        ['software volume', 'digital volume', 'mpv volume', 'volume slider', 'dac volume', '软件音量', '数字音量', '音量滑杆', '数字衰减'],
        context => context.settings.toggleHifiSoftwareVolume(),
        { platform: ['electron'], icon: SlidersHorizontal, isAvailable: whereHifiIsSupported },
    ),
    defineCommand({
        id: 'hifi-redetect-mpv',
        group: 'settings',
        title: 'Detect mpv again',
        description: 'Look for mpv again for HiFi, for example after installing or updating it',
        keywords: ['find mpv', 'rescan mpv', 'mpv not found', 'locate mpv', '找不到 mpv', '检测 mpv', '重新查找播放器'],
        icon: RefreshCw,
        platform: ['electron'],
        // The HiFi page disables its button while a download runs; the command is gone then too.
        isAvailable: context => (context ? context.settings.canRedetectHifiRuntime() : true),
        execute: async (_input, context) => {
            const { t, setStatusMsg } = context.shared;
            const runtime = await context.settings.redetectHifiRuntime();
            if (!runtime) {
                setStatusMsg({ type: 'error', text: t('hifi.errors.UNKNOWN') });
                return true;
            }
            // The same line the HiFi page shows: which mpv is in use, or why there is none.
            setStatusMsg({ type: runtime.available ? 'success' : 'error', text: runtimeLine(runtime, translateWith(t)).text });
            return true;
        },
    }),
    defineCommand({
        id: 'hifi-download-mpv',
        group: 'settings',
        title: 'Download or update mpv',
        description: 'Download the recommended mpv for HiFi, or update the one Folia downloaded; the progress shows in the HiFi settings',
        keywords: ['install mpv', 'get mpv', 'upgrade mpv', 'mpv installer', '安装 mpv', '获取 mpv', '升级 mpv', '下载播放器'],
        icon: Download,
        platform: ['electron'],
        // Only where the HiFi page offers the button: a build Folia can download, nothing running, something newer.
        isAvailable: context => context?.settings.canInstallHifiRuntime() ?? false,
        // A download is not undone by pressing a key again, so no execute shortcut.
        execute: (_input, context) => {
            const { t, setStatusMsg } = context.shared;
            void context.settings.installHifiRuntime().then((result) => {
                if (result?.ok) {
                    setStatusMsg({ type: 'success', text: runtimeLine(result.status, translateWith(t)).text });
                    return;
                }
                // A cancel is the listener's own doing; it needs no message.
                if (result?.errorCode === 'INSTALL_CANCELLED') return;
                setStatusMsg({ type: 'error', text: t(`hifi.errors.${result?.errorCode ?? 'INSTALL_FAILED'}`) });
            });
            // The progress bar and the cancel button are on the HiFi page.
            context.settings.openSettings('options', 'hifi', null, 'hifiEngine');
            return true;
        },
    }),
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

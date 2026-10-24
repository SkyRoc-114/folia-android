import { option, type SettingsGroupDef } from '../../kit';

// src/components/modal/settings/pages/hifi/options.ts
// The groups and options of the HiFi page, declared apart from the page so the file of each group
// names the same ones. The group ids are the anchors other code opens the settings on
// (settingsAnchorModel). The whole page is the desktop app's: mpv runs under its main process.

/** The desktop build's OS, from the preload; null on the web. */
export const HIFI_PLATFORM: string | null = typeof window !== 'undefined' ? window.electron?.platform ?? null : null;

export const ENGINE: SettingsGroupDef = { id: 'hifiEngine', titleKey: 'hifi.settings.groupEngine', electronOnly: true };
export const OUTPUT: SettingsGroupDef = { id: 'hifiOutput', titleKey: 'hifi.settings.groupOutput', electronOnly: true };
export const DSD: SettingsGroupDef = { id: 'hifiDsd', titleKey: 'hifi.settings.groupDsd', electronOnly: true };
export const SCOPE: SettingsGroupDef = { id: 'hifiScope', titleKey: 'hifi.settings.groupScope', electronOnly: true };
export const VOLUME: SettingsGroupDef = { id: 'hifiVolume', titleKey: 'hifi.settings.groupVolume', electronOnly: true };
export const LIMITS: SettingsGroupDef = { id: 'hifiLimits', titleKey: 'hifi.settings.groupLimits', electronOnly: true };

export const O = {
    enabled: option(ENGINE, 'hifiEnabled', 'hifi.settings.enable'),
    runtime: option(ENGINE, 'hifiRuntime', 'hifi.settings.runtime'),
    mpvPath: option(ENGINE, 'hifiMpvPath', 'hifi.settings.mpvPath'),
    device: option(OUTPUT, 'hifiAudioDevice', 'hifi.settings.device'),
    // Linux has no exclusive mode: mpv's PipeWire and PulseAudio outputs always mix, so mpv is started
    // with --audio-exclusive=no there and the page does not draw the switch (the saved value stays).
    exclusive: option(OUTPUT, 'hifiExclusive', 'hifi.settings.exclusive', { available: () => HIFI_PLATFORM !== 'linux' }),
    dsdMode: option(DSD, 'hifiDsdMode', 'hifi.settings.dsdMode'),
    navidrome: option(SCOPE, 'hifiNavidrome', 'hifi.settings.navidrome'),
    softwareVolume: option(VOLUME, 'hifiSoftwareVolume', 'hifi.settings.softwareVolume'),
    noAsio: option(LIMITS, 'hifiLimitNoAsio', 'hifi.settings.limitNoAsio'),
    dopWindowsOnly: option(LIMITS, 'hifiLimitDop', 'hifi.settings.limitDop'),
    bypassed: option(LIMITS, 'hifiLimitBypassed', 'hifi.settings.limitBypassed'),
    videoExport: option(LIMITS, 'hifiLimitVideoExport', 'hifi.settings.limitVideoExport'),
    mediaControls: option(LIMITS, 'hifiLimitMediaControls', 'hifi.settings.limitMediaControls'),
};

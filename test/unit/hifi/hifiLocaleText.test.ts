import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import zhCN from '../../../src/i18n/locales/zh-CN';
import id from '../../../src/i18n/locales/in';

// test/unit/hifi/hifiLocaleText.test.ts
// The HiFi texts that state facts, read from the shipped locales: the DoP warning says what a DAC
// without DoP really plays (a quiet hiss, not full-scale noise), the busy-device error holds on every
// platform, Linux is not told about an exclusive switch it does not have, the media-controls limit
// names what takes them away on each system, and the per-platform advice and the labels the player
// surfaces and the settings page ask for exist in all three languages.

const LOCALES = { en, 'zh-CN': zhCN, in: id } as const;

/** A dotted key read without the locale's type, so a key the type does not know yet reads as undefined. */
const read = (locale: object, key: string): unknown => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    locale,
);

const KEYS = [
    'hifi.player.badgeChip',
    'hifi.signal.verdictDesc.sharedMixer',
    'hifi.signal.verdictDesc.sharedMixerExclusiveOn',
    'hifi.signal.verdictDesc.sharedMixerLinux',
    'hifi.signal.verdictDesc.notLoaded',
    'hifi.signal.outputDirect',
    'hifi.settings.deviceLinuxHint',
    'hifi.settings.deviceDirect',
    'hifi.settings.exclusiveLinuxNote',
    'hifi.settings.limitMediaControls',
    'hifi.settings.limitMediaControlsDesc',
    'hifi.settings.limitMediaControlsLinuxDesc',
] as const;

/** One key in each locale. */
const textsOf = (key: string) => Object.fromEntries(Object.entries(LOCALES).map(([name, locale]) => [name, String(read(locale, key))])) as Record<keyof typeof LOCALES, string>;

describe('HiFi locale texts', () => {
    it.each(Object.keys(LOCALES))('has the HiFi texts the surfaces ask for in %s', (name) => {
        const locale = LOCALES[name as keyof typeof LOCALES];
        expect(KEYS.filter(key => typeof read(locale, key) !== 'string' || !(read(locale, key) as string).trim())).toEqual([]);
    });

    it('warns that a DAC without DoP plays a hiss, not full-scale noise', () => {
        // The DoP marker byte reads as about -27 dBFS at fs/2 and the DSD bits as about -48 dBFS of hiss.
        const warnings = Object.fromEntries(Object.entries(LOCALES).map(([name, locale]) => [name, String(read(locale, 'hifi.settings.dopWarning'))]));
        expect(warnings.en).not.toMatch(/full[- ]scale|loud/i);
        expect(warnings.en).toMatch(/hiss/i);
        expect(warnings['zh-CN']).not.toMatch(/满幅|巨响|很响/);
        expect(warnings['zh-CN']).toMatch(/沙沙/);
        expect(warnings.in).not.toMatch(/skala penuh|keras/i);
        expect(warnings.in).toMatch(/desis/i);
    });

    it('says what holds a busy device on every platform, and does not offer exclusive mode as the way out', () => {
        // On Linux a busy ALSA hw: device is usually held by PipeWire, and the exclusive switch does not free it.
        const busy = Object.fromEntries(Object.entries(LOCALES).map(([name, locale]) => [name, String(read(locale, 'hifi.errors.DEVICE_BUSY'))]));
        expect(busy.en).not.toMatch(/exclusive/i);
        expect(busy.en).toMatch(/sound server/i);
        expect(busy.en).toMatch(/HiFi settings/);
        expect(busy['zh-CN']).not.toMatch(/独占/);
        expect(busy['zh-CN']).toMatch(/音频服务/);
        expect(busy['zh-CN']).toMatch(/HiFi 设置/);
        expect(busy.in).not.toMatch(/eksklusif/i);
        expect(busy.in).toMatch(/server suara/i);
        expect(busy.in).toMatch(/pengaturan HiFi/);
    });

    it('tells Linux there is no exclusive mode, without pointing at a switch the page no longer draws', () => {
        // mpv runs with --audio-exclusive=no on Linux, so the old "whether this is on or off" has nothing to refer to.
        const note = textsOf('hifi.settings.exclusiveLinuxNote');
        expect(note.en).not.toMatch(/on or off|this switch/i);
        expect(note.en).toMatch(/no exclusive mode/i);
        expect(note.en).toMatch(/PipeWire/);
        expect(note.en).toMatch(/hw:/);
        expect(note['zh-CN']).not.toMatch(/开不开|这个开关/);
        expect(note['zh-CN']).toMatch(/没有独占模式/);
        expect(note['zh-CN']).toMatch(/hw:/);
        expect(note.in).not.toMatch(/menyala atau tidak/i);
        expect(note.in).toMatch(/tidak punya mode eksklusif/i);
        expect(note.in).toMatch(/hw:/);
        expect(read(en, 'hifi.settings.exclusiveLinuxDesc')).toBeUndefined();
    });

    it('ties the loss of system media controls to exclusive mode on Windows and macOS, and to a direct device on Linux', () => {
        // useHifiMediaSessionKeepAlive.isExclusiveHifiOutput: the exclusive switch off Linux, an ALSA hw: device on it.
        const title = textsOf('hifi.settings.limitMediaControls');
        expect(title.en).not.toMatch(/exclusive/i);
        expect(title['zh-CN']).not.toMatch(/独占/);
        expect(title.in).not.toMatch(/eksklusif/i);

        const exclusive = textsOf('hifi.settings.limitMediaControlsDesc');
        expect(exclusive.en).toMatch(/exclusive mode/);
        expect(exclusive.en).not.toMatch(/linux|mpris/i);
        expect(exclusive['zh-CN']).toMatch(/独占模式/);
        expect(exclusive['zh-CN']).not.toMatch(/Linux|MPRIS/);
        expect(exclusive.in).toMatch(/mode eksklusif/);
        expect(exclusive.in).not.toMatch(/linux|mpris/i);

        const linux = textsOf('hifi.settings.limitMediaControlsLinuxDesc');
        for (const text of Object.values(linux)) {
            expect(text).toMatch(/ALSA hw:/);
            expect(text).toMatch(/MPRIS/);
        }
        expect(linux.en).not.toMatch(/exclusive/i);
        expect(linux['zh-CN']).not.toMatch(/独占/);
        expect(linux.in).not.toMatch(/eksklusif/i);
    });

    it('names the direct mark as the device list shows it, at the front of a device name', () => {
        // HifiOutputGroup writes "<mark> · <name>"; the hints quote the mark as it reads there.
        const mark = textsOf('hifi.settings.deviceDirect');
        expect(mark.en).toBe('Direct');
        expect(mark.in).toBe('Langsung');
        for (const key of ['hifi.settings.deviceLinuxHint', 'hifi.settings.deviceDirectNote', 'hifi.settings.exclusiveLinuxNote', 'hifi.signal.verdictDesc.sharedMixerLinux']) {
            const texts = textsOf(key);
            expect(texts.en).toContain('marked Direct');
            expect(texts['zh-CN']).toContain(`「${mark['zh-CN']}」`);
            expect(texts.in).toContain('bertanda Langsung');
        }
    });

    it('no longer tells Linux to turn on exclusive mode for a shared output', () => {
        expect(String(read(en, 'hifi.signal.verdictDesc.sharedMixer'))).not.toMatch(/linux|hw:/i);
        expect(String(read(en, 'hifi.signal.verdictDesc.sharedMixerLinux'))).not.toMatch(/exclusive/i);
    });
});

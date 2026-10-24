import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import zhCN from '../../../src/i18n/locales/zh-CN';
import id from '../../../src/i18n/locales/in';

// test/unit/hifi/hifiLocaleText.test.ts
// The HiFi texts that state facts, read from the shipped locales: the DoP warning says what a DAC
// without DoP really plays (a quiet hiss, not full-scale noise), and the per-platform advice and the
// labels the player surfaces and the settings page ask for exist in all three languages.

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
    'hifi.settings.exclusiveLinuxDesc',
    'hifi.settings.exclusiveLinuxNote',
    'hifi.settings.limitMediaControls',
    'hifi.settings.limitMediaControlsDesc',
] as const;

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

    it('no longer tells Linux to turn on exclusive mode for a shared output', () => {
        expect(String(read(en, 'hifi.signal.verdictDesc.sharedMixer'))).not.toMatch(/linux|hw:/i);
        expect(String(read(en, 'hifi.signal.verdictDesc.sharedMixerLinux'))).not.toMatch(/exclusive/i);
    });
});

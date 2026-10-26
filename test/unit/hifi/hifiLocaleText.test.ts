import { describe, expect, it } from 'vitest';
import en from '../../../src/i18n/locales/en';
import zhCN from '../../../src/i18n/locales/zh-CN';
import id from '../../../src/i18n/locales/in';

// test/unit/hifi/hifiLocaleText.test.ts
// The HiFi texts that state facts, read from the shipped locales: the DoP warning says what a DAC
// without DoP really plays (a quiet hiss, not full-scale noise), the busy-device error holds on every
// platform, Linux is not told about an exclusive switch it does not have, the media-controls limit
// names what takes them away on each system, and the per-platform advice and the labels the player
// surfaces and the settings page ask for exist in all three languages. The PipeWire texts say only what
// PipeWire reports, never bit-perfect, say Folia cannot confirm what the DAC receives, and send the reader
// to the DAC's own indicator or their ears.

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
    'hifi.settings.limitPipewireRateFoot',
    'hifi.signal.verdictShort.ratePassthrough',
    'hifi.signal.verdict.ratePassthrough',
    'hifi.signal.verdictDesc.ratePassthrough',
    'hifi.signal.verdictDesc.sharedMixerPipewire',
    'hifi.signal.verdictDesc.sharedMixerVirtual',
    'hifi.signal.stage.system',
    'hifi.signal.conversion.filter',
    'hifi.signal.conversion.filterPlain',
    'hifi.signal.conversion.volumePipewire',
    'hifi.signal.conversion.volumePipewirePlain',
    'hifi.signal.systemReported',
    ...[
        'checksLabel', 'rateOk', 'rateWarn', 'rateUnknown', 'rateVirtual', 'filtersOk', 'filtersWarn', 'streamVolumeOk', 'streamVolumeWarn',
        'deviceVolumeOk', 'deviceVolumeWarn', 'otherStreamsOk', 'otherStreamsWarn', 'ownStream', 'channelsOk', 'channelsWarn',
        'channelsWarnPlain', 'hintForced', 'hintNotAllowed', 'hintBusy', 'hintBusyOwn', 'hintJoin', 'hintNoSwitch', 'snippetLabel',
        'commandLabel', 'footnote',
    ].map(key => `hifi.signal.system.${key}`),
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

    it('ties the loss of system media controls to exclusive mode on Windows and macOS', () => {
        // useHifiMediaSessionKeepAlive.isExclusiveHifiOutput off Linux; on Linux main registers MPRIS (useHifiMpris), so no limit.
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

describe('HiFi PipeWire texts', () => {
    it('names rate passthrough after PipeWire and never as bit-perfect', () => {
        const title = textsOf('hifi.signal.verdict.ratePassthrough');
        expect(title.en).toBe('Sample rate passthrough (via PipeWire)');
        expect(title['zh-CN']).toBe('采样率直通（经 PipeWire）');
        expect(title.in).toMatch(/PipeWire/);
        for (const key of ['hifi.signal.verdict.ratePassthrough', 'hifi.signal.verdictShort.ratePassthrough']) {
            const texts = textsOf(key);
            expect(texts.en).not.toMatch(/bit-perfect/i);
            expect(texts['zh-CN']).not.toMatch(/原生直通/);
            expect(texts.in).not.toMatch(/bit-perfect/i);
        }
        // The sentence under it reads as PipeWire's report and says outright that this is not a bit-perfect check.
        const desc = textsOf('hifi.signal.verdictDesc.ratePassthrough');
        expect(desc.en).toMatch(/^According to PipeWire, /);
        expect(desc['zh-CN']).toMatch(/^按 PipeWire 的报告，/);
        expect(desc.in).toMatch(/^Menurut PipeWire, /);
        expect(desc.en).toMatch(/not a bit-perfect check/);
        expect(desc['zh-CN']).toMatch(/不是对原生直通的确认/);
        expect(desc.in).toMatch(/bukan pemeriksaan bit-perfect/);
    });

    it('says the PipeWire step is only what PipeWire reports, that Folia cannot confirm what the DAC receives, and points at the DAC or the ears', () => {
        const footnote = textsOf('hifi.signal.system.footnote');
        expect(footnote.en).toBe("This is what PipeWire reports. Folia can only read what PipeWire reports and cannot confirm what your DAC receives: check your DAC's sample-rate indicator, or listen.");
        expect(footnote['zh-CN']).toBe('以上是 PipeWire 报告的状态。Folia 只读得到 PipeWire 报的内容，确认不了 DAC 实际收到的采样率：请看 DAC 的采样率指示，或者用耳朵听。');
        expect(footnote.in).toMatch(/hanya bisa membaca laporan PipeWire/);
        expect(footnote.in).toMatch(/tidak bisa memastikan apa yang diterima DAC/);
        expect(footnote.in).toMatch(/indikator laju sampel DAC/);
        expect(footnote.in).toMatch(/dengarkan/);
        const foot = textsOf('hifi.settings.limitPipewireRateFoot');
        for (const text of Object.values(foot)) {
            expect(text).toMatch(/default\.clock\.allowed-rates/);
            expect(text).toMatch(/DAC/);
        }
    });

    it('names the setting and the folder the config line goes in, and why a busy device does not switch', () => {
        const notAllowed = textsOf('hifi.signal.system.hintNotAllowed');
        for (const text of Object.values(notAllowed)) {
            expect(text).toContain('{{rate}}');
            expect(text).toContain('default.clock.allowed-rates');
            expect(text).toContain('~/.config/pipewire/pipewire.conf.d/');
        }
        expect(notAllowed.en).toMatch(/^PipeWire is not allowed to switch to \{\{rate\}\}: add it to default\.clock\.allowed-rates/);
        const busy = textsOf('hifi.signal.system.hintBusy');
        expect(busy.en).toMatch(/^PipeWire only switches rates while the device is idle; other streams are playing on it/);
        for (const text of Object.values(busy)) expect(text).toContain('{{names}}');
        // Linux has no media-controls keep-alive any more (main registers MPRIS): Folia's own stream is its web engine.
        for (const text of Object.values(textsOf('hifi.signal.system.hintBusyOwn'))) {
            expect(text).toMatch(/web/i);
            expect(text).not.toMatch(/MPRIS/);
        }
        // Two sentences in a row: a space between them, none in Chinese.
        const join = textsOf('hifi.signal.system.hintJoin');
        expect(join).toEqual({ en: '{{first}} {{second}}', 'zh-CN': '{{first}}{{second}}', in: '{{first}} {{second}}' });
    });

    it('names clock.force-rate and both rates in the forced hint, and the virtual device in its lines', () => {
        for (const text of Object.values(textsOf('hifi.signal.system.hintForced'))) {
            expect(text).toContain('clock.force-rate');
            expect(text).toContain('{{forced}}');
            expect(text).toContain('{{rate}}');
        }
        for (const text of Object.values(textsOf('hifi.signal.system.rateVirtual'))) {
            expect(text).toContain('{{name}}');
            expect(text).toMatch(/EasyEffects/);
        }
        for (const text of Object.values(textsOf('hifi.signal.verdictDesc.sharedMixerVirtual'))) {
            expect(text).toMatch(/EasyEffects/);
            expect(text).toMatch(/ALSA hw:/);
        }
        for (const text of Object.values(textsOf('hifi.signal.conversion.volumePipewire'))) expect(text).toContain('{{volume}}');
        // A virtual device is not said to resample, nor to be confirmed.
        const virtualTexts = [...Object.values(textsOf('hifi.signal.system.rateVirtual')), ...Object.values(textsOf('hifi.signal.verdictDesc.sharedMixerVirtual'))];
        for (const text of virtualTexts) expect(text).not.toMatch(/resampl|重采样|confirm|确认|memastikan/i);
    });

    it('never words a PipeWire text as confirmed, verified or bit-perfect beyond saying it is not', () => {
        const keys = KEYS.filter(key => key.startsWith('hifi.signal.system.') || key.includes('atePassthrough') || key.includes('Pipewire') || key.includes('Virtual'));
        for (const key of keys) {
            const texts = textsOf(key);
            expect(texts.en, key).not.toMatch(/\bverified\b|\bconfirmed\b/i);
            expect(texts['zh-CN'], key).not.toMatch(/已确认|已验证|逐位直通/);
            expect(texts.en.replace(/not a bit-perfect check|For bit-perfect output/g, ''), key).not.toMatch(/bit-perfect/i);
            expect(texts.in, key).not.toMatch(/\bterverifikasi\b|\bdikonfirmasi\b|\bsudah dipastikan\b/i);
        }
    });
});

// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stores read localStorage at import time; see foliumUiRegistries.test.ts.
const storage = vi.hoisted(() => {
    const items = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => items.get(key) ?? null,
            setItem: (key: string, value: string) => { items.set(key, String(value)); },
            removeItem: (key: string) => { items.delete(key); },
            clear: () => items.clear(),
            key: (index: number) => Array.from(items.keys())[index] ?? null,
            get length() { return items.size; },
        },
    });
    return items;
});

// The sheet is drawn in a layer of the app shell; here it is its title, header actions, content and note, in place, while open.
vi.mock('@/components/shared/Sheet', () => ({
    default: ({ isOpen, title, headerActions, children, footerNote }: {
        isOpen: boolean;
        title: string;
        headerActions?: React.ReactNode;
        children?: React.ReactNode;
        footerNote?: React.ReactNode;
    }) => (isOpen ? React.createElement('div', { role: 'dialog', 'aria-label': title }, headerActions, children, footerNote) : null),
}));

import i18n from '@/i18n/config';
import type { HifiEngineState, HifiMpvAudioParams, HifiSourceSpec } from '@/types/hifi';
import HifiBadge from '@/components/hifi/HifiBadge';
import HifiSignalPathPanel from '@/components/hifi/HifiSignalPathPanel';
import { closeHifiSignalPath, openHifiSignalPath, useHifiPanelStore } from '@/components/hifi/hifiPanelStore';
import AudioEqualizerDialog from '@/components/panelTab/AudioEqualizerDialog';
import ReplayGainControl from '@/components/panelTab/ReplayGainControl';
import SoundTiles from '@/components/panelTab/controls/SoundTiles';
import VolumeRow from '@/components/panelTab/controls/VolumeRow';
import { PanelSlider } from '@/components/panelTab/controls/PanelSlider';
import { useHifiEngineStore } from '@/services/hifi/hifiEngineStore';
import { useHifiTrackStore } from '@/services/hifi/hifiTrackStore';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { useHifiSettingsStore } from '@/stores/useHifiSettingsStore';
import { setPlaybackRoute } from '@/stores/usePlaybackStore';

// test/unit/hifi/hifiPlayerSurfaces.test.ts
// The player surfaces on the HiFi route, drawn in jsdom with the real stores: the badge and the sheet it
// opens, the controls tab tiles and volume row, the slider's out-of-reach state, the audio effects window
// and the ReplayGain row. On the web route every one of them looks as it did before HiFi.

const params = (format: string, samplerate: number): HifiMpvAudioParams => ({ format, samplerate, channelCount: 2, channels: 'stereo' });

const spec: HifiSourceSpec = {
    origin: 'local',
    codec: 'FLAC',
    container: 'FLAC',
    bitDepth: 24,
    sampleRate: 96000,
    channels: 2,
    lossless: true,
    isDsd: false,
    dsdRate: null,
    bitrate: null,
};

const engineState = (trackKey: string): HifiEngineState => ({
    status: 'playing',
    processRunning: true,
    trackKey,
    songKey: 'local:1',
    sourceKind: 'local',
    localSourceKey: 'source-1',
    durationSec: 200,
    positionSec: 12,
    paused: false,
    loopFile: false,
    audioParams: params('s32', 96000),
    audioOutParams: params('s32', 96000),
    currentAo: 'wasapi',
    audioDevice: 'wasapi/{d10}',
    exclusive: true,
    spdif: null,
    volume: 100,
    track: { codec: 'flac', codecDesc: null, decoder: 'flac', demuxSamplerate: 96000, demuxChannelCount: 2, demuxBitrate: null, formatName: 'flac' },
    next: null,
    errorCode: null,
    circuitOpen: false,
    seq: 3,
});

/** The song mpv plays: the track store's current entry and the engine state for the same trackKey. */
const playOnHifi = (engineTrackKey = 'local:1#a') => {
    act(() => {
        useHifiTrackStore.setState({
            current: {
                trackKey: 'local:1#a',
                songKey: 'local:1',
                origin: 'local',
                song: { id: 1, name: 'Track One', artists: [], album: { id: 1, name: 'Album' }, durationMs: 200000 } as never,
                localSourceKey: 'source-1',
            },
            loadState: 'ready',
            loadError: null,
            sourceSpec: spec,
        });
        useHifiEngineStore.setState({ engine: engineState(engineTrackKey) });
        setPlaybackRoute('hifi');
    });
};

const initialAudio = useAudioSettingsStore.getState();
const initialHifiSettings = useHifiSettingsStore.getState();

describe('the HiFi player surfaces', () => {
    let root: Root;
    let place: HTMLElement;
    const draw = (element: React.ReactElement) => {
        act(() => root.render(element));
    };
    const press = (element: Element) => act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const sliders = () => Array.from(place.querySelectorAll<HTMLElement>('[role="slider"]'));

    beforeEach(async () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        await i18n.changeLanguage('en');
        storage.clear();
        useAudioSettingsStore.setState(initialAudio, true);
        useHifiSettingsStore.setState(initialHifiSettings, true);
        useHifiTrackStore.setState({ current: null, loadState: 'idle', loadError: null, sourceSpec: null });
        useHifiEngineStore.setState({ engine: null });
        setPlaybackRoute('web');
        closeHifiSignalPath();
        place = document.body.appendChild(document.createElement('div'));
        root = createRoot(place);
    });

    afterEach(() => {
        act(() => root.unmount());
        place.remove();
        setPlaybackRoute('web');
    });

    describe('the badge', () => {
        it('is not there on the web route', () => {
            draw(React.createElement(HifiBadge));
            expect(place.innerHTML).toBe('');
        });

        it('opens the signal path without the click reaching the capsule', () => {
            playOnHifi();
            const capsuleClick = vi.fn();
            draw(React.createElement('div', { onClick: capsuleClick }, React.createElement(HifiBadge)));
            const badge = place.querySelector('button')!;
            expect(badge.getAttribute('aria-haspopup')).toBe('dialog');
            // Rate from the output, bit depth from the file (mpv decodes this 24-bit FLAC as s32).
            const text = i18n.t('hifi.player.badgeWithFormat', {
                verdict: i18n.t('hifi.signal.verdictShort.bitPerfect'),
                format: `${i18n.t('hifi.signal.sampleRate', { value: '96' })} / ${i18n.t('hifi.signal.bitDepth', { bits: 24 })}`,
            });
            expect(badge.getAttribute('aria-label')).toBe(i18n.t('hifi.player.badgeAria', { badge: text }));
            expect(badge.textContent).toContain(text);
            press(badge);
            expect(useHifiPanelStore.getState().isSignalPathOpen).toBe(true);
            expect(capsuleClick).not.toHaveBeenCalled();
        });

        it('stays out of reach while the controls are', () => {
            playOnHifi();
            draw(React.createElement(HifiBadge, { disabled: true }));
            press(place.querySelector('button')!);
            expect(useHifiPanelStore.getState().isSignalPathOpen).toBe(false);
        });
    });

    describe('the signal path sheet', () => {
        it('lists the five stages under the verdict, and closes itself once the route leaves HiFi', () => {
            playOnHifi();
            openHifiSignalPath();
            draw(React.createElement(HifiSignalPathPanel));
            const dialog = place.querySelector('[role="dialog"]')!;
            expect(dialog.getAttribute('aria-label')).toBe(i18n.t('hifi.signal.title'));
            expect(dialog.querySelector('[role="status"]')!.textContent).toBe(i18n.t('hifi.signal.verdict.bitPerfect'));
            expect(dialog.querySelectorAll('ol > li')).toHaveLength(5);
            expect(dialog.textContent).toContain(i18n.t('hifi.signal.bypassedNote'));

            act(() => setPlaybackRoute('web'));
            expect(useHifiPanelStore.getState().isSignalPathOpen).toBe(false);
            expect(place.querySelector('[role="dialog"]')).toBeNull();
        });

        it('does not compare against the engine state of another track', () => {
            playOnHifi('local:0#old');
            openHifiSignalPath();
            draw(React.createElement(HifiSignalPathPanel));
            expect(place.querySelector('[role="status"]')!.textContent).toBe(i18n.t('hifi.signal.verdict.unknown'));
        });
    });

    describe('the controls tab', () => {
        const tiles = () => React.createElement(SoundTiles, { loopMode: 'off', onToggleLoop: vi.fn(), loopToggleDisabled: false });

        it('keeps the loop, automix and effects tiles on the web route', () => {
            draw(tiles());
            expect(place.querySelectorAll('button')).toHaveLength(3);
            expect(place.querySelector('[data-ponder="audio-equalizer"]')).not.toBeNull();
        });

        it('puts one signal path tile over two columns in place of automix and effects on HiFi', () => {
            playOnHifi();
            draw(tiles());
            const buttons = place.querySelectorAll('button');
            expect(buttons).toHaveLength(2);
            expect(place.querySelector('[data-ponder="audio-equalizer"]')).toBeNull();
            expect(buttons[1].closest('.col-span-2')).not.toBeNull();
            // Lit: the path is bit-perfect.
            expect(buttons[1].className).toContain('bg-[var(--st-raise)]');
            press(buttons[1]);
            expect(useHifiPanelStore.getState().isSignalPathOpen).toBe(true);
        });

        const volumeRow = (onVolumePreview = vi.fn(), onToggleMute = vi.fn()) => React.createElement(VolumeRow, {
            volume: 0.4,
            isMuted: false,
            onVolumePreview,
            onVolumeChange: vi.fn(),
            onToggleMute,
        });

        it('leaves the volume row as it was on the web route', () => {
            draw(volumeRow());
            expect(sliders()[0].getAttribute('aria-disabled')).toBeNull();
            expect(sliders()[0].getAttribute('aria-valuenow')).toBe('40');
            expect(place.textContent).not.toContain(i18n.t('hifi.player.volumeFixed'));
        });

        it('hands the volume to the DAC on HiFi: the slider and mute are out of reach and read 100%', () => {
            playOnHifi();
            const onToggleMute = vi.fn();
            draw(volumeRow(vi.fn(), onToggleMute));
            expect(sliders()[0].getAttribute('aria-disabled')).toBe('true');
            expect(sliders()[0].getAttribute('aria-valuenow')).toBe('100');
            expect(place.textContent).toContain(i18n.t('hifi.player.volumeFixed'));
            press(place.querySelector('button')!);
            expect(onToggleMute).not.toHaveBeenCalled();
        });

        it('keeps the volume in reach on HiFi with software volume on', () => {
            useHifiSettingsStore.setState({ softwareVolume: true });
            playOnHifi();
            draw(volumeRow());
            expect(sliders()[0].getAttribute('aria-disabled')).toBeNull();
            expect(sliders()[0].getAttribute('aria-valuenow')).toBe('40');
        });
    });

    describe('the slider out of reach', () => {
        it('moves for no key and no press, and commits nothing', () => {
            const onPreview = vi.fn();
            const onCommit = vi.fn();
            draw(React.createElement(PanelSlider, { value: 0.5, onPreview, onCommit, label: 'Volume', valueText: '50%', disabled: true }));
            const slider = sliders()[0];
            expect(slider.className).toContain('opacity-40');
            act(() => {
                slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
                slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
                // jsdom has no PointerEvent; React takes a mouse event of that type all the same.
                slider.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }));
                slider.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
            });
            expect(onPreview).not.toHaveBeenCalled();
            expect(onCommit).not.toHaveBeenCalled();
        });

        it('still moves for a key when in reach', () => {
            const onPreview = vi.fn();
            draw(React.createElement(PanelSlider, { value: 0.5, onPreview, onCommit: vi.fn(), label: 'Volume', valueText: '50%' }));
            act(() => {
                sliders()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
            });
            expect(onPreview).toHaveBeenCalledWith(0.55);
        });
    });

    describe('the audio effects window', () => {
        beforeEach(() => {
            useAudioSettingsStore.getState().openAudioEqualizer();
        });

        it('says it is bypassed on HiFi and keeps the switch, presets, bands and effects out of reach', () => {
            playOnHifi();
            draw(React.createElement(AudioEqualizerDialog, { isDaylight: false }));
            expect(place.querySelector('[role="note"]')!.textContent).toContain(i18n.t('hifi.player.bypassNoticeTitle'));
            expect((place.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(true);
            sliders().forEach(slider => expect(slider.closest('[inert]')).not.toBeNull());
            const preset = Array.from(place.querySelectorAll('button')).find(button => button.textContent === i18n.t('ui.equalizerPreset.flat'));
            expect(preset?.closest('[inert]')).not.toBeNull();
        });

        it('has no notice and nothing out of reach on the web route', () => {
            draw(React.createElement(AudioEqualizerDialog, { isDaylight: false }));
            expect(place.querySelector('[role="note"]')).toBeNull();
            expect((place.querySelector('[role="switch"]') as HTMLButtonElement).disabled).toBe(false);
            expect(place.querySelector('[inert]')).toBeNull();
        });
    });

    describe('the ReplayGain row', () => {
        const row = () => React.createElement(ReplayGainControl, { values: { trackGain: -6.2 }, mode: 'track', onChangeMode: vi.fn() });

        it('says it is bypassed on HiFi, beside the measured gain', () => {
            playOnHifi();
            draw(row());
            expect(place.textContent).toContain(`${i18n.t('hifi.player.replayGainBypassed')} · ${i18n.t('localMusic.replayGainTrack')} -6.2 dB`);
        });

        it('shows only the measured gain on the web route', () => {
            draw(row());
            expect(place.textContent).not.toContain(i18n.t('hifi.player.replayGainBypassed'));
        });
    });
});

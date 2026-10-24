import { describe, expect, it, vi } from 'vitest';
import { hifiCommands } from '../../../src/components/command-palette/commands/hifiCommands';
import type { CommandPaletteContext } from '../../../src/components/command-palette/types';
import { getAvailableSettingsSectionIds, sectionForSettingsSubview } from '../../../src/components/modal/settings/navigation/settingsLastSection';

// test/unit/command-palette/hifiCommands.test.ts
// The HiFi commands: the switch never skips the full-volume warning (it opens the settings page
// instead), the settings command lands on the HiFi page, and the signal path is offered only for a
// song on the HiFi route.

type HifiState = { supported?: boolean; enabled?: boolean; confirmed?: boolean; route?: boolean };

const contextFor = ({ supported = true, enabled = false, confirmed = false, route = false }: HifiState = {}) => {
    const settings = {
        openSettings: vi.fn(),
        isHifiSupported: () => supported,
        isHifiEnabled: () => enabled,
        isHifiVolumeConfirmed: () => confirmed,
        setHifiEnabled: vi.fn(),
    };
    const playback = {
        isHifiRoute: () => route,
        openHifiSignalPath: vi.fn(),
    };
    return { settings, playback, context: { settings, playback } as unknown as CommandPaletteContext };
};

const command = (id: string) => hifiCommands.find(item => item.id === id)!;

describe('hifi commands', () => {
    it('are desktop-only', () => {
        expect(hifiCommands.map(item => [item.id, item.platform])).toEqual([
            ['hifi-toggle', ['electron']],
            ['hifi-settings', ['electron']],
            ['hifi-signal-path', ['electron']],
        ]);
    });

    it('turns HiFi off directly', async () => {
        const { context, settings } = contextFor({ enabled: true, confirmed: true });
        await command('hifi-toggle').execute('', context);
        expect(settings.setHifiEnabled).toHaveBeenCalledExactlyOnceWith(false);
        expect(settings.openSettings).not.toHaveBeenCalled();
    });

    it('opens the HiFi page instead of switching on while the full-volume warning is unanswered', async () => {
        const { context, settings } = contextFor({ enabled: false, confirmed: false });
        await command('hifi-toggle').execute('', context);
        expect(settings.setHifiEnabled).not.toHaveBeenCalled();
        expect(settings.openSettings).toHaveBeenCalledExactlyOnceWith('options', 'hifi', null, 'hifiEngine');
    });

    it('switches on once the warning was accepted', async () => {
        const { context, settings } = contextFor({ enabled: false, confirmed: true });
        await command('hifi-toggle').execute('', context);
        expect(settings.setHifiEnabled).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('offers the switch only where the build has the engine', () => {
        expect(command('hifi-toggle').isAvailable?.(contextFor({ supported: false }).context)).toBe(false);
        expect(command('hifi-toggle').isAvailable?.(contextFor({ supported: true }).context)).toBe(true);
        expect(command('hifi-toggle').isAvailable?.()).toBe(true);
    });

    it('lands the settings command on the HiFi page', async () => {
        const { context, settings } = contextFor();
        expect(command('hifi-settings').settingsTarget).toEqual({ subview: 'hifi' });
        await command('hifi-settings').execute('', context);
        expect(settings.openSettings).toHaveBeenCalledExactlyOnceWith('options', 'hifi');
        // The subview is the page itself, which the web build does not have.
        expect(sectionForSettingsSubview('hifi')).toBe('hifi');
        expect(getAvailableSettingsSectionIds({ isElectron: true })).toContain('hifi');
        expect(getAvailableSettingsSectionIds({ isElectron: false })).not.toContain('hifi');
    });

    it('offers the signal path only on the HiFi route, and opens the panel', async () => {
        const signalPath = command('hifi-signal-path');
        expect(signalPath.isAvailable?.(contextFor({ route: false }).context)).toBe(false);
        expect(signalPath.isAvailable?.()).toBe(false);

        const { context, playback } = contextFor({ route: true });
        expect(signalPath.isAvailable?.(context)).toBe(true);
        expect(await signalPath.execute('', context)).toBe(true);
        expect(playback.openHifiSignalPath).toHaveBeenCalledOnce();
    });

    it('carries no execute shortcut', () => {
        expect(hifiCommands.filter(item => item.executeShortcut)).toEqual([]);
    });
});

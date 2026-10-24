import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useHifiEngineStore } from '../../../../../services/hifi/hifiEngine';
import { useHifiSettingsStore } from '../../../../../stores/useHifiSettingsStore';
import type { HifiDsdMode } from '../../../../../types/hifi';
import { Group, Reveal, Row, Segmented, Status } from '../../kit';
import { DSD, HIFI_PLATFORM, O } from './options';

// src/components/modal/settings/pages/hifi/HifiDsdGroup.tsx
// The DSD group of the HiFi page: convert DSD to PCM, or send it as DoP. DoP is offered only on
// Windows (WASAPI exclusive, mpv newer than 0.41.0), and the warning about DACs without DoP stays
// on the card whichever is chosen: such a DAC plays DoP as a hiss instead of the music.

const IS_WINDOWS = HIFI_PLATFORM === 'win32';

type Line = { tone: 'ok' | 'warn'; key: string };

export const HifiDsdGroup: React.FC = () => {
    const { t } = useTranslation();
    const settings = useHifiSettingsStore(useShallow(state => ({
        dsdMode: state.dsdMode,
        setDsdMode: state.setDsdMode,
        exclusive: state.exclusive,
    })));
    // null until the runtime has been asked for.
    const dopCapable = useHifiEngineStore(state => state.runtime?.dopCapable ?? null);
    const supported = useHifiEngineStore(state => state.supported);
    const isDop = settings.dsdMode === 'dop';

    const options: ReadonlyArray<{ value: HifiDsdMode; label: string; disabled?: boolean }> = [
        { value: 'pcm', label: t('hifi.settings.dsdPcm') },
        // A DoP choice saved elsewhere stays selectable, so it can be seen and switched back.
        { value: 'dop', label: t('hifi.settings.dsdDop'), disabled: !IS_WINDOWS && !isDop },
    ];

    // What stands between the choice and DoP actually reaching the DAC.
    const lines: Line[] = [];
    if (IS_WINDOWS && dopCapable !== null) {
        lines.push(dopCapable ? { tone: 'ok', key: 'hifi.settings.dopCapable' } : { tone: 'warn', key: 'hifi.settings.dopNotCapable' });
    }
    if (isDop && !IS_WINDOWS) {
        lines.push({ tone: 'warn', key: 'hifi.settings.dopNotOnThisSystem' });
    }
    if (isDop && !settings.exclusive) {
        lines.push({ tone: 'warn', key: 'hifi.settings.dopNeedsExclusive' });
    }

    return (
        <Group def={DSD}>
            <Row option={O.dsdMode} hint={t('hifi.settings.dsdModeDesc')} note={t('hifi.settings.dopPlatformNote')} disabled={!supported}>
                <Segmented value={settings.dsdMode} options={options} onChange={settings.setDsdMode} />
            </Row>
            <Row notice={t('hifi.settings.dopWarning')} />
            <Reveal when={lines.length > 0}>
                {lines.map(line => (
                    <Row key={line.key} sub label={<Status tone={line.tone}>{t(line.key)}</Status>} />
                ))}
            </Reveal>
        </Group>
    );
};

export default HifiDsdGroup;

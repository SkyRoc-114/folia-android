import React from 'react';
import { useTranslation } from 'react-i18next';
import { useHifiEngineStore } from '../../../../../services/hifi/hifiEngine';
import { useHifiSettingsStore } from '../../../../../stores/useHifiSettingsStore';
import { Group, Reveal, Row, Status, Toggle } from '../../kit';
import { O, VOLUME } from './options';

// src/components/modal/settings/pages/hifi/HifiVolumeGroup.tsx
// The volume group of the HiFi page. By default mpv plays at 100% and the DAC or amplifier sets the
// loudness; software volume lets the app's slider scale the samples in mpv instead, which costs the
// bit-perfect path, and the card says so while it is on.

export const HifiVolumeGroup: React.FC = () => {
    const { t } = useTranslation();
    const softwareVolume = useHifiSettingsStore(state => state.softwareVolume);
    const setSoftwareVolume = useHifiSettingsStore(state => state.setSoftwareVolume);
    // The palette's toggle is offered on the same answer.
    const supported = useHifiEngineStore(state => state.supported);

    return (
        <Group def={VOLUME}>
            <Row option={O.softwareVolume} hint={t('hifi.settings.softwareVolumeDesc')} note={t('hifi.settings.softwareVolumeNote')} disabled={!supported}>
                <Toggle checked={softwareVolume} onChange={setSoftwareVolume} />
            </Row>
            <Reveal when={softwareVolume}>
                <Row sub label={<Status tone="warn">{t('hifi.settings.softwareVolumeOn')}</Status>} />
            </Reveal>
        </Group>
    );
};

export default HifiVolumeGroup;

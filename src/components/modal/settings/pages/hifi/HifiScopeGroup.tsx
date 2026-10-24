import React from 'react';
import { useTranslation } from 'react-i18next';
import { useHifiEngineStore } from '../../../../../services/hifi/hifiEngine';
import { useHifiSettingsStore } from '../../../../../stores/useHifiSettingsStore';
import { Group, Row, Toggle } from '../../kit';
import { O, SCOPE } from './options';

// src/components/modal/settings/pages/hifi/HifiScopeGroup.tsx
// The scope group of the HiFi page: whether Navidrome songs go through HiFi too. Local songs always
// do while HiFi is on, and online songs never do, so Navidrome is the one choice.

export const HifiScopeGroup: React.FC = () => {
    const { t } = useTranslation();
    const navidrome = useHifiSettingsStore(state => state.navidrome);
    const setNavidrome = useHifiSettingsStore(state => state.setNavidrome);
    // The palette's toggle is offered on the same answer.
    const supported = useHifiEngineStore(state => state.supported);

    return (
        <Group def={SCOPE} foot={t('hifi.settings.scopeFoot')}>
            <Row option={O.navidrome} hint={t('hifi.settings.navidromeDesc')} disabled={!supported}>
                <Toggle checked={navidrome} onChange={setNavidrome} />
            </Row>
        </Group>
    );
};

export default HifiScopeGroup;

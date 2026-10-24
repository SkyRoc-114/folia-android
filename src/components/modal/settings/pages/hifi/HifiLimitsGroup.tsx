import React from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Row } from '../../kit';
import { LIMITS, O } from './options';

// src/components/modal/settings/pages/hifi/HifiLimitsGroup.tsx
// The known-limits group of the HiFi page: what HiFi does not do, one row each with the reason, so
// nobody has to find out by trying. Nothing here can be switched.

const LIMIT_ROWS = [
    { option: O.noAsio, hintKey: 'hifi.settings.limitNoAsioDesc' },
    { option: O.dopWindowsOnly, hintKey: 'hifi.settings.limitDopDesc' },
    { option: O.bypassed, hintKey: 'hifi.settings.limitBypassedDesc' },
    { option: O.videoExport, hintKey: 'hifi.settings.limitVideoExportDesc' },
] as const;

export const HifiLimitsGroup: React.FC = () => {
    const { t } = useTranslation();

    return (
        <Group def={LIMITS}>
            {LIMIT_ROWS.map(({ option, hintKey }) => (
                <Row key={option.id} option={option} hint={t(hintKey)} />
            ))}
        </Group>
    );
};

export default HifiLimitsGroup;

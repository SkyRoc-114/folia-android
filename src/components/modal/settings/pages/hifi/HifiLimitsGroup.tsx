import React from 'react';
import { useTranslation } from 'react-i18next';
import { Group, Row } from '../../kit';
import { HIFI_PLATFORM, LIMITS, O } from './options';

// src/components/modal/settings/pages/hifi/HifiLimitsGroup.tsx
// The known-limits group of the HiFi page: what HiFi does not do, one row each with the reason, so
// nobody has to find out by trying. Nothing here can be switched.

// On Windows and macOS the exclusive switch takes the system media controls away: the keep-alive in
// useHifiMediaSessionKeepAlive is gated on it (isExclusiveHifiOutput). Linux has no such limit: main
// registers MPRIS itself (useHifiMpris), whatever the output device.
const SHOW_MEDIA_CONTROLS_LIMIT = HIFI_PLATFORM !== 'linux';

// On Linux the sample rate PipeWire runs the device at decides whether a song is resampled. It
// follows each song only when allowed-rates lists the rate and nothing else plays on the device;
// the signal path shows what PipeWire reports, and only the DAC itself can confirm it.
const PIPEWIRE_RATE_FOOT_KEY = HIFI_PLATFORM === 'linux' ? 'hifi.settings.limitPipewireRateFoot' : null;

const LIMIT_ROWS = [
    { option: O.noAsio, hintKey: 'hifi.settings.limitNoAsioDesc' },
    { option: O.dopWindowsOnly, hintKey: 'hifi.settings.limitDopDesc' },
    { option: O.bypassed, hintKey: 'hifi.settings.limitBypassedDesc' },
    { option: O.videoExport, hintKey: 'hifi.settings.limitVideoExportDesc' },
    ...(SHOW_MEDIA_CONTROLS_LIMIT ? [{ option: O.mediaControls, hintKey: 'hifi.settings.limitMediaControlsDesc' }] : []),
] as const;

export const HifiLimitsGroup: React.FC = () => {
    const { t } = useTranslation();

    return (
        <Group def={LIMITS} foot={PIPEWIRE_RATE_FOOT_KEY ? t(PIPEWIRE_RATE_FOOT_KEY) : undefined}>
            {LIMIT_ROWS.map(({ option, hintKey }) => (
                <Row key={option.id} option={option} hint={t(hintKey)} />
            ))}
        </Group>
    );
};

export default HifiLimitsGroup;

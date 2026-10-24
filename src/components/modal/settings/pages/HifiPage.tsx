import React from 'react';
import type { SettingsOptionDef } from '../kit';
import HifiDsdGroup from './hifi/HifiDsdGroup';
import HifiEngineGroup from './hifi/HifiEngineGroup';
import HifiLimitsGroup from './hifi/HifiLimitsGroup';
import HifiOutputGroup from './hifi/HifiOutputGroup';
import HifiScopeGroup from './hifi/HifiScopeGroup';
import HifiVolumeGroup from './hifi/HifiVolumeGroup';
import { O } from './hifi/options';

// src/components/modal/settings/pages/HifiPage.tsx
// The HiFi page (desktop app only): local and Navidrome songs played by mpv straight to the output
// device. The engine and where mpv comes from first, then the device, DSD, which songs go this way,
// volume, and what HiFi does not do. Each group is its own file under hifi/.

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

const HifiPage: React.FC = () => (
    <>
        <HifiEngineGroup />
        <HifiOutputGroup />
        <HifiDsdGroup />
        <HifiScopeGroup />
        <HifiVolumeGroup />
        <HifiLimitsGroup />
    </>
);

export default HifiPage;

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { hifiEngine, useHifiEngineStore } from '../../../../../services/hifi/hifiEngine';
import { useHifiSettingsStore } from '../../../../../stores/useHifiSettingsStore';
import type { HifiDevice } from '../../../../../types/hifi';
import { Button, Group, Row, Select, Toggle } from '../../kit';
import { HIFI_PLATFORM, O, OUTPUT } from './options';

// src/components/modal/settings/pages/hifi/HifiOutputGroup.tsx
// The output group of the HiFi page: the device mpv plays to, with its refresh button, and
// exclusive mode. Reading the devices starts mpv, so the list is only read once it is opened or
// refreshed; until then the saved device keeps the name it was chosen under. On Linux the ALSA
// hw: devices, the ones that skip the sound server, are marked, and the texts say that choosing
// one of them is the bit-perfect path there: mpv's PipeWire and PulseAudio outputs have no
// exclusive mode, so the switch does not change the sound path on Linux.

const IS_LINUX = HIFI_PLATFORM === 'linux';

/** mpv's own value for "follow the system default". */
const AUTO_DEVICE = 'auto';

type ListState = 'idle' | 'loading' | 'loaded';

export const HifiOutputGroup: React.FC = () => {
    const { t } = useTranslation();
    const settings = useHifiSettingsStore(useShallow(state => ({
        audioDevice: state.audioDevice,
        audioDeviceLabel: state.audioDeviceLabel,
        setAudioDevice: state.setAudioDevice,
        exclusive: state.exclusive,
        setExclusive: state.setExclusive,
    })));
    const devices = useHifiEngineStore(state => state.devices);
    const runtime = useHifiEngineStore(state => state.runtime);
    // Without the engine (a build whose preload has no HiFi) nothing here does anything; the palette asks the same.
    const supported = useHifiEngineStore(state => state.supported);
    // The engine store keeps the last list for the session, so a page opened again starts from it.
    const [listState, setListState] = useState<ListState>(() => (devices.length > 0 ? 'loaded' : 'idle'));
    const noMpv = runtime !== null && !runtime.available;

    const refresh = async () => {
        setListState('loading');
        await hifiEngine.listDevices();
        setListState('loaded');
    };

    const ensureLoaded = () => {
        if (listState === 'idle' && !noMpv) {
            void refresh();
        }
    };

    const deviceLabel = (device: HifiDevice) => {
        const name = device.description || device.name;
        return IS_LINUX && device.direct ? `${name} · ${t('hifi.settings.deviceDirect')}` : name;
    };

    // mpv lists 'auto' itself; it is drawn once, first, under the app's own name.
    const listed = devices.filter(device => device.name !== AUTO_DEVICE);
    const options = [
        { value: AUTO_DEVICE, label: t('hifi.settings.deviceAuto') },
        ...listed.map(device => ({ value: device.name, label: deviceLabel(device) })),
    ];
    // Not read yet, or unplugged: the saved device still needs an entry so the list does not
    // look as if the default were in use.
    if (settings.audioDevice !== AUTO_DEVICE && !listed.some(device => device.name === settings.audioDevice)) {
        options.push({ value: settings.audioDevice, label: settings.audioDeviceLabel || settings.audioDevice });
    }

    const chooseDevice = (name: string) => {
        const device = listed.find(candidate => candidate.name === name);
        const label = name === AUTO_DEVICE ? '' : device?.description ?? (name === settings.audioDevice ? settings.audioDeviceLabel : '');
        settings.setAudioDevice(name, label);
    };

    const state = noMpv
        ? t('hifi.settings.devicesNeedMpv')
        : listState === 'loading'
            ? t('hifi.settings.devicesLoading')
            : listState === 'loaded' && listed.length === 0
                ? t('hifi.settings.devicesEmpty')
                : undefined;
    // On Linux, with nothing else to say, the hint points at the one choice that skips the sound server.
    const deviceHint = state ?? (IS_LINUX ? t('hifi.settings.deviceLinuxHint') : undefined);

    return (
        <Group def={OUTPUT}>
            <Row option={O.device} hint={deviceHint} note={IS_LINUX ? t('hifi.settings.deviceDirectNote') : undefined} disabled={!supported}>
                <Button icon={RefreshCw} tip={t('hifi.settings.devicesRefresh')} onClick={() => void refresh()} disabled={listState === 'loading' || noMpv} />
                <Select value={settings.audioDevice} options={options} onChange={chooseDevice} onOpen={ensureLoaded} />
            </Row>
            <Row
                option={O.exclusive}
                hint={t(IS_LINUX ? 'hifi.settings.exclusiveLinuxDesc' : 'hifi.settings.exclusiveDesc')}
                note={IS_LINUX ? t('hifi.settings.exclusiveLinuxNote') : undefined}
                disabled={!supported}
            >
                <Toggle checked={settings.exclusive} onChange={settings.setExclusive} />
            </Row>
        </Group>
    );
};

export default HifiOutputGroup;

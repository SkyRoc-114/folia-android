import React, { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import { hifiEngine, useHifiEngineStore } from '../../../../../services/hifi/hifiEngine';
import { useHifiSettingsStore } from '../../../../../stores/useHifiSettingsStore';
import type { HifiErrorCode, HifiInstallProgress } from '../../../../../types/hifi';
import { Button, CopyValue, Group, Progress, Reveal, Row, Status, Toggle, Value, useSettingsKitTheme } from '../../kit';
import { ENGINE, HIFI_PLATFORM, O } from './options';
import { canOfferRuntimeDownload, isRuntimeInstalling, runtimeLine } from './runtimeState';

// src/components/modal/settings/pages/hifi/HifiEngineGroup.tsx
// The engine group of the HiFi page: the switch (the first time it is turned on it asks to accept
// that the output is at full volume), which mpv is in use and where it came from, the download of
// the recommended mpv with its progress, the choice of an mpv file of one's own, and on Linux the
// package-manager lines in place of a download. The settings are pushed to the main process by the
// playback bridge, not from here.

const IS_LINUX = HIFI_PLATFORM === 'linux';

/** No mpv is downloaded on Linux; the distributions package one. Commands are not translated. */
const LINUX_INSTALL_COMMANDS = [
    { distro: 'Arch Linux', command: 'sudo pacman -S mpv' },
    { distro: 'Debian / Ubuntu', command: 'sudo apt install mpv' },
    { distro: 'Fedora', command: 'sudo dnf install mpv' },
] as const;

const MIB = 1024 * 1024;

/** How far the download has come, as the bar's fill and the words beside it. */
const installReading = (progress: HifiInstallProgress | null, t: TFunction): { value: number; text: string } => {
    if (progress?.phase === 'verifying') {
        return { value: 1, text: t('hifi.settings.installVerifying') };
    }
    if (progress?.phase === 'extracting') {
        return { value: 1, text: t('hifi.settings.installExtracting') };
    }
    if (progress?.phase === 'downloading' && progress.totalBytes > 0) {
        return {
            value: progress.receivedBytes / progress.totalBytes,
            text: t('hifi.settings.installBytes', {
                received: (progress.receivedBytes / MIB).toFixed(1),
                total: (progress.totalBytes / MIB).toFixed(1),
            }),
        };
    }
    return { value: 0, text: t('hifi.settings.installStarting') };
};

export const HifiEngineGroup: React.FC = () => {
    const { t } = useTranslation();
    const { isDaylight } = useSettingsKitTheme();
    const settings = useHifiSettingsStore(useShallow(state => ({
        enabled: state.enabled,
        setEnabled: state.setEnabled,
        mpvPath: state.mpvPath,
        setMpvPath: state.setMpvPath,
        volumeConfirmed: state.volumeConfirmed,
        setVolumeConfirmed: state.setVolumeConfirmed,
    })));
    const engine = useHifiEngineStore(useShallow(state => ({
        supported: state.supported,
        runtime: state.runtime,
        installProgress: state.installProgress,
    })));
    const [asking, setAsking] = useState(false);
    const [detecting, setDetecting] = useState(false);
    const [installPending, setInstallPending] = useState(false);
    const [installError, setInstallError] = useState<HifiErrorCode | null>(null);

    // The download's progress comes through the engine's subscriptions; attach is idempotent, and
    // the playback bridge has normally made it already.
    useEffect(() => {
        hifiEngine.attach();
        void hifiEngine.refreshRuntime();
    }, []);

    const { runtime, installProgress } = engine;
    const download = runtime?.download ?? null;
    // The palette's download and detect commands ask the same two questions (runtimeState.ts).
    const installing = installPending || isRuntimeInstalling(runtime, installProgress);
    const offerDownload = !installPending && canOfferRuntimeDownload(runtime, installProgress, HIFI_PLATFORM);
    const line = runtimeLine(runtime, (key, values) => t(key, values));
    const reading = installReading(installProgress, t);
    // A download started from the palette fails where this page did not start it: its last progress says why.
    const shownInstallError = installing
        ? null
        : installError ?? (installProgress?.phase === 'error' ? installProgress.errorCode ?? 'INSTALL_FAILED' : null);

    const runtimeHint = !runtime
        ? undefined
        : runtime.available
            ? runtime.path ?? undefined
            : IS_LINUX
                ? t('hifi.settings.linuxInstallHint')
                : download?.supported
                    ? t('hifi.settings.runtimeMissingDownloadHint')
                    : t('hifi.settings.runtimeMissingHint');

    const redetect = async () => {
        setDetecting(true);
        await hifiEngine.detect();
        setDetecting(false);
    };

    // Only the setting changes here: the playback bridge pushes it to the main process, and the
    // engine asks for the runtime again once the main process has the new path.
    const pickPath = async () => {
        const picked = await hifiEngine.pickRuntimePath();
        if (picked) {
            settings.setMpvPath(picked);
        }
    };

    const install = async () => {
        setInstallError(null);
        setInstallPending(true);
        const result = await hifiEngine.install();
        setInstallPending(false);
        const code = result ? (result.ok ? null : result.errorCode ?? 'INSTALL_FAILED') : 'INSTALL_FAILED';
        // A cancel is the listener's own doing; it needs no message.
        if (code && code !== 'INSTALL_CANCELLED') {
            setInstallError(code);
        }
    };

    const toggleEnabled = (next: boolean) => {
        if (next && !settings.volumeConfirmed) {
            setAsking(true);
            return;
        }
        settings.setEnabled(next);
    };

    return (
        <>
            <Group def={ENGINE}>
                <Row option={O.enabled} hint={t(engine.supported ? 'hifi.settings.enableDesc' : 'hifi.settings.unsupported')} disabled={!engine.supported}>
                    <Toggle checked={settings.enabled} onChange={toggleEnabled} />
                </Row>
                {engine.supported && (
                    <>
                        <Row option={O.runtime} hint={runtimeHint}>
                            <Status tone={line.tone}>{line.text}</Status>
                            {installing ? (
                                <>
                                    <Progress value={reading.value}>{reading.text}</Progress>
                                    <Button variant="quiet" onClick={() => void hifiEngine.cancelInstall()}>
                                        {t('hifi.settings.cancelInstall')}
                                    </Button>
                                </>
                            ) : offerDownload && (
                                <Button variant={runtime?.available ? undefined : 'primary'} icon={Download} onClick={() => void install()}>
                                    {t(download?.installedVersion ? 'hifi.settings.update' : 'hifi.settings.download', { version: download?.version ?? '' })}
                                </Button>
                            )}
                            <Button icon={RefreshCw} tip={t('hifi.settings.redetect')} onClick={() => void redetect()} disabled={detecting || installing} />
                        </Row>
                        <Reveal when={Boolean(runtime?.manualPathRejected)}>
                            <Row sub label={<Status tone="warn">{t('hifi.settings.manualPathRejected')}</Status>} />
                        </Reveal>
                        <Reveal when={shownInstallError !== null}>
                            <Row sub label={<Status tone="error">{shownInstallError ? t(`hifi.errors.${shownInstallError}`) : ''}</Status>} />
                        </Reveal>
                        <Reveal when={IS_LINUX && runtime !== null && !runtime.available}>
                            {LINUX_INSTALL_COMMANDS.map(({ distro, command }) => (
                                <Row key={distro} sub label={distro}>
                                    <CopyValue value={command} />
                                </Row>
                            ))}
                        </Reveal>
                        <Row option={O.mpvPath} hint={t('hifi.settings.mpvPathDesc')}>
                            {settings.mpvPath ? <CopyValue value={settings.mpvPath} /> : <Value>{t('hifi.settings.mpvPathAuto')}</Value>}
                            {settings.mpvPath && (
                                <Button variant="quiet" onClick={() => settings.setMpvPath(null)}>{t('hifi.settings.clearPath')}</Button>
                            )}
                            <Button onClick={() => void pickPath()}>{t('hifi.settings.pickPath')}</Button>
                        </Row>
                    </>
                )}
            </Group>

            <ConfirmDialog
                isOpen={asking}
                isDaylight={isDaylight}
                title={t('hifi.settings.confirmTitle')}
                description={t('hifi.settings.confirmDesc')}
                confirmText={t('hifi.settings.confirmAction')}
                onConfirm={() => {
                    settings.setVolumeConfirmed(true);
                    settings.setEnabled(true);
                    setAsking(false);
                }}
                onClose={() => setAsking(false)}
            />
        </>
    );
};

export default HifiEngineGroup;

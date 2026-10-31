import React, { useSyncExternalStore } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ConsoleLogPanel from '../../../shared/ConsoleLogPanel';
import {
    getDebugModuleSnapshot,
    openDebugLogsFolder,
    setDebugModuleState,
    subscribeToDebugModule,
    type DebugLogMode,
} from '../../../../services/debug/debugModule';
import {
    forgetAndroidLogFolder,
    getAndroidLogFileSnapshot,
    pickAndroidLogFolder,
    subscribeToAndroidLogFile,
    toggleAndroidLogFile,
} from '../../../../services/debug/androidLogFileSink';
import { isConsoleCaptureEnabled, setConsoleCaptureEnabled, subscribeToConsoleLog } from '../../../../utils/consoleLogBuffer';
import { IS_ANDROID_WEBVIEW } from '../../../../utils/platform';
import { Button, Group, Keys, Reveal, Row, Segmented, Toggle, option, useSettingsKitTheme, type SettingsGroupDef, type SettingsOptionDef } from '../kit';

// src/components/modal/settings/pages/DeveloperPage.tsx
// The 开发者 page: the debug module's switches. Two recordings, each with a switch for whether
// anything is kept at all and, under it, whether what is kept is also written to a file: the
// session log (with the log itself to read, filter and copy) and the memory monitor. The packaged
// desktop app has no console, so this page and the two shortcuts printed on it are the way in.
// The log viewer is the panel the Alt+Shift+D overlay also shows (shared/ConsoleLogPanel).

const TOOLS: SettingsGroupDef = { id: 'developerTools', titleKey: 'options.developerTools' };

// 手机壳专属的一组：桌面版把「写文件」交给 debug 模块的主进程文件，安卓没有主进程，
// 这里用 SAF 让用户选一个可访问的文件夹实时写入。搜索按 available 只在安卓壳里列出。
const ANDROID_LOG: SettingsGroupDef = { id: 'androidLogFile', titleKey: 'options.androidLogFileTitle' };

const O = {
    sessionLog: option(TOOLS, 'consoleLogCapture', 'options.consoleLogCapture'),
    logToFile: option(TOOLS, 'debugLogsToFile', 'options.debugLogsToFile'),
    memoryMonitor: option(TOOLS, 'memoryMonitor', 'options.memoryMonitor'),
    memoryInterval: option(TOOLS, 'memoryMonitorInterval', 'options.memoryMonitorInterval'),
    androidLogToFile: option(ANDROID_LOG, 'androidLogToFile', 'options.androidLogFileTitle', { available: () => IS_ANDROID_WEBVIEW }),
};

export const OPTIONS: SettingsOptionDef[] = Object.values(O);

const MEMORY_INTERVALS_MS = [1000, 2000, 5000, 15000];
const MEMORY_INTERVAL_CHOICES = MEMORY_INTERVALS_MS.map(interval => ({ value: String(interval), label: `${interval / 1000}s` }));

/** Where a recording is written: a path has no spaces, so it may break anywhere. */
const filePath = (path: string | null) => path && <span className="break-all">{path}</span>;

const DeveloperPage: React.FC = () => {
    const { t } = useTranslation();
    const { isDaylight } = useSettingsKitTheme();
    // Each is its own subscription: the switch has to answer for itself, also when the log's lines
    // did not change with it.
    const capturing = useSyncExternalStore(subscribeToConsoleLog, isConsoleCaptureEnabled);
    const debug = useSyncExternalStore(subscribeToDebugModule, getDebugModuleSnapshot);
    // Only live on the Android shell; everywhere else the snapshot is the idle default and the
    // group below is not rendered at all.
    const logFile = useSyncExternalStore(subscribeToAndroidLogFile, getAndroidLogFileSnapshot);

    const logFileStatus = logFile.permissionLost
        ? t('options.androidLogFilePermissionLost')
        : logFile.active
            ? `${logFile.fileName} · ${t('options.androidLogFileWriting')}`
            : t('options.androidLogFileIdle');
    const modeChoices: Array<{ value: DebugLogMode; label: string }> = [
        { value: 'append', label: t('options.debugLogModeAppend') },
        { value: 'overwrite', label: t('options.debugLogModeOverwrite') },
    ];

    return (
        <>
        <Group def={TOOLS} bare foot={t('options.consoleLogConvention')}>
            <Row option={O.sessionLog} hint={t('options.consoleLogCaptureDesc')}>
                <Keys keys={['Alt', 'Shift', 'D']} />
                <Toggle checked={capturing} onChange={setConsoleCaptureEnabled} />
            </Row>
            {/* With the session log off nothing is kept, so there is nothing to write or to read. */}
            <Reveal when={capturing}>
                <Row sub desktopOnly option={O.logToFile} hint={filePath(debug.runtimeFile ?? debug.logsRoot)}>
                    <Button icon={FolderOpen} tip={t('options.debugLogsOpenFolder')} onClick={() => void openDebugLogsFolder('runtime')} />
                    <Segmented
                        value={debug.runtimeLogMode}
                        options={modeChoices}
                        onChange={mode => void setDebugModuleState({ runtimeLogMode: mode })}
                        disabled={!debug.available || !debug.runtimeLogEnabled}
                    />
                    <Toggle checked={debug.runtimeLogEnabled} onChange={enabled => void setDebugModuleState({ runtimeLogEnabled: enabled })} />
                </Row>
                <Row below={<ConsoleLogPanel isDaylight={isDaylight} className="rounded-lg bg-[var(--st-pv)]" listMaxHeightClass="max-h-[22rem]" />} />
            </Reveal>

            <Row desktopOnly option={O.memoryMonitor} hint={t('options.memoryMonitorDesc')}>
                <Keys keys={['Alt', 'Shift', 'M']} />
                <Toggle checked={debug.memoryMonitorEnabled} onChange={enabled => void setDebugModuleState({ memoryMonitorEnabled: enabled })} />
            </Row>
            {/* No samples are taken with the monitor off, so no file is written and no interval runs. */}
            <Reveal when={debug.memoryMonitorEnabled}>
                {/* Named by `label`, not an option: the search already lists 写入本地文件 once, for the row above. */}
                <Row sub desktopOnly label={t('options.debugLogsToFile')} hint={filePath(debug.memoryFile ?? debug.logsRoot)}>
                    <Button icon={FolderOpen} tip={t('options.debugLogsOpenFolder')} onClick={() => void openDebugLogsFolder('memory')} />
                    <Segmented
                        value={debug.memoryLogMode}
                        options={modeChoices}
                        onChange={mode => void setDebugModuleState({ memoryLogMode: mode })}
                        disabled={!debug.available || !debug.memoryLogEnabled}
                    />
                    <Toggle checked={debug.memoryLogEnabled} onChange={enabled => void setDebugModuleState({ memoryLogEnabled: enabled })} />
                </Row>
                <Row sub desktopOnly option={O.memoryInterval}>
                    <Segmented
                        value={String(debug.memoryIntervalMs)}
                        options={MEMORY_INTERVAL_CHOICES}
                        onChange={interval => void setDebugModuleState({ memoryIntervalMs: Number(interval) })}
                        disabled={!debug.available}
                    />
                </Row>
            </Reveal>
        </Group>

        {/* 手机壳专属：与主卡同一套 Group/Row 控件，桌面上整组不渲染。桌面端记忆行
            （desktopOnly）在安卓上不画，所以这里的顺序就是安卓用户看到的顺序：
            会话日志卡下面跟着这张卡。授权失效、写失败都作为可见状态给出原因，
            而不是让开关悄悄失效。 */}
        {IS_ANDROID_WEBVIEW && (
            <Group def={ANDROID_LOG} foot={logFile.error || undefined}>
                <Row option={O.androidLogToFile} hint={t('options.androidLogFileDesc')}>
                    <Toggle checked={logFile.enabled} onChange={() => void toggleAndroidLogFile()} />
                </Row>
                <Reveal when={logFile.enabled || Boolean(logFile.folderName)}>
                    <Row
                        sub
                        label={logFile.folderName || t('options.androidLogFileNoFolder')}
                        hint={logFileStatus}
                    >
                        <Button icon={FolderOpen} tip={t('options.androidLogFilePick')} onClick={() => void pickAndroidLogFolder()} />
                        {logFile.folderName && (
                            <Button icon={Trash2} tip={t('options.androidLogFileForget')} onClick={() => void forgetAndroidLogFolder()} />
                        )}
                    </Row>
                </Reveal>
            </Group>
        )}
        </>
    );
};

export default DeveloperPage;

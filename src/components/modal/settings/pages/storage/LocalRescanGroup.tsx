import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalLibrarySettingsStore } from '../../../../../stores/useLocalLibrarySettingsStore';
import { Group, Row, Toggle } from '../../kit';
import { O, RESCAN } from './options';

// src/components/modal/settings/pages/storage/LocalRescanGroup.tsx
// #866：启动时整库重扫的开关。全平台渲染 —— Android 没有可持久化的目录句柄，
// FolderWatchGroup（FileSystemObserver 监听）在那边整组不画，这条是移动端唯一的
// 自动重扫入口；桌面上监听是实时的，这一扫兼作漏项兜底。默认关。

export const LocalRescanGroup: React.FC = () => {
    const { t } = useTranslation();
    const autoRescanOnStartup = useLocalLibrarySettingsStore(state => state.autoRescanOnStartup);
    const setAutoRescanOnStartup = useLocalLibrarySettingsStore(state => state.setAutoRescanOnStartup);

    return (
        <Group def={RESCAN}>
            <Row option={O.rescanStartup} note={t('options.localLibraryStartupRescanDesc')}>
                <Toggle checked={autoRescanOnStartup} onChange={setAutoRescanOnStartup} />
            </Row>
        </Group>
    );
};

export default LocalRescanGroup;

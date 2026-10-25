import React from 'react';
import { Route } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { QuickTile } from '../panelTab/controls/QuickTile';
import { openHifiSignalPath } from './hifiPanelStore';

// 音质页复用控制页的信号链路卡片样式；引擎和转码信息只在打开的弹窗中展示。

export const PlaybackSignalPathButton: React.FC = () => {
    const { t } = useTranslation();
    return (
        <div className="grid min-w-0 px-1 py-2">
            <QuickTile
                kind="open"
                lit={false}
                icon={<Route size={18} />}
                label={t('hifi.web.openSignalPath')}
                aria-haspopup="dialog"
                onClick={openHifiSignalPath}
            />
        </div>
    );
};

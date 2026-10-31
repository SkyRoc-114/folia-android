import { ONBOARDING_ILLUSTRATION, onboardingUsesTouchStoryboard } from './ponderOnboardingShared';
import type { PonderAnchorSource, PonderSceneScript, PonderStep, PonderTargetDefinition } from '../../../../types/ponder';

// src/components/ponder/targets/basics/helpPage.target.ts
// Folia 的总览。第一次打开应用时那道门指向它，思索导航页上按 Ctrl+G（触屏点右上角灯泡）也是它。
//
// 这里只放四个最短的入门章节：思索、命令面板、常用操作示例和官方文档。
// 媒体键、完整快捷键、桌面端等细节仍各自作为导航页上的独立目标。
//
// 触屏上没有悬停也没有键盘：讲思索和命令面板的两章各有一套触屏分镜（导出成
// TOUCH_SCENE_STEPS，让注册表测试把两套都拉去同一道防线），常用操作和文档两章
// 不涉及按键，两套共用。
// 选哪套在运行时定（onboardingUsesTouchStoryboard）：无键鼠的触屏演灯泡，键鼠接入
// （物理键盘或鼠标任一）后触屏机也能按到真键，下次进教程换回桌面那套。

const palette = {
    kind: 'synthetic',
    rect: { left: 0.5, top: 0.16, width: 0.52, height: 0.5, anchorX: 'center' },
    role: 'surface',
    surfaceKind: 'palette',
    labelKey: 'ponder.anchors.pages.commandPalette',
} satisfies PonderAnchorSource;

const commandPaletteAnchors = {
    palette,
    input: {
        kind: 'relative', from: 'palette',
        rect: { left: 0.04, right: 0.04, top: 0.03, height: 0.16 },
        role: 'region', labelKey: 'ponder.anchors.commandPalette.input',
    },
    results: {
        kind: 'relative', from: 'palette',
        rect: { left: 0.04, right: 0.04, top: 0.24, bottom: 0.04 },
        role: 'region', labelKey: 'ponder.anchors.commandPalette.results',
    },
} satisfies PonderSceneScript['anchors'];

const commandExampleAnchors = {
    volume: {
        kind: 'synthetic',
        rect: { left: 0.18, top: 0.23, width: 0.26, height: 0.24, anchorX: 'center' },
        role: 'surface', surfaceKind: 'volume', labelKey: 'ponder.anchors.playerBar.volumeSurface',
    },
    queueSearch: {
        kind: 'synthetic',
        rect: { left: 0.5, top: 0.17, width: 0.28, height: 0.38, anchorX: 'center' },
        role: 'surface', surfaceKind: 'queue-command', labelKey: 'ponder.anchors.queueCommand.panel',
    },
    playlistFilter: {
        kind: 'synthetic',
        rect: { left: 0.82, top: 0.17, width: 0.32, height: 0.38, anchorX: 'center' },
        role: 'surface', surfaceKind: 'grid-view-page', labelKey: 'ponder.anchors.pages.gridView',
    },
} satisfies PonderSceneScript['anchors'];

/**
 * 总览章的触屏分镜：灯泡就是整页入口，先亮出来讲它是什么，再点它进场。
 *
 * 桌面那套里的悬停提示和长按 G 在触屏上不存在，直接去掉，不硬凑等价物 ——
 * 硬凑出来的动作没人做得出。字幕节奏照桌面：每步单独一段，停留比默认长。
 * 结果层只能淡入、不能退回 base，所以 ponder-open 同样放在最后。
 */
const overviewTouchSteps: PonderStep[] = [
    { kind: 'highlight', id: 'markBulb', anchor: 'touchBulb', intensity: [0, 0.9], durationMs: 440, keyframe: true },
    {
        kind: 'caption', id: 'bulb',
        textKey: 'ponder.captions.onboarding.overviewCtrlGTouch',
        pointTo: { anchor: 'touchBulb' }, durationMs: 6400, withPrevious: true,
    },
    { kind: 'pause', id: 'readBulb', dwellMs: 2200 },

    { kind: 'highlight', id: 'dimBulb', anchor: 'touchBulb', intensity: [0.9, 0], durationMs: 400, keyframe: true },
    { kind: 'cursor', id: 'tapBulb', to: { anchor: 'touchBulb' }, press: 'tap', durationMs: 900, withPrevious: true },
    { kind: 'surfaceState', id: 'opened', anchor: 'page', state: 'ponder-open', transition: 'zoom', durationMs: 640 },
    {
        kind: 'caption', id: 'wholePage',
        textKey: 'ponder.captions.onboarding.overviewWholePage',
        pointTo: { anchor: 'page' }, durationMs: 6400, withPrevious: true,
    },
    { kind: 'pause', id: 'readWholePage', dwellMs: 2200 },

    {
        kind: 'caption', id: 'settings',
        textKey: 'ponder.captions.onboarding.overviewSettings',
        pointTo: { anchor: 'page' }, durationMs: 6000, keyframe: true,
    },
    { kind: 'pause', id: 'readSettings', dwellMs: 2200 },
];

const overviewDesktopSteps: PonderStep[] = [
    { kind: 'keypress', id: 'pressCtrlG', keys: ['Ctrl G'], at: { anchor: 'page', y: 1, offset: { y: 20 } }, durationMs: 1400, keyframe: true },
    { kind: 'highlight', id: 'markPage', anchor: 'page', intensity: [0, 0.35], durationMs: 520, withPrevious: true },
    {
        kind: 'caption', id: 'ctrlG',
        textKey: 'ponder.captions.onboarding.overviewCtrlG',
        pointTo: { anchor: 'page' }, durationMs: 6000, withPrevious: true,
    },
    { kind: 'pause', id: 'readCtrlG', dwellMs: 2200 },

    {
        kind: 'caption', id: 'wholePage',
        textKey: 'ponder.captions.onboarding.overviewWholePage',
        pointTo: { anchor: 'page' }, durationMs: 6400, keyframe: true,
    },
    { kind: 'pause', id: 'readWholePage', dwellMs: 2200 },

    { kind: 'highlight', id: 'dimPage', anchor: 'page', intensity: [0.35, 0], durationMs: 480, keyframe: true },
    { kind: 'cursor', id: 'hoverComponent', to: { anchor: 'component' }, durationMs: 1000, withPrevious: true },
    { kind: 'surfaceState', id: 'showHint', anchor: 'page', state: 'hint-shown', durationMs: 520 },
    {
        kind: 'caption', id: 'hover',
        textKey: 'ponder.captions.onboarding.overviewHover',
        pointTo: { anchor: 'capsule' }, durationMs: 6400, withPrevious: true,
    },
    { kind: 'pause', id: 'readHover', dwellMs: 2200 },

    { kind: 'keypress', id: 'holdG', keys: ['G'], at: { anchor: 'capsule', y: 1, offset: { y: 20 } }, durationMs: 1400, keyframe: true },
    { kind: 'surfaceState', id: 'holding', anchor: 'page', state: 'hint-holding', durationMs: 900, withPrevious: true },
    { kind: 'surfaceState', id: 'opened', anchor: 'page', state: 'ponder-open', transition: 'zoom', durationMs: 640 },
    {
        kind: 'caption', id: 'hold',
        textKey: 'ponder.captions.onboarding.overviewHold',
        pointTo: { anchor: 'page' }, durationMs: 6400, withPrevious: true,
    },
    { kind: 'pause', id: 'readHold', dwellMs: 2200 },

    {
        kind: 'caption', id: 'settings',
        textKey: 'ponder.captions.onboarding.overviewSettings',
        pointTo: { anchor: 'page' }, durationMs: 6000, keyframe: true,
    },
    { kind: 'pause', id: 'readSettings', dwellMs: 2200 },
];

/**
 * 第一章：两种思索入口，以及不需要时可以关闭。
 *
 * 先讲 Ctrl+G：它不依赖任何组件，在哪一页都能用，是最先该记住的那一下。
 * 然后才是悬停提示和长按 G。每一步单独一段字幕，停留比默认长，不把两件事塞进一句。
 * 触屏上改讲右上角灯泡，悬停与长按两段整个去掉。
 */
const ponderOverview: PonderSceneScript = {
    id: 'help-page-overview',
    titleKey: 'ponder.scenes.helpPageOverview',
    action: {
        kind: 'openSettings',
        anchorId: 'ponderHints',
        labelKey: 'ponder.actions.openPonderHints',
    },
    anchors: ONBOARDING_ILLUSTRATION,
    // 分镜运行时选（同 ponderBasics.insidePonder）：getter 在每次编译分镜时读。
    get steps() {
        return onboardingUsesTouchStoryboard() ? overviewTouchSteps : overviewDesktopSteps;
    },
};

/**
 * 第二章：命令面板是跨页面的主要操作入口。
 *
 * 触屏上不开按键演示：入口是左下角的命令面板按钮（面板手柄那颗，点一下或往左滑）。
 * 图里演的还是面板本身，字幕负责把入口说准。
 */
const commandPaletteTouchSteps: PonderStep[] = [
    { kind: 'highlight', id: 'markInput', anchor: 'input', intensity: [0, 0.75], durationMs: 420, keyframe: true },
    {
        kind: 'caption', id: 'palette',
        textKey: 'ponder.captions.onboarding.overviewCommandPaletteTouch',
        pointTo: { anchor: 'input' }, durationMs: 6800, withPrevious: true,
    },
    { kind: 'pause', id: 'readPalette' },
];

const commandPaletteDesktopSteps: PonderStep[] = [
    { kind: 'keypress', id: 'openPalette', keys: ['Mod K'], at: { anchor: 'palette', y: 0, offset: { y: -24 } }, durationMs: 1000, keyframe: true },
    { kind: 'highlight', id: 'markInput', anchor: 'input', intensity: [0, 0.75], durationMs: 420, withPrevious: true },
    {
        kind: 'caption', id: 'palette',
        textKey: 'ponder.captions.onboarding.overviewCommandPalette',
        pointTo: { anchor: 'input' }, durationMs: 6800, withPrevious: true,
    },
    { kind: 'pause', id: 'readPalette' },
];

const commandPalette: PonderSceneScript = {
    id: 'help-page-command-palette',
    titleKey: 'ponder.scenes.helpPageCommandPalette',
    anchors: commandPaletteAnchors,
    // 分镜运行时选（同 ponderOverview）。
    get steps() {
        return onboardingUsesTouchStoryboard() ? commandPaletteTouchSteps : commandPaletteDesktopSteps;
    },
};

/** 第三章：用音量、队列搜索和当前歌单二次检索说明命令面板的用法。 */
const commandExamples: PonderSceneScript = {
    id: 'help-page-command-examples',
    titleKey: 'ponder.scenes.helpPageCommandExamples',
    anchors: commandExampleAnchors,
    steps: [
        { kind: 'highlight', id: 'markVolume', anchor: 'volume', intensity: [0, 0.7], durationMs: 420, keyframe: true },
        {
            kind: 'caption', id: 'volume',
            textKey: 'ponder.captions.onboarding.overviewExampleVolume',
            pointTo: { anchor: 'volume' }, durationMs: 3600, withPrevious: true,
        },
        { kind: 'pause', id: 'readVolume' },

        { kind: 'highlight', id: 'dimVolume', anchor: 'volume', intensity: [0.7, 0], durationMs: 360, keyframe: true },
        { kind: 'highlight', id: 'markQueue', anchor: 'queueSearch', intensity: [0, 0.7], durationMs: 420, withPrevious: true },
        {
            kind: 'caption', id: 'queue',
            textKey: 'ponder.captions.onboarding.overviewExampleQueue',
            pointTo: { anchor: 'queueSearch' }, durationMs: 3600, withPrevious: true,
        },
        { kind: 'pause', id: 'readQueue' },

        { kind: 'highlight', id: 'dimQueue', anchor: 'queueSearch', intensity: [0.7, 0], durationMs: 360, keyframe: true },
        { kind: 'surfaceState', id: 'filterOpen', anchor: 'playlistFilter', state: 'filter-open', transition: 'slide-up', durationMs: 520, withPrevious: true },
        { kind: 'highlight', id: 'markFilter', anchor: 'playlistFilter', intensity: [0, 0.7], durationMs: 420, withPrevious: true },
        {
            kind: 'caption', id: 'filter',
            textKey: 'ponder.captions.onboarding.overviewExampleFilter',
            pointTo: { anchor: 'playlistFilter' }, durationMs: 4800, withPrevious: true,
        },
        { kind: 'pause', id: 'readFilter' },
    ],
};

/** 第四章：从底部动作直达官方文档。 */
const docs: PonderSceneScript = {
    id: 'help-page-docs',
    titleKey: 'ponder.scenes.helpPageDocs',
    action: {
        kind: 'openUrl',
        url: 'https://folia-site.cielaniska.top/guide/',
        labelKey: 'ponder.actions.openDocs',
    },
    anchors: ONBOARDING_ILLUSTRATION,
    steps: [
        { kind: 'highlight', id: 'showPage', anchor: 'page', intensity: [0, 0.35], durationMs: 520, keyframe: true },
        {
            kind: 'caption', id: 'docs',
            textKey: 'ponder.captions.onboarding.overviewDocs',
            pointTo: { anchor: 'page' }, durationMs: 5600, withPrevious: true,
        },
        { kind: 'pause', id: 'readDocs' },
    ],
};

export default {
    id: 'help-page',
    titleKey: 'ponder.targets.helpPage',
    category: 'basics',
    summaryKey: 'ponder.summaries.help_page',
    hoverSelector: null,
    scenes: [ponderOverview, commandPalette, commandExamples, docs],
} satisfies PonderTargetDefinition;

/**
 * 触屏分镜，按场景 id 对号。注册表只读 default export，测试从这里把两套分镜
 * 都拉去同一道防线（锚点引用、步骤 id、时间线编译）。
 */
export const TOUCH_SCENE_STEPS = {
    'help-page-overview': overviewTouchSteps,
    'help-page-command-palette': commandPaletteTouchSteps,
} satisfies Record<string, PonderStep[]>;

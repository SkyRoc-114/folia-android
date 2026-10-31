import { afterEach, describe, expect, it, vi } from 'vitest';
import { PONDER_TARGET_LIST, findPonderTarget } from '@/components/ponder/ponderRegistry';
import { compilePonderScene } from '@/utils/ponder/compilePonderTimeline';
import { SETTINGS_ANCHOR_DEFINITIONS } from '@/components/modal/settings/navigation/settingsAnchorModel';
import { VISUALIZER_SETTINGS_SECTIONS } from '@/stores/useSettingsModalStore';
import { PONDER_TARGET_CATEGORIES } from '@/types/ponder';
import type { PonderAnchorPoint, PonderStep, PonderSceneScript, PonderSurfaceKind } from '@/types/ponder';
import { TOUCH_SCENE_STEPS as HELP_PAGE_TOUCH_STEPS } from '@/components/ponder/targets/basics/helpPage.target';
import { TOUCH_SCENE_STEPS as PONDER_BASICS_TOUCH_STEPS } from '@/components/ponder/targets/basics/ponderBasics.target';
import { onboardingUsesTouchStoryboard } from '@/components/ponder/targets/basics/ponderOnboardingShared';
import { FINE_POINTER_QUERY } from '@/hooks/useSupportsFinePointer';
import { applyHidPayload } from '@/stores/useHidDevicesStore';

// test/unit/ponder/ponderRegistry.test.ts
// 场景脚本是纯声明数据，写错了不会有任何类型错误 —— 引用一个不存在的锚点只会让骨架
// 少画一个框、光标飞到左上角，而且要等到有人真的长按 G 才看得见。这组断言是唯一的防线。

/** 一个步骤引用到的所有锚点名。 */
const referencedAnchors = (step: PonderStep): string[] => {
    const fromPoint = (point: PonderAnchorPoint | 'bottom' | undefined): string[] =>
        point && point !== 'bottom' ? [point.anchor] : [];

    switch (step.kind) {
        case 'caption':
            return step.pointTo ? [step.pointTo.anchor] : [];
        case 'cursor':
            return [...fromPoint(step.to), ...fromPoint(step.from)];
        case 'drag':
            return [...fromPoint(step.from), ...fromPoint(step.to)];
        case 'keypress':
            return fromPoint(step.at);
        case 'highlight':
            return [step.anchor];
        case 'surfaceState':
            return [step.anchor];
        case 'reveal':
            return [step.anchor];
        default:
            return [];
    }
};

// 触屏分镜用到的结果层 → 实现它的 surface。桌面那张大表在下面单独的测试里；
// 触屏目前只切 ponder-open，新分镜用到别的 surface 时在这里补。
const TOUCH_SURFACE_STATES: Partial<Record<PonderSurfaceKind, Set<string>>> = {
    'ponder-onboarding': new Set(['ponder-open']),
};

describe('ponder registry', () => {
    it('至少注册了一个目标', () => {
        expect(PONDER_TARGET_LIST.length).toBeGreaterThan(0);
    });

    it('每个目标都能按 id 取回自己', () => {
        PONDER_TARGET_LIST.forEach(target => {
            expect(findPonderTarget(target.id)).toBe(target);
        });
    });

    it('每个目标至少有一个场景', () => {
        PONDER_TARGET_LIST.forEach(target => {
            expect(target.scenes.length, `${target.id} 没有场景`).toBeGreaterThan(0);
        });
    });

    it('场景 id 在同一目标内唯一', () => {
        PONDER_TARGET_LIST.forEach(target => {
            const ids = target.scenes.map(scene => scene.id);
            expect(new Set(ids).size, `${target.id} 场景 id 重复`).toBe(ids.length);
        });
    });

    it('步骤 id 在同一场景内唯一', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                const ids = scene.steps.map(step => step.id);
                expect(new Set(ids).size, `${target.id}/${scene.id} 步骤 id 重复`).toBe(ids.length);
            });
        });
    });

    it('每个步骤引用的锚点都在该场景的 anchors 里声明过', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                const declared = new Set(Object.keys(scene.anchors));
                scene.steps.forEach(step => {
                    referencedAnchors(step).forEach(anchor => {
                        expect(declared.has(anchor), `${target.id}/${scene.id}/${step.id} 引用了未声明的锚点 "${anchor}"`).toBe(true);
                    });
                });
            });
        });
    });

    it('derived 锚点的 from 都指向同场景内已声明的锚点', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                Object.entries(scene.anchors).forEach(([name, source]) => {
                    if (source.kind !== 'derived' && source.kind !== 'relative') return;
                    expect(
                        Object.keys(scene.anchors).includes(source.from),
                        `${target.id}/${scene.id} 的锚点 "${name}" 引用了未声明的 from "${source.from}"`,
                    ).toBe(true);
                });
            });
        });
    });

    it('每个场景都能编译出非零时长的时间线', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                const plan = compilePonderScene(scene);
                expect(plan.totalMs, `${target.id}/${scene.id} 时长为 0`).toBeGreaterThan(0);
                expect(plan.keyframes.length, `${target.id}/${scene.id} 没有关键帧`).toBeGreaterThan(0);
            });
        });
    });

    // 选择器能不能真的命中元素，要有 DOM 才测得了，那属于 test/component 下的 probe。
    // 这里只挡住空串和纯空白这种一定错的形状。
    it('hoverSelector 要么是 null，要么是非空选择器', () => {
        PONDER_TARGET_LIST.forEach(target => {
            if (target.hoverSelector === null) return;
            expect(typeof target.hoverSelector).toBe('string');
            expect(target.hoverSelector.trim(), `${target.id} 的 hoverSelector 是空串`).not.toBe('');
        });
    });

    it('surface 锚点都声明自己的界面形状', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                Object.entries(scene.anchors).forEach(([name, source]) => {
                    if (source.role !== 'surface') return;
                    expect(
                        source.surfaceKind,
                        `${target.id}/${scene.id} 的 surface 锚点 "${name}" 没有 surfaceKind`,
                    ).toBeDefined();
                });
            });
        });
    });

    it('每个目标都声明了导航页上的分类', () => {
        const missing = PONDER_TARGET_LIST
            .filter(target => !PONDER_TARGET_CATEGORIES.includes(target.category))
            .map(target => target.id);

        expect(missing, `这些目标不会出现在思索导航页上：${missing.join(', ')}`).toEqual([]);
    });

    it('「认识 Folia」的四项内容各自成章', () => {
        expect(findPonderTarget('help-page')?.scenes.map(scene => scene.id)).toEqual([
            'help-page-overview',
            'help-page-command-palette',
            'help-page-command-examples',
            'help-page-docs',
        ]);
    });

    it('页面教程覆盖完整页面区域，而不是只有一段泛化概述', () => {
        expect(findPonderTarget('grid-page')?.scenes.length).toBeGreaterThanOrEqual(6);
        expect(findPonderTarget('grid-view-page')?.scenes.length).toBeGreaterThanOrEqual(5);
        expect(findPonderTarget('local-grid-map-page')?.scenes.length).toBeGreaterThanOrEqual(3);
        expect(findPonderTarget('lattice-page')?.scenes.length).toBeGreaterThanOrEqual(5);
        expect(findPonderTarget('bravais-wall')?.scenes.length).toBeGreaterThanOrEqual(6);
    });

    it('surfaceState 引用的结果层都由对应 surface 实现', () => {
        const states: Partial<Record<PonderSurfaceKind, Set<string>>> = {
            'grid-page': new Set(['tab-switched', 'collection-open', 'map-open', 'search-open', 'command-open']),
            'grid-view-page': new Set(['card-focused', 'info-open', 'filter-open']),
            'lattice-page': new Set(['wall-panned', 'poster-focused', 'poster-expanded', 'tools-open', 'lights-off', 'command-open']),
            'player-bar': new Set(['title-hovered', 'slots-shuffle', 'slots-volume', 'collapsed']),
            'player-page': new Set(['palette-open', 'palette-closed', 'execute-mode', 'panel-open']),
            'side-panel': new Set(['cover-tab', 'source-tab', 'controls-tab', 'queue-tab', 'account-tab', 'controls-mode-list', 'fm-tab', 'source-tab-file-dialog']),
            'lattice-chrome': new Set(['slots-swapped', 'bottom-bar-shown']),
            'bravais-seam-strip': new Set(['spine', 'strip-again', 'strip-more', 'hidden', 'list-panel']),
            'bravais-seam-home': new Set(['home-local', 'account-open', 'base-again', 'menu-open', 'stage-on', 'filtering', 'search-open', 'tools-open']),
            'lyrics-animation-settings': new Set(['playground-open']),
            'theme-settings': new Set(['theme-park-open']),
            'grid-view-card-settings': new Set(['full-bleed-on']),
            'lattice-style-settings': new Set(['tint-on', 'custom-color-on']),
            'grid-action-button': new Set(['list-open', 'slide-target-open']),
            'grid-view-cards': new Set(['metadata-pencil', 'edit-mode']),
            'local-folder-actions': new Set(['delete-confirm']),
            'local-track-list': new Set(['sort-menu-open']),
            'local-grid-map': new Set(['tree-open']),
            'ponder-onboarding': new Set(['hint-shown', 'hint-holding', 'ponder-open']),
            'desktop-features': new Set(['wallpaper-on', 'tray-menu', 'remote-open']),
            'queue-command': new Set(['facet-suggestions', 'facet-narrowed', 'batch-preview']),
            'library-watch-settings': new Set(['watch-on']),
            'grid-hotkey-settings': new Set(['hotkey-on']),
            'custom-shortcut-settings': new Set(['key-refused', 'command-list']),
            'pinned-commands-settings': new Set(['palette-preview']),
            'replay-gain-settings': new Set(['panel-mirror']),
            'import-export-settings': new Set(['import-plan']),
            'audio-equalizer': new Set(['custom-written']),
            'vis-playground': new Set(['hotspots-visible', 'section-background', 'section-common', 'section-subtitle']),
            'theme-park': new Set(['save-blocked']),
            'lyric-export': new Set(['running']),
            'bravais-wall': new Set([
                'wall-panned', 'wall-scrolled', 'tab-out', 'tab-seam', 'tab-in-0', 'tab-in-1', 'tab-in-2', 'artist-color',
                'open-ring-0', 'open-ring-1', 'open-ring-2', 'open-ring-3', 'open-seam', 'back-seam', 'back-ring-0', 'back-ring-1', 'back-ring-2',
                'focus-expanded', 'focus-queued', 'focus-playing', 'tools-open', 'look-windows', 'look-clear', 'look-solid', 'lattice-handoff',
            ]),
            'sign-in': new Set(['window-open', 'window-account']),
            'lyric-match': new Set(['picked', 'local-file']),
            'lyric-style': new Set([
                'preview-style-b', 'preview-monet', 'preview-monet-bare', 'preview-background-b', 'preview-background-b-style-b', 'preview-romanization',
                'panel-style-b', 'panel-monet', 'panel-monet-off', 'panel-background', 'panel-subtitle',
            ]),
        };

        PONDER_TARGET_LIST.forEach(target => target.scenes.forEach(scene => {
            scene.steps.forEach(step => {
                if (step.kind !== 'surfaceState') return;
                const surfaceKind = scene.anchors[step.anchor]?.surfaceKind;
                expect(surfaceKind, `${target.id}/${scene.id}/${step.id} 没有指向 surface`).toBeDefined();
                expect(
                    surfaceKind && states[surfaceKind]?.has(step.state),
                    `${target.id}/${scene.id}/${step.id} 引用了未实现的结果层 "${step.state}"`,
                ).toBe(true);
            });
        }));
    });

    it('章节里的外链都是 https 绝对地址', () => {
        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                if (scene.action?.kind !== 'openUrl') return;
                expect(
                    scene.action.url.startsWith('https://'),
                    `${target.id}/${scene.id} 的外链不是 https 绝对地址：${scene.action.url}`,
                ).toBe(true);
            });
        });
    });

    // action.anchorId 在 DSL 里只是个 string（types 层不该反向依赖 settings 的锚点表），
    // 所以写错了只有在这里才发现得了 —— 运行时的表现是跳到设置面板的某个不存在的位置。
    it('章节里「直接去那儿」的锚点都真实存在', () => {
        const declared = new Set(Object.keys(SETTINGS_ANCHOR_DEFINITIONS));

        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                if (scene.action?.kind !== 'openSettings') return;
                expect(
                    declared.has(scene.action.anchorId),
                    `${target.id}/${scene.id} 指向了不存在的设置锚点 "${scene.action.anchorId}"`,
                ).toBe(true);
            });
        });
    });

    // 调参台那一种直达同理：section 只是 string，写错了会打开调参台却停在默认页。
    it('章节里去调参台的直达都指向真实存在的一页', () => {
        const sections = new Set<string>(VISUALIZER_SETTINGS_SECTIONS);

        PONDER_TARGET_LIST.forEach(target => {
            target.scenes.forEach(scene => {
                if (scene.action?.kind !== 'openVisualizerSettings') return;
                expect(
                    sections.has(scene.action.section),
                    `${target.id}/${scene.id} 指向了调参台不存在的一页 "${scene.action.section}"`,
                ).toBe(true);
            });
        });
    });

    // 触屏分镜与桌面分镜是两套数据，注册表启动时只会选中其中一套，上面的断言
    // 只覆盖被选中的那套（node 环境没有 window，选中桌面）。触屏那套从这里拉去
    // 同一道防线：锚点引用、步骤 id、结果层、时间线编译，外加「不演按键」这一条 ——
    // 触屏上没有键盘，分镜里出现 keypress 就是把桌面动作漏进了触屏。
    it('入门目标的触屏分镜与桌面分镜过同一道防线', () => {
        const variants = [
            { target: findPonderTarget('help-page'), touch: HELP_PAGE_TOUCH_STEPS },
            { target: findPonderTarget('ponder-basics'), touch: PONDER_BASICS_TOUCH_STEPS },
        ];

        variants.forEach(({ target, touch }) => {
            expect(target, '触屏分镜对号的目标不存在').toBeDefined();
            const definedTarget = target!;
            Object.entries(touch).forEach(([sceneId, steps]) => {
                const scene = definedTarget.scenes.find(candidate => candidate.id === sceneId);
                expect(scene, `${definedTarget.id}/${sceneId} 没有这个场景`).toBeDefined();
                const definedScene = scene!;

                const ids = steps.map(step => step.id);
                expect(new Set(ids).size, `${definedTarget.id}/${sceneId} 触屏步骤 id 重复`).toBe(ids.length);

                const declared = new Set(Object.keys(definedScene.anchors));
                steps.forEach(step => {
                    expect(step.kind, `${definedTarget.id}/${sceneId}/${step.id} 触屏分镜里还在演按键`).not.toBe('keypress');
                    referencedAnchors(step).forEach(anchor => {
                        expect(declared.has(anchor), `${definedTarget.id}/${sceneId}/${step.id} 引用了未声明的锚点 "${anchor}"`).toBe(true);
                    });
                    if (step.kind !== 'surfaceState') return;
                    const surfaceKind = definedScene.anchors[step.anchor]?.surfaceKind;
                    expect(surfaceKind, `${definedTarget.id}/${sceneId}/${step.id} 没有指向 surface`).toBeDefined();
                    expect(
                        surfaceKind && TOUCH_SURFACE_STATES[surfaceKind]?.has(step.state),
                        `${definedTarget.id}/${sceneId}/${step.id} 引用了未实现的结果层 "${step.state}"`,
                    ).toBe(true);
                });

                const plan = compilePonderScene({ ...definedScene, steps } satisfies PonderSceneScript);
                expect(plan.totalMs, `${definedTarget.id}/${sceneId} 触屏分镜时长为 0`).toBeGreaterThan(0);
                expect(plan.keyframes.length, `${definedTarget.id}/${sceneId} 触屏分镜没有关键帧`).toBeGreaterThan(0);
            });
        });
    });
});

// 分镜选哪套不再是模块求值时定格（.285 T5 的旧行为），而是每次编译分镜时运行时读
// onboardingUsesTouchStoryboard（matchMedia 细指针 + HID store）。注册表里的目标对象
// 始终是同一个，环境变了几下就要跟着变 —— 直接对着注册表断言。
describe('入门分镜按键鼠接入运行时切换', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        applyHidPayload({ keyboard: false, mouse: false });
    });

    it('node / 无 matchMedia 环境落回桌面分镜（T5 起的既有断言依赖这条）', () => {
        expect(onboardingUsesTouchStoryboard()).toBe(false);
        expect(
            findPonderTarget('help-page')!.scenes[0].steps.some(step => step.kind === 'keypress'),
            '无 window 时注册表里的场景应该编译桌面分镜',
        ).toBe(true);
    });

    it('细指针在 → 桌面分镜；粗指针无键鼠 → 触屏分镜', () => {
        vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: query === FINE_POINTER_QUERY, media: query }) });
        expect(onboardingUsesTouchStoryboard()).toBe(false);

        vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: false, media: query }) });
        expect(onboardingUsesTouchStoryboard()).toBe(true);
        expect(
            findPonderTarget('help-page')!.scenes[0].steps.some(step => step.kind === 'keypress'),
            '粗指针无键鼠时应该演触屏分镜（不演按键）',
        ).toBe(false);
    });

    it('键鼠接入后同一个目标对象换演桌面分镜，全拔出换回来（任一接入即开、全拔即关）', () => {
        vi.stubGlobal('window', { matchMedia: (query: string) => ({ matches: false, media: query }) });
        const target = findPonderTarget('help-page')!;
        const playsKeypress = () => target.scenes[0].steps.some(step => step.kind === 'keypress');

        applyHidPayload({ keyboard: true, mouse: false });
        expect(playsKeypress(), '只接键盘也应换桌面分镜').toBe(true);

        applyHidPayload({ keyboard: false, mouse: false });
        expect(playsKeypress(), '全拔出应回触屏分镜').toBe(false);

        applyHidPayload({ keyboard: false, mouse: true });
        expect(playsKeypress(), '只接鼠标也应换桌面分镜').toBe(true);
    });
});

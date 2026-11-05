// render-mobile-ui.mjs — folia-android 手机端 1:1 渲染脚本（终版，.298 批次）
// 360×640 @DPR3 = 1080×1920、hasTouch、locale zh-CN、phone-fit 显式开、首启门控全预置。
// 导航全部点击实证入口（探针 probe-dom/probe-palette/probe-player 校准）：
//  - 命令面板为导航中枢：⌘ 按钮 → role=combobox 输入英文关键词 → 点 [data-testid=command-palette-body] button
//  - 书脊页签 aria-label（zh）：歌单/电台/探索/专辑/本地/队列拼贴/搜索在线平台/连接在线平台…
//  - 播放页 panel-toggle → [data-ponder-panel-tab-button=…]
// 前置：npx vite build && (nohup npx vite preview --port 4173 &)
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = process.env.FOLIA_BASE || 'http://127.0.0.1:4173';
const OUT = '/home/z/my-project/download/mobile-ui-preview';
const VERSION = execSync('node -p "require(\'/home/z/my-project/folia-android/package.json\').version"').toString().trim();

const BOOT_KEYS = {
    folia_android_phone_fit: 'true',
    playback_entry_view_chosen: 'true',
    library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION,
    folia_last_seen_guide_version: VERSION,
};

mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[render]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const browser = await chromium.launch();
    const context = await browser.newContext({
        viewport: { width: 360, height: 640 },
        deviceScaleFactor: 3,
        hasTouch: true,
        isMobile: true,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
    });
    await context.addInitScript(({ keys }) => {
        for (const [k, v] of Object.entries(keys)) { try { localStorage.setItem(k, v); } catch {} }
        try {
            navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
            window.caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k)));
        } catch {}
    }, { keys: BOOT_KEYS });

    const page = await context.newPage();
    page.on('pageerror', (e) => log('PAGEERROR', String(e).slice(0, 160)));

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
    await sleep(3500);

    const env = await page.evaluate(() => ({
        innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
        coarse: matchMedia('(pointer: coarse)').matches,
        phoneFit: document.documentElement.getAttribute('data-folia-phone-fit'),
        lang: navigator.language,
    }));
    log('ENV', JSON.stringify(env));
    writeFileSync(`${OUT}/_env.json`, JSON.stringify(env, null, 2));

    const shot = async (name) => { await sleep(400); await page.screenshot({ path: `${OUT}/${name}.png` }); log('SHOT', name); };
    const tap = async (sel, label) => {
        try {
            const el = page.locator(sel).first();
            await el.waitFor({ state: 'visible', timeout: 5000 });
            await el.click({ force: true });
            log('TAP OK', label || sel);
            return true;
        } catch (e) { log('TAP MISS', label || sel); return false; }
    };
    // 命令面板导航：开 → 输入关键词 → 点含 rowText 的行（缺省第 0 行）
    const runCommand = async (kw, rowText) => {
        if (!(await tap('[data-folia-command-palette-button="true"]', `palette[${kw}]`))) return false;
        await page.waitForSelector('[data-testid="command-palette-panel"]', { timeout: 8000 }).catch(() => {});
        await sleep(500);
        const box = page.locator('[role="combobox"]').first();
        try { await box.fill(kw); } catch { log('FILL MISS', kw); return false; }
        await sleep(800);
        const rows = page.locator('[data-testid="command-palette-body"] button');
        const n = await rows.count();
        if (n === 0) { log('ROWS 0', kw); await page.keyboard.press('Escape'); return false; }
        let idx = 0;
        if (rowText) {
            idx = -1;
            for (let i = 0; i < n; i++) {
                const t = (await rows.nth(i).textContent()) || '';
                if (t.includes(rowText)) { idx = i; break; }
            }
            if (idx < 0) { log('ROW NOT FOUND', rowText, '| n=', n); await page.keyboard.press('Escape'); return false; }
        }
        await rows.nth(idx).click({ force: true });
        await sleep(1600);
        log('CMD OK', kw, rowText || '#0');
        return true;
    };
    const closeOverlays = async () => { for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {}); await sleep(600); };
    // 回 home（命令优先，书脊返回钮兜底）
    const goHome = async () => {
        if (await runCommand('home', '回到首页')) return true;
        if (await tap('button[aria-label="返回主页"]', 'spine-back-home')) return true;
        return false;
    };
    // 开播放页面板 + 切 tab
    const openPanel = async () => {
        if (await tap('[data-testid="panel-toggle"]', 'panel-toggle')) { await sleep(1400); return true; }
        return false;
    };
    const tapPanelTab = async (id) => tap(`[data-ponder-panel-tab-button="${id}"]`, `tab-${id}`);
    // 书脊按钮（aria-label 精确/前缀匹配）
    const tapAria = async (label) => tap(`[aria-label="${label}"]`, `aria[${label}]`);

    // ===== 屏序 =====
    // 01 首页墙（默认，竖排书脊空态）
    await shot('01-home-wall');

    // 02 首页-本地 tab（书脊页签）
    if (await tapAria('本地')) await sleep(1800);
    await shot('02-home-tab-local');

    // 03 lattice 队列墙（命令 navigate-lattice）
    if (await runCommand('lattice', 'Lattice 打开')) await sleep(1200);
    await shot('03-lattice-queue-wall');

    // 04 播放页（命令 navigate-player）
    if (await runCommand('player', '回到播放器')) await sleep(1200);
    await shot('04-player');

    // 05-08 播放页面板 4 tab
    if (await openPanel()) {
        await tapPanelTab('cover'); await sleep(1300);
        await shot('05-panel-cover');
        await tapPanelTab('queue'); await sleep(1300);
        await shot('06-panel-queue');
        await tapPanelTab('controls'); await sleep(1300);
        await shot('07-panel-controls');
        // 均衡器（controls tab 内格子；空态可能不可用）
        if (await tap('[data-ponder="audio-equalizer"]', 'equalizer')) await sleep(1500);
        await shot('08-equalizer');
        await page.keyboard.press('Escape').catch(() => {}); // 只关均衡器 Sheet，面板保留
        await sleep(800);
        await tapPanelTab('account'); await sleep(1300);
        await shot('09-panel-account');
        await closeOverlays();
    } else {
        log('PANEL never opened — 截当前态占位');
        await shot('05-panel-cover');
    }

    // 10 设置（命令 options；360 宽 phone-fit 窄窗 = 落地页根列表，传统移动端形态）
    if (await runCommand('options', '打开选项')) await sleep(1500);
    const onLanding = await page.evaluate(() => Boolean(document.querySelector('[data-folia-settings-landing]')));
    log('SETTINGS_LANDING', onLanding);
    await shot(onLanding ? '10-settings-landing' : '10-settings-options');
    // 11 设置-子页：落地页点第一组类目进页（页头应有返回箭头）；桌面形态沿用当前页。
    if (onLanding) {
        const entered = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('[data-folia-settings-landing] nav button'));
            const target = btns.find((b) => b.textContent && !b.textContent.includes('帮助'));
            if (target) { target.click(); return (target.textContent || '').trim(); }
            return null;
        });
        log('SETTINGS_ENTERED', entered);
        await sleep(1500);
    }
    // 设置内 anchor（dump 后点有者，第 2 个起）
    const anchors = await page.evaluate(() => Array.from(document.querySelectorAll('[data-settings-anchor]')).map((el) => ({
        id: el.getAttribute('data-settings-anchor'),
        y: Math.round(el.getBoundingClientRect().y),
    })).filter((a) => a.y > 0));
    log('SETTINGS_ANCHORS', JSON.stringify(anchors.slice(0, 8)));
    if (anchors.length > 1) {
        await page.evaluate((id) => { const el = document.querySelector(`[data-settings-anchor="${id}"]`); el?.scrollIntoView({ block: 'start' }); }, anchors[1].id);
        await sleep(900);
    }
    await shot('11-settings-section');

    // 12 搜索（命令 search-current）
    await closeOverlays();
    await goHome(); await sleep(800);
    if (await runCommand('search', '搜索歌曲')) await sleep(2500);
    await shot('12-search-workspace');

    // 13 命令面板根视图（⌘ 按钮）
    await closeOverlays();
    if (await tap('[data-folia-command-palette-button="true"]', 'palette-root')) await sleep(1400);
    await shot('13-command-palette');
    await closeOverlays();

    // 14 登录窗（home 书脊「连接在线平台」）
    await goHome(); await sleep(800);
    const loginTap = await tap('button[aria-label*="连接在线平台"]', 'spine-login');
    if (!loginTap) await tapAria('登录');
    await sleep(2000);
    await shot('14-login-window');
    await closeOverlays();

    await browser.close();
    log('DONE');
}

main().catch((e) => { console.error('[render] FATAL', e); process.exit(1); });

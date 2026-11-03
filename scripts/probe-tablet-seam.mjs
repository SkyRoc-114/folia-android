// probe-tablet-seam.mjs — 平板双栏探针（fork 增量批次）
// 触屏平板（coarse + 宽≥720 + 高≥720）上 auto 方向应解析为竖缝：缝把墙分成左右两部分
// （M3 expanded 双栏）。对照：同几何非触屏（mouse）走上游语义（landscape→竖缝、portrait→横条）。
// 前置：npx vite build && (nohup npx vite preview --port 4173 &)
import { chromium } from 'playwright';

const BASE = process.env.FOLIA_BASE || 'http://127.0.0.1:4173';
const VERSION = '0.0.0';
const log = (...a) => console.log('[tablet]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOT_KEYS = {
    folia_android_phone_fit: 'false', // 平板：phone-fit 关（短边 ≥ 720 本就不默认开）
    playback_entry_view_chosen: 'true',
    library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION,
    folia_last_seen_guide_version: VERSION,
};

async function probeCase(browser, label, { width, height, hasTouch }) {
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        hasTouch,
        isMobile: hasTouch,
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
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
    await sleep(3500);
    const info = await page.evaluate(() => {
        const seam = document.querySelector('.bravais-seam');
        if (!seam) return { seam: null };
        const r = seam.getBoundingClientRect();
        const styles = getComputedStyle(seam);
        const row = seam.querySelector('.bravais-seam-home-row');
        const content = seam.querySelector('.bravais-seam-content');
        return {
            seam: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x + r.width / 2) },
            flexDirection: styles.flexDirection,
            phoneFit: document.documentElement.getAttribute('data-folia-phone-fit'),
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            coarse: matchMedia('(pointer: coarse)').matches,
            hasRow: Boolean(row),
            hasContent: Boolean(content),
        };
    });
    log(label, JSON.stringify(info));
    await context.close();
    return info;
}

async function main() {
    const browser = await chromium.launch();
    // 触屏平板竖屏 800×1280：auto → 竖缝（双栏）
    const tabletPortrait = await probeCase(browser, 'TABLET-TOUCH-PORTRAIT(800x1280)', { width: 800, height: 1280, hasTouch: true });
    // 触屏平板横屏 1280×800：auto → 竖缝（双栏，与上游 landscape 语义一致）
    const tabletLandscape = await probeCase(browser, 'TABLET-TOUCH-LANDSCAPE(1280x800)', { width: 1280, height: 800, hasTouch: true });
    // 非触屏同几何（桌面窗口）：上游原语义
    const desktopPortrait = await probeCase(browser, 'DESKTOP-MOUSE-PORTRAIT(800x1280)', { width: 800, height: 1280, hasTouch: false });
    // 手机几何对照 360×640 触屏：phone-fit + 横条（上游语义）
    const phone = await probeCase(browser, 'PHONE-TOUCH(360x640)', { width: 360, height: 640, hasTouch: true });

    // 断言
    const assert = (name, ok, detail) => log(`ASSERT ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' | ' + detail : ''}`);
    if (tabletPortrait.seam) {
        const vertical = tabletPortrait.seam.h > tabletPortrait.seam.w;
        assert('tablet-portrait seam vertical (two panes)', vertical, JSON.stringify(tabletPortrait.seam));
    } else assert('tablet-portrait seam present', false);
    if (tabletLandscape.seam) {
        const vertical = tabletLandscape.seam.h > tabletLandscape.seam.w;
        assert('tablet-landscape seam vertical (two panes)', vertical, JSON.stringify(tabletLandscape.seam));
    } else assert('tablet-landscape seam present', false);
    if (desktopPortrait.seam) {
        const horizontal = desktopPortrait.seam.w >= desktopPortrait.seam.h;
        assert('desktop portrait keeps upstream horizontal bar', horizontal, JSON.stringify(desktopPortrait.seam));
    } else assert('desktop portrait seam present', false);
    if (phone.seam) {
        const horizontal = phone.seam.w >= phone.seam.h;
        assert('phone keeps upstream horizontal strip', horizontal, JSON.stringify(phone.seam));
    } else assert('phone seam present', false);
    await browser.close();
}

main().catch((e) => { console.error('[tablet] FATAL', e); process.exit(1); });

// render-extra.mjs — 补两屏：02 home 本地 tab（重试）、15 首页搜索覆盖层
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const VERSION = execSync('node -p "require(\'/home/z/my-project/folia-android/package.json\').version"').toString().trim();
const KEYS = {
    folia_android_phone_fit: 'true',
    playback_entry_view_chosen: 'true',
    library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION,
    folia_last_seen_guide_version: VERSION,
};
const log = (...a) => console.log('[extra]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(({ keys }) => {
    for (const [k, v] of Object.entries(keys)) { try { localStorage.setItem(k, v); } catch {} }
    try {
        navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
        window.caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k)));
    } catch {}
}, { keys: KEYS });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
await sleep(3500);

// ---- 02 本地 tab：多路兜底 ----
const candidates = [
    () => page.locator('[aria-label="本地"]').first(),
    () => page.getByRole('tab', { name: '本地' }).first(),
    () => page.locator('button', { hasText: /^本地$/ }).first(),
    () => page.locator('[data-folia-grid-tabs="true"] button', { hasText: '本地' }).first(),
];
let done = false;
for (let i = 0; i < candidates.length && !done; i++) {
    try {
        const el = candidates[i]();
        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.click({ force: true });
        done = true;
        log('LOCAL TAB OK via candidate', i);
    } catch (e) { log('LOCAL TAB MISS via', i, String(e).split('\n')[0].slice(0, 100)); }
}
await sleep(2000);
await page.screenshot({ path: '/home/z/my-project/download/mobile-ui-preview/02-home-tab-local.png' });
log('SHOT 02-home-tab-local');

// 回首页首 tab（歌单）再进搜索覆盖层
try { await page.locator('[aria-label="歌单"]').first().click({ force: true, timeout: 3000 }); } catch {}
await sleep(1200);

// ---- 15 首页搜索覆盖层：书脊「搜索在线平台」→ 输入回车 ----
const searchCandidates = [
    () => page.locator('[aria-label="搜索在线平台"]').first(),
    () => page.locator('[data-folia-home-header="true"] form input').first(),
    () => page.locator('[data-folia-home-header="true"] input').first(),
];
let sdone = false;
for (let i = 0; i < searchCandidates.length && !sdone; i++) {
    try {
        const el = searchCandidates[i]();
        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.click({ force: true });
        sdone = true;
        log('SEARCH ENTRY OK via candidate', i);
    } catch (e) { log('SEARCH ENTRY MISS via', i); }
}
await sleep(800);
try {
    await page.keyboard.type('周杰伦', { delay: 80 });
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(3000);
    log('SEARCH typed+enter');
} catch (e) { log('SEARCH type fail', String(e).split('\n')[0].slice(0, 100)); }
await page.screenshot({ path: '/home/z/my-project/download/mobile-ui-preview/15-search-overlay.png' });
log('SHOT 15-search-overlay');

await browser.close();
log('DONE');

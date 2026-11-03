// render-offline-search.mjs — 16 离线搜索空态（.300 批次新增）
// 断网（context.setOffline）后从首页书脊「搜索在线平台」提交一次在线搜索：
// store 的离线预检直接给出 searchError='offline' 哨兵 → 工作区显示 WifiOff + 「未连接网络」，
// 而不是转圈后报「搜索失败」。断言页面上出现离线文案，缺失即退出码 1。
// 前置：npx vite build && (nohup npx vite preview --port 4173 &)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
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
const log = (...a) => console.log('[offline]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// 断网：Chromium 侧 navigator.onLine 同步翻 false，请求全部失败
await context.setOffline(true);
const onLine = await page.evaluate(() => navigator.onLine);
log('navigator.onLine =', onLine);
if (onLine !== false) { log('FATAL: offline emulation did not flip navigator.onLine'); process.exit(1); }

// 首页书脊「搜索在线平台」→ 输入 → 回车提交（搜索覆盖层 form submit → onSubmitSearch）
const searchCandidates = [
    () => page.locator('[aria-label="搜索在线平台"]').first(),
    () => page.locator('[data-folia-home-header="true"] form input').first(),
    () => page.locator('[data-folia-home-header="true"] input').first(),
];
let entered = false;
for (let i = 0; i < searchCandidates.length && !entered; i++) {
    try {
        const el = searchCandidates[i]();
        await el.waitFor({ state: 'visible', timeout: 3000 });
        await el.click({ force: true });
        entered = true;
        log('SEARCH ENTRY OK via candidate', i);
    } catch (e) { log('SEARCH ENTRY MISS via', i); }
}
if (!entered) { log('FATAL: no search entry found'); process.exit(1); }
await sleep(800);
await page.keyboard.type('周杰伦', { delay: 80 });
await sleep(600);
await page.keyboard.press('Enter');
await sleep(2500);

// 断言：工作区打开且显示离线文案（WifiOff 图标的 svg 也在）
const check = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
        offlineText: text.includes('未连接网络'),
        failedText: text.includes('搜索失败'),
        wifiOff: Boolean(document.querySelector('.lucide-wifi-off')),
        alert: Boolean(document.querySelector('.lucide-alert-circle')),
    };
});
log('ASSERT', JSON.stringify(check));
if (!check.offlineText || !check.wifiOff) { log('FATAL: offline state not rendered'); process.exit(1); }
if (check.failedText) { log('FATAL: stale "search failed" text still shown while offline'); process.exit(1); }

await page.screenshot({ path: `${OUT}/16-offline-search.png` });
log('SHOT 16-offline-search');

await browser.close();
log('DONE');

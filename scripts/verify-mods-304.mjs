// verify-mods-304.mjs — .304 模组设置页验证（mock Capacitor → Android WebView 形态）
// 断言：①设置落地页类目含「模组」②模组子页出现总开关/客户端模组区/性能优化开关/三挡
import { chromium } from 'playwright';

const BASE = process.env.FOLIA_BASE || 'http://127.0.0.1:4173';
const execSync = (await import('node:child_process')).execSync;
const VERSION = execSync('node -p "require(\'/home/z/my-project/folia-android/package.json\').version"').toString().trim();
const log = (...a) => console.log('[verify]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOOT_KEYS = {
    folia_android_phone_fit: 'true',
    playback_entry_view_chosen: 'true',
    library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION,
    folia_last_seen_guide_version: VERSION,
};

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(({ keys }) => {
    for (const [k, v] of Object.entries(keys)) { try { localStorage.setItem(k, v); } catch {} }
    // mock Capacitor Android WebView（isAndroidNativeRuntime 探测 getPlatform）
    window.Capacitor = { getPlatform: () => 'android' };
    try {
        navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister()));
        window.caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k)));
    } catch {}
}, { keys: BOOT_KEYS });

const page = await context.newPage();
page.on('pageerror', (e) => log('PAGEERROR', String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
await sleep(3500);

// 开设置（命令面板路径）
const openSettings = async () => {
    const btn = page.locator('[data-folia-command-palette-button="true"]').first();
    await btn.waitFor({ state: 'visible', timeout: 8000 });
    await btn.click({ force: true });
    await sleep(600);
    const box = page.locator('[role="combobox"]').first();
    await box.fill('settings');
    await sleep(900);
    const rows = page.locator('[data-testid="command-palette-body"] button');
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
        const t = (await rows.nth(i).textContent()) || '';
        if (t.includes('设置')) { await rows.nth(i).click({ force: true }); log('开设置 via 行:', t.trim().slice(0, 30)); return true; }
    }
    log('未找到设置行（rows=' + n + '）');
    return false;
};
await openSettings();
await sleep(1800);

// ① 落地页类目含「模组」
const landing = await page.evaluate(() => {
    const el = document.querySelector('[data-folia-settings-landing]');
    if (!el) return { landing: false };
    const cats = Array.from(el.querySelectorAll('nav button, button')).map((b) => (b.textContent || '').trim()).filter(Boolean);
    return { landing: true, cats: cats.slice(0, 20) };
});
log('LANDING', JSON.stringify(landing));
const hasModsCat = landing.cats?.some((c) => c.includes('模组')) ?? false;
log('ASSERT 类目含模组 =', hasModsCat);

// ② 进模组子页
if (hasModsCat) {
    const entered = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('[data-folia-settings-landing] nav button, [data-folia-settings-landing] button'));
        const target = btns.find((b) => (b.textContent || '').includes('模组'));
        if (target) { target.click(); return (target.textContent || '').trim(); }
        return null;
    });
    log('进入模组子页:', entered);
    await sleep(2000);
    const read = () => page.evaluate(() => {
        const txt = document.body.innerText || '';
        return {
            totalSwitch: txt.includes('模组系统'),
            systemOff: txt.includes('模组系统未开启'),
            managerOrAndroid: txt.includes('模组管理') || txt.includes('Android 客户端模组'),
            androidEmpty: txt.includes('还没有安装模组'),
            perfSwitch: txt.includes('模组性能优化'),
            levelRow: txt.includes('优化强度'),
            light: txt.includes('轻度'),
            medium: txt.includes('均衡'),
            strong: txt.includes('强力'),
        };
    });
    const s0 = await read();
    log('STEP0 默认态', JSON.stringify(s0));
    // 点开开关：button[role=switch] 序号定位（0=模组系统总开关，1=模组性能优化）
    const toggleOn = async (idx) => {
        try {
            const sw = page.locator('button[role="switch"]').nth(idx);
            await sw.waitFor({ state: 'visible', timeout: 5000 });
            await sw.click({ force: true });
            await sleep(1200);
            return true;
        } catch (e) { log('TOGGLE MISS', String(e).slice(0, 80)); return false; }
    };
    const t1 = await toggleOn(0);
    const s1 = await read();
    log('STEP1 总开关开启', JSON.stringify(s1));
    const t2 = await toggleOn(1);
    const s2 = await read();
    log('STEP2 性能优化开启', JSON.stringify(s2));
    await page.screenshot({ path: '/tmp/mods-304-verify.png', fullPage: true });
    log('SHOT /tmp/mods-304-verify.png');
    const pass = s2.totalSwitch && s2.managerOrAndroid && s2.perfSwitch && s2.levelRow && s2.light && s2.medium && s2.strong;
    log('TOGGLES', JSON.stringify({ total: t1, perf: t2 }));
    log('FINAL', pass ? 'PASS' : 'FAIL');
} else {
    log('FINAL FAIL（无模组类目）');
}
await browser.close();

// probe-seam-expanded.mjs — 展开窄缝后量工具格按钮对齐（验证窄缝是否同样右偏）
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const VERSION = execSync('node -p "require(\'/home/z/my-project/folia-android/package.json\').version"').toString().trim();
const KEYS = {
    folia_android_phone_fit: 'true', playback_entry_view_chosen: 'true', library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION, folia_last_seen_guide_version: VERSION,
};
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
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
await sleep(3500);

const measure = () => page.evaluate(() => {
    const seam = document.querySelector('[data-bravais-home-seam]');
    const dock = seam?.querySelector('.bravais-seam-dock');
    const out = { seam: null, dock: null, buttons: [] };
    if (seam) { const r = seam.getBoundingClientRect(); out.seam = { x: +r.x.toFixed(2), w: +r.width.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2) }; }
    if (dock) { const r = dock.getBoundingClientRect(); out.dock = { x: +r.x.toFixed(2), w: +r.width.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2) }; }
    for (const el of seam?.querySelectorAll('.bravais-seam-dock button, .bravais-seam-account button, .bravais-seam-dock .bravais-seam-tools') || []) {
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        out.buttons.push({
            tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().split(' ').slice(0, 2).join('.'),
            label: el.getAttribute('aria-label') || '',
            x: +r.x.toFixed(2), w: +r.width.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2),
        });
    }
    return out;
});

const before = await measure();
console.log('[spine] seam=', JSON.stringify(before.seam), 'dock=', JSON.stringify(before.dock));
for (const b of before.buttons) console.log(`  ${b.tag}.${b.cls} ${b.label.slice(0, 14)} x=${b.x} w=${b.w} cx=${b.cx}`);

// 点展开（书脊底部 maximize）→ 窄缝
const expandBtn = page.locator('[data-bravais-seam-action="expand"]');
try {
    await expandBtn.click({ timeout: 4000 });
    await sleep(2000);
    const after = await measure();
    console.log('[expanded] seam=', JSON.stringify(after.seam), 'dock=', JSON.stringify(after.dock));
    for (const b of after.buttons) console.log(`  ${b.tag}.${b.cls} ${b.label.slice(0, 14)} x=${b.x} w=${b.w} cx=${b.cx}`);
    await page.screenshot({ path: '/tmp/probe-seam-expanded.png' });
} catch (e) { console.log('EXPAND FAIL', String(e).slice(0, 120)); }

await browser.close();
console.log('DONE');

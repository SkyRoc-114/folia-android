// probe-dom.mjs — dump 当前 DOM 里所有稳定属性元素，校准渲染脚本选择器
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

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(({ keys }) => {
    for (const [k, v] of Object.entries(keys)) { try { localStorage.setItem(k, v); } catch {} }
}, { keys: KEYS });
const page = await context.newPage();
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-folia-app-shell="true"]', { timeout: 30000 });
await page.waitForTimeout(3500);

const dump = await page.evaluate(() => {
    const out = { testid: {}, ponder: {}, foliaAttrs: {}, buttons: [] };
    document.querySelectorAll('[data-testid]').forEach((el) => {
        const k = el.getAttribute('data-testid');
        const r = el.getBoundingClientRect();
        out.testid[k] = `${el.tagName.toLowerCase()} visible=${r.width}x${r.height}@${Math.round(r.x)},${Math.round(r.y)}`;
    });
    document.querySelectorAll('[data-ponder]').forEach((el) => {
        const k = el.getAttribute('data-ponder');
        const r = el.getBoundingClientRect();
        out.ponder[k] = `${el.tagName.toLowerCase()} visible=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`;
    });
    document.querySelectorAll('*').forEach((el) => {
        for (const a of el.attributes) {
            if (a.name.startsWith('data-folia-') && a.name !== 'data-folia-app-shell') {
                const r = el.getBoundingClientRect();
                out.foliaAttrs[`${a.name}=${a.value}`] = `${el.tagName.toLowerCase()} visible=${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`;
            }
        }
    });
    // 命令面板按钮与面板开关的候选（含 aria-label）
    document.querySelectorAll('button').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            const al = el.getAttribute('aria-label') || '';
            const ti = el.getAttribute('title') || '';
            const dt = el.getAttribute('data-testid') || el.getAttribute('data-ponder') || el.getAttribute('data-folia-command-palette-button') || '';
            if (al || ti || dt) out.buttons.push(`${dt || al || ti} :: ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)} :: ${(el.textContent || '').trim().slice(0, 14)}`);
        }
    });
    out.buttons = out.buttons.slice(0, 50);
    return out;
});
console.log(JSON.stringify(dump, null, 1));
await browser.close();

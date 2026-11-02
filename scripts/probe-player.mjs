// probe-player.mjs — 进播放页后：panel-toggle/tab 按钮是否在、'panel' 关键词行、登录按钮
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
await page.waitForTimeout(3000);

const openPalette = async () => {
    await page.locator('[data-folia-command-palette-button="true"]').click({ force: true });
    await page.waitForSelector('[data-testid="command-palette-panel"]', { timeout: 8000 });
    await page.waitForTimeout(600);
};
const runCommand = async (kw, rowText) => {
    await openPalette();
    const box = page.locator('[role="combobox"]').first();
    await box.fill(kw);
    await page.waitForTimeout(800);
    const rows = page.locator('[data-testid="command-palette-match-row"]');
    const n = await rows.count();
    if (n === 0) { console.log('RUN MISS no rows for', kw); await page.keyboard.press('Escape'); return false; }
    let idx = 0;
    if (rowText) {
        idx = -1;
        for (let i = 0; i < n; i++) {
            const t = (await rows.nth(i).textContent()) || '';
            if (t.includes(rowText)) { idx = i; break; }
        }
        if (idx < 0) { console.log('RUN MISS row not found:', rowText, '| rows:', n); await page.keyboard.press('Escape'); return false; }
    }
    await rows.nth(idx).click({ force: true });
    await page.waitForTimeout(1500);
    console.log('RUN OK', kw, rowText || '#0');
    return true;
};

await runCommand('player', '回到播放器');
const dump1 = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`; };
    return {
        panelToggle: rect('[data-testid="panel-toggle"]'),
        tabButtons: document.querySelectorAll('[data-ponder-panel-tab-button]').length,
        unifiedPanel: rect('[data-testid="unified-panel-surface"]'),
        playerBar: rect('[data-ponder="player-bar"]'),
        view: document.querySelector('[data-ponder-page-scope]')?.getAttribute('data-ponder-page-scope') || 'none',
        audioEq: rect('[data-ponder="audio-equalizer"]'),
    };
});
console.log('PLAYER_VIEW', JSON.stringify(dump1));

// 开面板（toggle 或 'panel' 命令）
if (dump1.panelToggle) {
    await page.locator('[data-testid="panel-toggle"]').click({ force: true });
    await page.waitForTimeout(1200);
    console.log('PANEL opened via toggle');
} else {
    const ok = await runCommand('panel', null);
    console.log('PANEL via command:', ok);
}
const dump2 = await page.evaluate(() => ({
    tabButtons: Array.from(document.querySelectorAll('[data-ponder-panel-tab-button]')).map((el) => ({
        id: el.getAttribute('data-ponder-panel-tab-button'),
        r: (() => { const b = el.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.x)},${Math.round(b.y)}`; })(),
        disabled: el.disabled,
    })),
    unifiedPanel: !!document.querySelector('[data-testid="unified-panel-surface"]'),
}));
console.log('PANEL_TABS', JSON.stringify(dump2));

// 登录按钮（书脊）
const dump3 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (el.getAttribute('aria-label') || '').includes('连接在线平台');
    });
    return btns.map((el) => { const r = el.getBoundingClientRect(); return `${el.getAttribute('aria-label')} ${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`; });
});
console.log('LOGIN_BTNS', JSON.stringify(dump3));

await browser.close();

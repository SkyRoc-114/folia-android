// probe-palette.mjs — 探命令面板：开面板→逐关键词→dump 匹配行（文本+属性）
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

await page.locator('[data-folia-command-palette-button="true"]').click({ force: true });
await page.waitForTimeout(1200);
const panelInfo = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-testid="command-palette-panel"]'),
    input: !!document.querySelector('[data-testid="command-palette-filter"]'),
    rows: document.querySelectorAll('[data-testid="command-palette-match-row"]').length,
    rowAttrs: (() => {
        const el = document.querySelector('[data-testid="command-palette-match-row"]');
        return el ? Array.from(el.attributes).map((a) => `${a.name}=${a.value}`).join(' | ') : 'none';
    })(),
}));
console.log('PANEL_OPEN', JSON.stringify(panelInfo));

const keywords = ['lattice', 'player', 'cover', 'queue', 'account', 'local', 'navi', 'lyrics', 'options', 'equalizer', 'add to playlist', 'search'];
const input = page.locator('[data-testid="command-palette-panel"] [role="combobox"], [role="combobox"]').first();
for (const kw of keywords) {
    await input.fill('');
    await page.waitForTimeout(250);
    await input.fill(kw);
    await page.waitForTimeout(700);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="command-palette-match-row"]')).slice(0, 3).map((el) => ({
        text: (el.textContent || '').trim().slice(0, 40),
        attrs: Array.from(el.attributes).filter((a) => a.name.startsWith('data-')).map((a) => `${a.name}=${a.value}`).join(','),
    })));
    console.log(`KW[${kw}]`, JSON.stringify(rows));
}
await browser.close();

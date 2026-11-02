// probe-spine-geometry.mjs — 书脊对齐精确测量
// 量：条带容器 bbox、各子块 bbox、每个按钮 bbox 及其内容（svg/文字）bbox → 判断哪一组右偏、偏多少、谁在条带里不居中
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const VERSION = execSync('node -p "require(\'/home/z/my-project/folia-android/package.json\').version"').toString().trim();
const KEYS = {
    folia_android_phone_fit: 'true',
    playback_entry_view_chosen: 'true',
    library_suite_prompt_seen: 'true',
    folia_last_seen_ponder_onboarding_version: VERSION,
    folia_last_seen_guide_version: VERSION,
};
const log = (...a) => console.log('[geo]', ...a);
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

const geo = await page.evaluate(() => {
    const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2) };
    };
    const seam = document.querySelector('[data-bravais-home-seam]');
    const out = { seam: seam ? box(seam) : null, blocks: {}, buttons: [], tabTexts: [], styles: {} };
    if (!seam) return out;

    // 条带的样式信息
    const cs = getComputedStyle(seam);
    out.styles.seam = {
        width: cs.width, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
        marginLeft: cs.marginLeft, marginRight: cs.marginRight,
        alignItems: cs.alignItems, flexDirection: cs.flexDirection,
        left: cs.left, position: cs.position,
    };

    // 直接子块
    for (const child of seam.children) {
        const c = child;
        const key = c.className && typeof c.className === 'string' ? c.className.split(' ').slice(0, 2).join('.') : c.tagName;
        const b = box(c);
        // 块内首个按钮/内容的内容盒
        const btn = c.querySelector('button, [role="tab"]');
        out.blocks[key] = { ...b, firstBtn: btn ? box(btn) : null };
    }

    // 全部按钮 + 内容 bbox
    for (const el of seam.querySelectorAll('button, [role="tab"]')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        let content = null;
        const svg = el.querySelector('svg');
        const label = el.querySelector('.is-label');
        const inner = svg || label || el.firstChild;
        if (inner && inner.getBoundingClientRect) {
            const ir = inner.getBoundingClientRect();
            content = { cx: +(ir.x + ir.width / 2).toFixed(2), w: +ir.width.toFixed(2) };
        }
        out.buttons.push({
            label: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 12),
            cls: (el.className || '').toString().split(' ').slice(0, 2).join('.'),
            btn: { x: +r.x.toFixed(2), cx: +(r.x + r.width / 2).toFixed(2), w: +r.width.toFixed(2) },
            content,
        });
    }

    // 页签竖排文字的精确 bbox（button 的 range）
    for (const el of seam.querySelectorAll('[data-bravais-tab]')) {
        const r = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const tr = range.getBoundingClientRect();
        out.tabTexts.push({
            tab: el.getAttribute('data-bravais-tab'),
            btnCx: +(r.x + r.width / 2).toFixed(2), btnW: +r.width.toFixed(2),
            textCx: +(tr.x + tr.width / 2).toFixed(2), textW: +tr.width.toFixed(2),
            textX: +tr.x.toFixed(2),
        });
    }
    return out;
});

writeFileSync('/tmp/spine-geo.json', JSON.stringify(geo, null, 1));
log('SEAM', JSON.stringify(geo.seam));
log('SEAM_STYLES', JSON.stringify(geo.styles.seam || {}));
log('---BLOCKS---');
for (const [k, b] of Object.entries(geo.blocks || {})) {
    log(`${k} x=${b.x} cx=${b.cx} w=${b.w} firstBtnCx=${b.firstBtn ? b.firstBtn.cx : '-'}`);
}
log('---BUTTONS---');
for (const b of geo.buttons || []) {
    log(`${b.label} | ${b.cls} | btnCx=${b.btn.cx} btnX=${b.btn.x} w=${b.btn.w} | contentCx=${b.content ? b.content.cx : '-'} contentW=${b.content ? b.content.w : '-'}`);
}
log('---TAB TEXTS---');
for (const t of geo.tabTexts || []) {
    log(`${t.tab} | btnCx=${t.btnCx} w=${t.btnW} | textCx=${t.textCx} textX=${t.textX} textW=${t.textW} | 偏移=${(t.textCx - t.btnCx).toFixed(2)}`);
}
await browser.close();
log('DONE');

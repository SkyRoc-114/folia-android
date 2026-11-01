#!/usr/bin/env node
/**
 * sync-vi-to-en.cjs — 让 vi.ts 的键结构逐行对应 en.ts（i18n 不变式）。
 *
 * 用法：
 *   node scripts/sync-vi-to-en.cjs           # 校验 + 自动修复（en 增键 → vi 原文补位）
 *   node scripts/sync-vi-to-en.cjs --check   # 只校验，不一致则退出码 1
 *
 * 规则（与上游 #544 后的维护方式一致）：
 *   - 子树键序一致 → 原样复制 vi 字节（保格式，注释、空行、行宽都不动）
 *   - en 有 vi 无的键 → 把 en 的原始行插进 vi 对应位置（英文占位，待人工翻译）
 *   - vi 有 en 无的键 → 报错列出（en.ts 是结构基准，孤儿键必须人工处理）
 *
 * tokenizer 顺序（踩过的坑，勿改）：
 *   1. RE_ARY  数组项行 —— 必须先于宽松的 RE_LEAF_LAST 尝试
 *   2. RE_OPEN 开行（"key": { 或 "key": [）
 *   3. RE_CLOSE闭行 —— 容忍 `} as const;`、`},`、`]`、`],` 等尾部
 *   4. RE_LEAF 叶子行（"key": "value",）
 *   5. RE_LEAF_LAST 最后一个叶子（无尾逗号）—— 最宽松，放最后
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 两种安放位置都支持：<repo>/scripts/（入库版）与 /home/z/my-project/scripts/（沙箱外部版）
const _UP = path.resolve(__dirname, '..');
const REPO = fs.existsSync(path.join(_UP, 'src', 'i18n', 'locales'))
    ? _UP
    : path.resolve(_UP, 'folia-android');
const EN = path.join(REPO, 'src', 'i18n', 'locales', 'en.ts');
const VI = path.join(REPO, 'src', 'i18n', 'locales', 'vi.ts');

const CHECK_ONLY = process.argv.includes('--check');

// ---------- tokenizer ----------

const RE_ARY = /^\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/;                     // "数组项字符串",
const RE_OPEN = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*([{\[])\s*$/;         // "key": {  /  "key": [
const RE_CLOSE = /^\s*[}\]]\s*,?\s*(?:as\s+const\s*)?;?\s*$/;        // },  ]  } as const;
const RE_LEAF_PREFIX = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*/;             // "key": 前缀（叶子判定）

/**
 * 把 locale 文件解析成节点序列 + 树。
 * 节点带 [startLine, endLine]（0 基、含端点），覆盖该子树从开行到闭行的原始字节。
 * 数组项的 key 用 #序号，这样数组条数差异也能对齐到具体位置。
 */
function parseLocale(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const nodes = [];
    const stack = []; // { type: '{'|'['|'root', keyPath: [...] , nodeIdx }
    let arrayCounters = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '' || line.trim().startsWith('//')) continue;

        const top = stack[stack.length - 1];
        const inArray = top && top.type === '[';

        if (inArray) {
            if (RE_CLOSE.test(line)) {
                const frame = stack.pop();
                nodes[frame.nodeIdx].endLine = i;
                arrayCounters.pop();
                continue;
            }
            const idx = arrayCounters[arrayCounters.length - 1]++;
            nodes.push({ kind: 'ary', key: `#${idx}`, lineNo: i, endLine: i,
                depth: stack.length, path: [...top.keyPath, `#${idx}`] });
            continue;
        }

        if (RE_CLOSE.test(line)) {
            const frame = stack.pop();
            if (frame && frame.nodeIdx !== undefined) nodes[frame.nodeIdx].endLine = i;
            continue;
        }

        const open = line.match(RE_OPEN);
        if (open) {
            const keyPath = top ? [...top.keyPath, open[1]] : [open[1]];
            const node = { kind: open[2] === '[' ? 'arr' : 'obj', key: open[1], lineNo: i,
                endLine: -1, depth: stack.length, path: keyPath };
            nodes.push(node);
            stack.push({ type: open[2], keyPath, nodeIdx: nodes.length - 1 });
            if (open[2] === '[') arrayCounters.push(0);
            continue;
        }

        const leaf = line.match(RE_LEAF_PREFIX);
        if (leaf) {
            const keyPath = top ? [...top.keyPath, leaf[1]] : [leaf[1]];
            nodes.push({ kind: 'leaf', key: leaf[1], lineNo: i, endLine: i,
                depth: stack.length, path: keyPath });
            continue;
        }

        if (/^\s*export\s+default\s*{\s*$/.test(line)) {
            nodes.push({ kind: 'obj', key: '<root>', lineNo: i, endLine: -1, depth: -1, path: [] });
            stack.push({ type: '{', keyPath: [], nodeIdx: nodes.length - 1 });
            continue;
        }

        throw new Error(`${path.basename(file)}:${i + 1} 无法识别的行: ${line.trim().slice(0, 80)}`);
    }

    if (stack.length !== 0) {
        throw new Error(`${path.basename(file)} 括号未闭合（剩 ${stack.length} 层，最内层路径: ${stack[stack.length - 1].keyPath.join(' > ') || '<root>'}）`);
    }
    return { lines, nodes, root: nodes[0] };
}

// ---------- 树构建与对齐 ----------

function buildTree(parseResult) {
    const root = { ...parseResult.root, children: [] };
    const stack = [{ node: root, type: '{' }];
    for (let i = 1; i < parseResult.nodes.length; i++) {
        const n = parseResult.nodes[i];
        const made = { ...n, children: [] };
        // depth 是解析时的栈深（根的直接子节点为 1）。弹栈条件：
        // 当前节点深度 <= 栈顶节点深度 → 栈顶已闭合，弹出（可连弹多层）。
        // 根节点 depth=-1 永远不会被弹（1 <= -1 不成立），stack.length>1 只是保险。
        while (stack.length > 1 && n.depth <= stack[stack.length - 1].node.depth) stack.pop();
        stack[stack.length - 1].node.children.push(made);
        if (n.kind === 'obj' || n.kind === 'arr') {
            stack.push({ node: made, type: n.kind === 'arr' ? '[' : '{' });
        }
    }
    return root;
}

const sig = (node) => `${node.kind}:${node.key}`;

/** 两棵子树键结构是否完全一致（只看骨架，不看值）。 */
function sameSkeleton(a, b) {
    if (!a || !b) return false;
    if (sig(a) !== sig(b)) return false;
    if (a.children.length !== b.children.length) return false;
    for (let i = 0; i < a.children.length; i++) {
        if (!sameSkeleton(a.children[i], b.children[i])) return false;
    }
    return true;
}

function collectKeys(node, out = []) {
    if (node.kind === 'leaf' || node.kind === 'ary') out.push(node.path.join('.'));
    node.children.forEach(c => collectKeys(c, out));
    return out;
}

// ---------- 输出（en 为基准，vi 补位） ----------

const out = [];
let copiedSubtrees = 0, insertedFromEn = 0;
const insertedKeys = [];

function emit(enNode, viNode) {
    // 子树骨架完全一致 → 整段复制 vi 原始字节（含注释空行）
    if (viNode && sameSkeleton(enNode, viNode)) {
        const src = VI_PARSED.lines;
        const start = viNode.lineNo, end = viNode.endLine;
        for (let i = start; i <= end; i++) out.push(src[i]);
        copiedSubtrees++;
        return;
    }

    // vi 缺整棵子树 → en 原文占位
    if (!viNode) {
        const src = EN_PARSED.lines;
        for (let i = enNode.lineNo; i <= enNode.endLine; i++) out.push(src[i]);
        insertedFromEn++;
        insertedKeys.push(enNode.path.join('.') || '<root>');
        return;
    }

    // 都有但子树有差异 → 逐子节点对齐
    // 开行用 vi 的（保留 vi 的行尾风格），根开行也用 vi 的
    out.push(VI_PARSED.lines[viNode.lineNo]);
    if (enNode.kind === 'obj' || enNode.kind === 'arr') {
        const viChildren = new Map(viNode.children.map(c => [sig(c), c]));
        enNode.children.forEach(enChild => {
            const viChild = viChildren.get(sig(enChild)) || null;
            emit(enChild, viChild);
        });
        // vi 有而 en 没有的孤儿键：报错（不静默丢弃）
        const enSigs = new Set(enNode.children.map(sig));
        viNode.children.filter(c => !enSigs.has(sig(c))).forEach(c => {
            orphans.push(c.path.join('.'));
        });
        out.push(VI_PARSED.lines[viNode.endLine]);
    } else {
        // 叶子/数组项不该走到这（sig 相同已在 sameSkeleton 处理）
        out.push(VI_PARSED.lines[viNode.lineNo]);
    }
}

// ---------- main ----------

const EN_PARSED = parseLocale(EN);
const VI_PARSED = parseLocale(VI);
const enRoot = buildTree(EN_PARSED);
const viRoot = buildTree(VI_PARSED);

const orphans = [];
emit(enRoot, viRoot);

if (orphans.length) {
    console.error(`✗ vi.ts 有 ${orphans.length} 个 en.ts 不存在的键（孤儿键），需人工处理：`);
    orphans.forEach(k => console.error(`    - ${k}`));
    process.exit(1);
}

const enKeys = collectKeys(enRoot).length;
const viKeysIn = collectKeys(viRoot).length;

if (insertedFromEn === 0 && copiedSubtrees > 0) {
    console.log(`✓ vi.ts 与 en.ts 键结构一致（en ${enKeys} 键 / vi ${viKeysIn} 键，子树全部逐行对应）`);
    if (CHECK_ONLY) process.exit(0);
    process.exit(0);
}

if (CHECK_ONLY) {
    console.error(`✗ vi.ts 与 en.ts 结构不一致：en 有 ${insertedFromEn} 处 vi 缺失（约 ${insertedKeys.length} 键）。请重跑 node scripts/sync-vi-to-en.cjs 修复。`);
    insertedKeys.slice(0, 20).forEach(k => console.error(`    - 缺 ${k}`));
    process.exit(1);
}

// 写回（保留 vi 头部注释行：root 开行之前的所有行）
const viHeaderEnd = VI_PARSED.root.lineNo; // export default { 所在行
const header = VI_PARSED.lines.slice(0, viHeaderEnd);
fs.writeFileSync(VI, [...header, ...out, ''].join('\n'), 'utf8');
console.log(`✓ vi.ts 已对齐 en.ts：插入 ${insertedFromEn} 棵缺失子树（${insertedKeys.length} 键），复用 ${copiedSubtrees} 棵一致子树`);
insertedKeys.slice(0, 30).forEach(k => console.log(`    + ${k}`));
if (insertedKeys.length > 30) console.log(`    … 其余 ${insertedKeys.length - 30} 个`);
console.log('⚠ 英文占位需要人工翻译成越南语（grep 插入的键即可找到）');

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PROGRESS.json 更新器 —— cron 巡检进度变量化（2026-11-04 用户指令落地）。

进度不写在 cron 载荷（常量会过期），单独存仓库根 PROGRESS.json（随分支 push 持久，
沙箱回退后 clone 即得）。每轮收尾用本脚本实时更新并提交：
    git add PROGRESS.json && git commit -m "chore(progress): 轮次更新" && git push

用法：
  python3 scripts/update-progress.py show
      打印当前 PROGRESS.json（摘要 + 全文）
  python3 scripts/update-progress.py set <dot.path> <value>
      设单值，value 先按 JSON 解析、失败则当纯字符串。例：
        set fork.latest_tag v0.7.22-android.302
        set fork.next_batch_number 303
        set render_set.screens 17
  python3 scripts/update-progress.py set-json <dot.path> '<json>'
      设复杂结构（数组/对象），例：
        set-json pending '[{"id":"x","desc":"..."}]'
  python3 scripts/update-progress.py round --type inspection|batch|infra --result "<一句话>"
      记录本轮到 last_round（时间戳用本地 +08:00），并刷新顶层 updated_at/updated_by_round
  python3 scripts/update-progress.py history <tag> <sha> "<summary>"
      追加（tag 去重）到 batch_history_tail，保留最近 8 条
  python3 scripts/update-progress.py pending-add <id> <desc> / pending-done <id>
      维护 pending 列表（done 即移除）

安全点：读改写全程保留未知字段；写回前校验 JSON 可解析；--check 只验不改。
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "PROGRESS.json"
HISTORY_KEEP = 8


def load():
    with FILE.open("r", encoding="utf-8") as f:
        return json.load(f)


def save(data):
    FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    json.loads(FILE.read_text(encoding="utf-8"))  # 写后复验


def get_path(data, dotted):
    cur = data
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise SystemExit(f"path 不存在: {dotted}（缺 {part}）")
        cur = cur[part]
    return cur


def set_path(data, dotted, value):
    parts = dotted.split(".")
    cur = data
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = value


def parse_value(raw):
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return raw


def now_cn():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def round_id():
    return "manual-" + datetime.now().strftime("%Y%m%d-%H%M%S")


def detect_round_id():
    """尽力从环境 trace 里取轮次标识，取不到用时间戳。"""
    import os

    for key in ("FOLIA_ROUND_ID",):
        if os.environ.get(key):
            return os.environ[key]
    return round_id()


def git_head_sha():
    try:
        return (
            subprocess.check_output(
                ["git", "rev-parse", "--short=8", "HEAD"], cwd=str(ROOT)
            )
            .decode()
            .strip()
        )
    except Exception:
        return "unknown"


def cmd_show(_):
    data = load()
    f = data.get("fork", {})
    print("== PROGRESS.json 摘要 ==")
    print("latest_tag :", f.get("latest_tag"), f.get("latest_tag_sha"))
    print("next_batch :", f.get("next_batch_number"))
    print("updated_at :", data.get("updated_at"), "by", data.get("updated_by_round"))
    lr = data.get("last_round", {})
    print("last_round :", lr.get("type"), "-", lr.get("result", "")[:80])
    print("pending    :", [p.get("id") for p in data.get("pending", [])] or "无")
    print("history    :", ", ".join(b.get("tag", "?") for b in data.get("batch_history_tail", [])))
    print()
    print(FILE.read_text(encoding="utf-8"))


def cmd_set(args):
    data = load()
    set_path(data, args.path, parse_value(args.value))
    data["updated_at"] = now_cn()
    save(data)
    print(f"OK {args.path} = {get_path(data, args.path)!r}")


def cmd_round(args):
    data = load()
    data["last_round"] = {
        "at": now_cn(),
        "type": args.type,
        "result": args.result,
    }
    data["updated_at"] = data["last_round"]["at"]
    data["updated_by_round"] = args.round_id or detect_round_id()
    save(data)
    print(f"OK last_round[{args.type}] 已记录")


def cmd_history(args):
    data = load()
    tail = data.setdefault("batch_history_tail", [])
    tail[:] = [b for b in tail if b.get("tag") != args.tag]
    tail.append({"tag": args.tag, "sha": args.sha, "summary": args.summary})
    del tail[:-HISTORY_KEEP]
    data["updated_at"] = now_cn()
    save(data)
    print(f"OK history += {args.tag}（保留最近 {HISTORY_KEEP} 条）")


def cmd_pending_add(args):
    data = load()
    pend = data.setdefault("pending", [])
    pend[:] = [p for p in pend if p.get("id") != args.id]
    pend.append({"id": args.id, "desc": args.desc, "status": "pending"})
    data["updated_at"] = now_cn()
    save(data)
    print(f"OK pending += {args.id}")


def cmd_pending_done(args):
    data = load()
    pend = data.setdefault("pending", [])
    before = len(pend)
    pend[:] = [p for p in pend if p.get("id") != args.id]
    data["updated_at"] = now_cn()
    save(data)
    print(f"OK pending 移除 {args.id}（{before}→{len(pend)}）")


def cmd_check(_):
    data = load()
    print("JSON 合法；fork.latest_tag =", data.get("fork", {}).get("latest_tag"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("show").set_defaults(fn=cmd_show)
    sub.add_parser("check").set_defaults(fn=cmd_check)

    p = sub.add_parser("set")
    p.add_argument("path")
    p.add_argument("value")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("set-json")
    p.add_argument("path")
    p.add_argument("value")
    p.set_defaults(fn=cmd_set)

    p = sub.add_parser("round")
    p.add_argument("--type", choices=["inspection", "batch", "infra"], required=True)
    p.add_argument("--result", required=True)
    p.add_argument("--round-id", default=None)
    p.set_defaults(fn=cmd_round)

    p = sub.add_parser("history")
    p.add_argument("tag")
    p.add_argument("sha")
    p.add_argument("summary")
    p.set_defaults(fn=cmd_history)

    p = sub.add_parser("pending-add")
    p.add_argument("id")
    p.add_argument("desc")
    p.set_defaults(fn=cmd_pending_add)

    p = sub.add_parser("pending-done")
    p.add_argument("id")
    p.set_defaults(fn=cmd_pending_done)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()

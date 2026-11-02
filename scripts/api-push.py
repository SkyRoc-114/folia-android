#!/usr/bin/env python3
# api-push.py — github.com git 协议不通时，走 REST Git Data API 推送本地提交到远端分支
# 用法：python3 api-push.py <local_commit_sha>   （把该提交相对远端 tip 的变更推上去）
import base64
import json
import sys
import urllib.request

REPO = "SkyRoc-114/folia-android"
BRANCH = "android-0.7.22"
REPO_DIR = "/home/z/my-project/folia-android"
CREDS = "/home/z/my-project/.gh-credentials"


import re


def token():
    with open(CREDS) as f:
        for line in f:
            m = re.search(r"https://[^:]*:([^@]+)@github\.com", line)
            if m:
                return m.group(1)
    raise SystemExit("no token")


T = token()
API = f"https://api.github.com/repos/{REPO}"


def req(method, path, payload=None, raw=False):
    data = json.dumps(payload).encode() if payload is not None else None
    cmd = [
        "curl", "-s", "--max-time", "40", "-X", method,
        "-H", f"Authorization: token {T}",
        "-H", "Accept: application/vnd.github+json",
        "-H", "Content-Type: application/json",
        "-H", "User-Agent: folia-relay",
    ]
    if data is not None:
        cmd += ["-d", data.decode()]
    cmd.append(f"{API}{path}")
    import subprocess
    import time
    for attempt in range(3):
        try:
            p = subprocess.run(cmd, capture_output=True, timeout=45)
            if p.returncode == 0 and p.stdout.strip():
                return json.loads(p.stdout)
            print(f"  retry {attempt+1} {method} {path}: rc={p.returncode} {p.stderr.decode()[:120]}")
        except Exception as e:
            print(f"  retry {attempt+1} {method} {path}: {e}")
        time.sleep(10)
    raise SystemExit(f"API FAIL {method} {path}")


def main():
    local_tip = sys.argv[1]
    # diff 基线：可选 argv[2]（须为本地存在的 commit；异构推送时用远端历史里本地也有的祖先）
    diff_base_arg = sys.argv[2] if len(sys.argv) > 2 else None
    # 1. 远端 tip
    ref = req("GET", f"/git/ref/heads/{BRANCH}")
    base_sha = ref["object"]["sha"]
    base_commit = req("GET", f"/git/commits/{base_sha}")
    base_tree = base_commit["tree"]["sha"]
    print(f"remote tip {base_sha[:7]} tree {base_tree[:7]}")
    if base_sha == local_tip:
        print("ALREADY UP TO DATE")
        return
    # 2. 变更文件清单（diff_base 本地可解析即可，文件内容以 local_tip 工作树为准）
    import subprocess
    diff_base = diff_base_arg or base_sha
    files = subprocess.run(["git", "diff", "--name-only", diff_base, local_tip],
                           capture_output=True, text=True, cwd=REPO_DIR).stdout.split()
    if not files:
        raise SystemExit("no diff between diff_base and local tip — 需要先 fetch 对账")
    print("files:", files)
    # 3. 上传 blobs
    tree_items = []
    for f in files:
        with open(f"{REPO_DIR}/{f}", "rb") as fh:
            content = fh.read()
        blob = req("POST", "/git/blobs", {
            "content": base64.b64encode(content).decode(), "encoding": "base64"})
        tree_items.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"  blob {f} -> {blob['sha'][:7]} ({len(content)}B)")
    # 4. 新树
    tree = req("POST", "/git/trees", {"base_tree": base_tree, "tree": tree_items})
    print("new tree", tree["sha"][:7])
    # 5. 新提交（message 取本地提交）
    msg = subprocess.run(["git", "log", "-1", "--format=%B", local_tip],
                         capture_output=True, text=True, cwd=REPO_DIR).stdout
    commit = req("POST", "/git/commits", {
        "message": msg, "tree": tree["sha"], "parents": [base_sha]})
    print("new commit", commit["sha"][:7])
    # 6. 更新分支引用（fast-forward 校验）
    upd = req("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    print("branch ->", upd["object"]["sha"][:7])
    print("DONE")


if __name__ == "__main__":
    main()

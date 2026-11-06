#!/bin/bash
# .304 批次：安卓上游 11 提交迁移驱动（2df38c45..5193fd0d）
# 策略：package.json / package-lock.json / android/app/build.gradle 冲突自动取 OURS（fork 版本号体系）；
#       ANDROID_PORT.md 与其余冲突 → 停下等手工（EXIT 2）；网络/promisor 瞬态错重试（最多 3 次）。
set -u
cd /home/z/my-project/folia-android

COMMITS="$@"
[ -z "$COMMITS" ] && COMMITS="2df38c45 2b01d42e 82efd9a0 29efe0c9 b3b4c846 5e9318ba 52548df5 2829f67f 54b55804 cbfbc761 5193fd0d"
OURS_FILES="package.json package-lock.json android/app/build.gradle"

for c in $COMMITS; do
  echo "=== PICK $c $(git log -1 --format=%s $c) ==="
  try=0
  ok=0
  while [ $try -lt 3 ]; do
    try=$((try+1))
    if git cherry-pick -x "$c" >/dev/null 2>&1; then
      echo "CLEAN $c"
      ok=1
      break
    fi
    # 失败：先看是否真冲突（vs 瞬态错）
    conf=$(git diff --name-only --diff-filter=U 2>/dev/null)
    if [ -z "$conf" ] && ! git rev-parse -q --verify CHERRY_PICK_HEAD >/dev/null 2>&1; then
      echo "TRANSIENT_FAIL $c (try $try), 5s 后重试"
      sleep 5
      continue
    fi
    # 真冲突：version 三件套自动 ours
    for f in $OURS_FILES; do
      if git diff --name-only --diff-filter=U | grep -qx "$f"; then
        git checkout --ours -- "$f" && git add -- "$f" && echo "  auto-ours: $f"
      fi
    done
    left=$(git diff --name-only --diff-filter=U)
    if [ -n "$left" ]; then
      echo "CONFLICT_STOP $c 剩余冲突："
      echo "$left"
      exit 2
    fi
    if git -c core.editor=true cherry-pick --continue >/dev/null 2>&1; then
      echo "RESOLVED_AUTO $c"
      ok=1
      break
    else
      echo "CONTINUE_FAIL $c (try $try)"
      git status --short | head -5
      exit 3
    fi
  done
  [ $ok -eq 1 ] || { echo "GIVE_UP $c"; exit 4; }
done
echo "ALL_DONE"

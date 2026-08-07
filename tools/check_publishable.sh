#!/usr/bin/env bash
# Refuse to publish anything that shouldn't leave this machine.
#
#   tools/check_publishable.sh
#
# .gitignore is the first line of defence; this is the second, because
# `git add -f` and a stray `git add -A` in a fresh clone both walk straight
# past it. Run before the first push and before any release.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

note() { printf '  %s\n' "$1"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
ok()   { printf '\033[32m ok \033[0m %s\n' "$1"; }

# What git would actually publish. Falls back to a filesystem walk before init.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  tracked=$(git ls-files 2>/dev/null)
  staged=$(git diff --cached --name-only 2>/dev/null)
  candidates=$(printf '%s\n%s\n' "$tracked" "$staged" | sort -u | sed '/^$/d')
  mode="git-tracked"
else
  candidates=$(find . -type f -not -path './.git/*' | sed 's|^\./||')
  mode="filesystem (repo not initialised yet)"
fi
printf 'checking %s files [%s]\n\n' "$(printf '%s\n' "$candidates" | sed '/^$/d' | wc -l | tr -d ' ')" "$mode"

# 1. Third-party binaries we must not redistribute.
if printf '%s\n' "$candidates" | grep -qE '^(fw/|vendor/)'; then
  bad "TE firmware or updater staged (fw/ or vendor/) — these are not ours to ship"
  printf '%s\n' "$candidates" | grep -E '^(fw/|vendor/)' | head -5 | while read -r f; do note "$f"; done
else
  ok "no TE binaries"
fi

# 2. The hardware serial, anywhere. Built at runtime so this script does not
#    match itself and report a false positive.
SERIAL="E3PUR""397"
serial_hits=$(printf '%s\n' "$candidates" | while read -r f; do
  [ -f "$f" ] && grep -Il "$SERIAL" "$f" 2>/dev/null
done)
if [ -n "$serial_hits" ]; then
  bad "device serial present in publishable files"
  printf '%s\n' "$serial_hits" | head -8 | while read -r f; do note "$f"; done
else
  ok "no device serial"
fi

# 3. Private correspondence, server config, deploy tooling.
if printf '%s\n' "$candidates" | grep -qE '^(docs/disclosure/|ops/|tools/(stage_ghost|deploy_web))'; then
  bad "private correspondence or infrastructure staged"
  printf '%s\n' "$candidates" | grep -E '^(docs/disclosure/|ops/|tools/(stage_ghost|deploy_web))' | while read -r f; do note "$f"; done
else
  ok "no private correspondence or server config"
fi

# 4. Device backups.
if printf '%s\n' "$candidates" | grep -qE '^backups/|\.pak$'; then
  bad "device backup (.pak) staged"
  printf '%s\n' "$candidates" | grep -E '^backups/|\.pak$' | head -5 | while read -r f; do note "$f"; done
else
  ok "no device backups"
fi

# 5. Anything that looks like a credential.
cred_hits=$(printf '%s\n' "$candidates" | while read -r f; do
  [ -f "$f" ] && grep -IlE '(BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|password[[:space:]]*[:=])' "$f" 2>/dev/null
done)
if [ -n "$cred_hits" ]; then
  bad "possible credential material"
  printf '%s\n' "$cred_hits" | while read -r f; do note "$f"; done
else
  ok "no obvious credentials"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32mclean — safe to publish\033[0m\n'
else
  printf '\033[31mnot safe to publish. fix the above first.\033[0m\n'
fi
exit "$fail"

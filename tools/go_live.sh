#!/usr/bin/env bash
# Flip the repo public and turn on Pages. Run when you're ready, not before.
#
#   tools/go_live.sh --dry-run    # show what it would do (default)
#   tools/go_live.sh --apply
#
# Deliberately does NOT publish the blog post or unlist the video — those stay
# yours to click.
set -euo pipefail

REPO="seajaysec/ep-unity"
DOMAIN="ep-unity.linecross.ing"
APPLY="${1:---dry-run}"

cd "$(dirname "$0")/.."

echo "=== pre-flight ==="
tools/check_publishable.sh || { echo "publication check failed — stopping"; exit 1; }
echo

if [ "$APPLY" != "--apply" ]; then
  echo "DRY RUN. Would do:"
  echo "  1. gh repo edit $REPO --visibility public"
  echo "  2. enable Pages via GitHub Actions"
  echo "  3. set custom domain $DOMAIN + enforce HTTPS"
  echo
  echo "Then, by hand at Porkbun:  CNAME  ep-unity  ->  seajaysec.github.io"
  echo "Re-run with --apply when ready."
  exit 0
fi

echo "=== 1. making repo public ==="
gh repo edit "$REPO" --visibility public --accept-visibility-change-consequences
echo "public."

echo "=== 2. enabling Pages (GitHub Actions source) ==="
gh api -X POST "repos/$REPO/pages" -f "build_type=workflow" 2>/dev/null \
  || gh api -X PUT "repos/$REPO/pages" -f "build_type=workflow"
echo "pages enabled."

echo "=== 3. custom domain ==="
gh api -X PUT "repos/$REPO/pages" -f "cname=$DOMAIN" -F "https_enforced=true" 2>/dev/null \
  || echo "  (set the domain in Settings -> Pages if this failed; cert needs DNS first)"

echo
echo "=== DNS — do this at Porkbun if you haven't ==="
echo "  type:  CNAME"
echo "  host:  ep-unity"
echo "  value: seajaysec.github.io"
echo
echo "Then watch the deploy:  gh run watch -R $REPO"
echo "And verify:             curl -sI https://$DOMAIN/ | head -1"
echo
echo "Still yours to do: publish the post, make the video public,"
echo "delete the two redundant Ghost drafts."

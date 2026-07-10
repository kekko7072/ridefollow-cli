#!/usr/bin/env bash
#
# Cut a ridefollow-cli release.
#
# Bumps the version, commits, tags `cli-vX.Y.Z`, and pushes — which triggers
# .github/workflows/publish-cli.yml to publish to npm AND auto-bump the
# Homebrew tap (RideFollow/homebrew-tap). That's the whole release.
#
# Usage:
#   npm run release              # prompts for the new version
#   npm run release -- 1.0.5     # explicit version
#   npm run release -- patch     # or minor / major (semver bump)
#   ./scripts/release.sh 1.0.5   # same, without npm
#
set -euo pipefail

cd "$(dirname "$0")/.."   # cli/ repo root

red()  { printf '\033[31m%s\033[0m\n' "$1"; }
grn()  { printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

command -v node >/dev/null || { red "✗ node is required"; exit 1; }
command -v git  >/dev/null || { red "✗ git is required";  exit 1; }

CURRENT=$(node -p "require('./package.json').version")

# --- pre-flight: clean tree, on main, up to date -----------------------------
if [ -n "$(git status --porcelain)" ]; then
  red "✗ Working tree is not clean — commit or stash first:"
  git status --short
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  red "✗ Releases go from 'main', but you're on '$BRANCH'."
  exit 1
fi

# --- resolve the target version ----------------------------------------------
BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  dim "Current version: $CURRENT"
  read -rp "New version (X.Y.Z, or patch/minor/major): " BUMP
fi
[ -n "$BUMP" ] || { red "✗ No version given."; exit 1; }

# npm version resolves patch/minor/major or an explicit X.Y.Z, writes
# package.json + package-lock.json, and does NOT create a git tag.
NEWVER=$(npm version "$BUMP" --no-git-tag-version --allow-same-version | sed 's/^v//')
TAG="cli-v$NEWVER"

# Guard: refuse to reuse a published tag.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || \
   git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  red "✗ Tag $TAG already exists (locally or on origin). Reverting bump."
  git checkout -- package.json package-lock.json 2>/dev/null || true
  exit 1
fi

echo
grn "  $CURRENT  →  $NEWVER   (tag $TAG)"
read -rp "Commit, tag, and push to origin? [y/N] " OK
case "$OK" in
  y|Y|yes|YES) ;;
  *) dim "Aborted — reverting version bump."
     git checkout -- package.json package-lock.json
     exit 1 ;;
esac

git add package.json package-lock.json
git commit -m "chore: release $NEWVER"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"

echo
grn "✓ Pushed $TAG — the publish workflow is now running."
dim  "  Watch it:"
dim  "    gh run watch \"\$(gh run list -R RideFollow/ridefollow-cli --workflow=publish-cli.yml -L1 --json databaseId --jq '.[0].databaseId')\" -R RideFollow/ridefollow-cli"
dim  "  It publishes to npm and bumps the Homebrew tap automatically."

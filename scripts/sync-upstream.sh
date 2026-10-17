#!/usr/bin/env bash
set -euo pipefail

echo "==> Fetching upstream..."
git fetch upstream master

echo "==> Rebasing current branch onto upstream/master..."
git rebase upstream/master

echo "==> Pushing updated master to origin..."
git push origin master

echo "==> Running local build..."
pnpm build

echo "==> Upstream sync complete and verified."

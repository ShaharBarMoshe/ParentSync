#!/usr/bin/env bash
set -euo pipefail

# Smart packaging script — only rebuilds layers that changed since last package.
# Uses a marker file to track the last packaged commit.

MARKER=".last-packaged-sha"
CURRENT_SHA=$(git rev-parse HEAD)
LAST_SHA=""

echo "========================================"
echo "  ParentSync Smart Packager"
echo "========================================"
echo "Current SHA: $CURRENT_SHA"

if [[ -f "$MARKER" ]]; then
  LAST_SHA=$(cat "$MARKER")
  echo "Last packaged SHA: $LAST_SHA"
else
  echo "Last packaged SHA: (none)"
fi
echo "========================================"

build_backend=false
build_frontend=false
build_electron=false

if [[ -z "$LAST_SHA" ]]; then
  echo "No previous build found — full rebuild"
  build_backend=true
  build_frontend=true
  build_electron=true
else
  changed_files=$(git diff --name-only "$LAST_SHA" HEAD 2>/dev/null || echo "FULL")

  if [[ "$changed_files" == "FULL" ]]; then
    echo "Cannot diff from last build — full rebuild"
    build_backend=true
    build_frontend=true
    build_electron=true
  else
    echo "Changed files since last build:"
    echo "$changed_files" | sed 's/^/  /'
    echo "----------------------------------------"

    if echo "$changed_files" | grep -q "^backend/"; then
      build_backend=true
    fi
    if echo "$changed_files" | grep -q "^frontend/"; then
      build_frontend=true
    fi
    if echo "$changed_files" | grep -q "^electron/"; then
      build_electron=true
    fi
    # Root config changes trigger full rebuild
    if echo "$changed_files" | grep -q "^package\.json\|^tsconfig"; then
      build_backend=true
      build_frontend=true
      build_electron=true
    fi
  fi
fi

echo "Build plan:"
echo "  Backend:  $( $build_backend && echo 'REBUILD' || echo 'SKIP' )"
echo "  Frontend: $( $build_frontend && echo 'REBUILD' || echo 'SKIP' )"
echo "  Electron: $( $build_electron && echo 'REBUILD' || echo 'SKIP' )"
echo "========================================"

if $build_backend; then
  echo "=> Building backend..."
  npm run build:backend
else
  echo "=> Backend unchanged, skipping"
fi

if $build_frontend; then
  echo "=> Building frontend..."
  npm run build:frontend
else
  echo "=> Frontend unchanged, skipping"
fi

if $build_electron; then
  echo "=> Building electron..."
  npm run build:electron
else
  echo "=> Electron unchanged, skipping"
fi

if $build_backend; then
  echo "=> Rebuilding native modules..."
  npm run rebuild:native
else
  echo "=> Native modules unchanged, skipping"
fi

echo "=> Packaging for Linux..."
npx electron-builder --linux

echo "$CURRENT_SHA" > "$MARKER"
echo "=> Done! Packaged at SHA: $CURRENT_SHA"

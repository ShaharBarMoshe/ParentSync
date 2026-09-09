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
  # Committed changes since the last package, PLUS anything currently dirty in
  # the working tree. Without the second half an uncommitted fix is silently
  # left out of the build and a stale AppImage ships.
  changed_files=$(
    {
      git diff --name-only "$LAST_SHA" HEAD 2>/dev/null || echo "FULL"
      git status --porcelain 2>/dev/null | sed 's/^.\{3\}//' | sed 's/.* -> //'
    } | sort -u
  )

  # "FULL" is now one line among the dirty-file list, so match it as a line.
  if echo "$changed_files" | grep -qx "FULL"; then
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

# Native modules are rebuilt on their own schedule, never on the changed-layers
# optimisation: `npm test` rebuilds better-sqlite3 against the local Node ABI
# (see backend's pretest hook), and that flip is invisible to a source diff. A
# Node-ABI binary packages fine and then fails at launch with
# "Module did not self-register", so decide from the binary itself.
#
# The check is the ABI mismatch we want: if plain Node can load the module it is
# a Node build and must be rebuilt for Electron; if Node cannot load it, it is
# already an Electron build.
native_is_node_abi() {
  (cd backend && node -e "new (require('better-sqlite3'))(':memory:')") >/dev/null 2>&1
}

if $build_backend || native_is_node_abi; then
  echo "=> Rebuilding native modules for Electron..."
  npm run rebuild:native
else
  echo "=> Native modules already built for Electron, skipping"
fi


echo "=> Packaging for Linux..."
if [[ "${BUILD_DEB:-false}" == "true" ]]; then
  echo "   Targets: AppImage + deb"
  npx electron-builder --linux
else
  echo "   Target: AppImage only (set BUILD_DEB=true for deb)"
  npx electron-builder --linux AppImage
fi

# Verify what actually shipped. electron-builder runs its own native rebuild
# while packaging, so this — not the pre-build step — is the authoritative
# check. A Node-ABI binary packages without complaint and then kills the app at
# launch with "Module did not self-register", which is only visible in the
# systemd journal. Fail here instead.
PACKAGED_NATIVE="release/linux-unpacked/resources/backend/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
if [[ -f "$PACKAGED_NATIVE" ]]; then
  if node -e "require('$PWD/$PACKAGED_NATIVE')" >/dev/null 2>&1; then
    echo "ERROR: the packaged better-sqlite3 is built for Node's ABI, not Electron's." >&2
    echo "       This AppImage would fail at startup with" >&2
    echo "       \"Module did not self-register\". Aborting before install." >&2
    echo "       Fix: cd backend && npx @electron/rebuild --force, then repackage." >&2
    exit 1
  fi
  echo "=> Verified: packaged better-sqlite3 targets Electron's ABI"
else
  echo "WARNING: could not find packaged better-sqlite3 to verify its ABI" >&2
fi

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  # Built from a dirty tree: keeping the marker would make the next run diff
  # against a commit that never contained these changes, silently skipping a
  # layer again. Drop it and force a full rebuild next time.
  rm -f "$MARKER"
  echo "=> Done! Packaged from a dirty working tree (SHA $CURRENT_SHA + local changes)."
  echo "   Build marker cleared — the next package will be a full rebuild."
else
  echo "$CURRENT_SHA" > "$MARKER"
  echo "=> Done! Packaged at SHA: $CURRENT_SHA"
fi

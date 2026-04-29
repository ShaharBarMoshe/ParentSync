#!/usr/bin/env bash
set -euo pipefail

# Install ParentSync locally as a daemon service.
#
# - Stores versioned AppImages in ~/.local/share/parentsync/versions/
# - Keeps the 4 most recent versions, prunes older ones
# - Symlinks ~/.local/bin/ParentSync.AppImage → latest version
# - Creates a systemd user service (auto-start on login)
# - Desktop shortcut kills previous instance and starts fresh
# - Database stays at ~/.config/parentsync/parentsync.db (unchanged)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$PROJECT_DIR/release"
VERSIONS_DIR="$HOME/.local/share/parentsync/versions"
MAX_VERSIONS=4

# ── Find AppImage ──────────────────────────────────────────────────

APPIMAGE=$(find "$RELEASE_DIR" -maxdepth 1 -name "ParentSync-*.AppImage" -type f | sort -V | tail -1)
if [ -z "$APPIMAGE" ]; then
  echo "ERROR: No AppImage found in $RELEASE_DIR"
  echo "Run 'npm run package:linux' first."
  exit 1
fi

# Extract version from filename (e.g. ParentSync-1.0.1.AppImage → 1.0.1)
BASENAME=$(basename "$APPIMAGE")
VERSION=$(echo "$BASENAME" | sed 's/ParentSync-\(.*\)\.AppImage/\1/')
TIMESTAMP=$(date +%Y%m%d%H%M%S)
VERSIONED_NAME="ParentSync-${VERSION}-${TIMESTAMP}.AppImage"

echo "Installing ParentSync v${VERSION} (${VERSIONED_NAME})"

# ── Create directories ─────────────────────────────────────────────

mkdir -p ~/.local/bin
mkdir -p ~/.local/share/applications
mkdir -p ~/.config/systemd/user
mkdir -p "$VERSIONS_DIR"

# ── Stop running instance ──────────────────────────────────────────

echo "  -> Stopping running instance..."
systemctl --user stop parentsync.service 2>/dev/null || true
# Also kill any stray processes
pkill -f "ParentSync.AppImage" 2>/dev/null || true
sleep 1

# ── Install versioned AppImage ─────────────────────────────────────

cp "$APPIMAGE" "$VERSIONS_DIR/$VERSIONED_NAME"
chmod +x "$VERSIONS_DIR/$VERSIONED_NAME"
echo "  -> Saved version: $VERSIONS_DIR/$VERSIONED_NAME"

# Symlink latest
ln -sf "$VERSIONS_DIR/$VERSIONED_NAME" ~/.local/bin/ParentSync.AppImage
echo "  -> Symlinked ~/.local/bin/ParentSync.AppImage → $VERSIONED_NAME"

# ── Prune old versions (keep latest $MAX_VERSIONS) ────────────────

INSTALLED_COUNT=$(ls -1 "$VERSIONS_DIR"/ParentSync-*.AppImage 2>/dev/null | wc -l)
if [ "$INSTALLED_COUNT" -gt "$MAX_VERSIONS" ]; then
  PRUNE_COUNT=$((INSTALLED_COUNT - MAX_VERSIONS))
  echo "  -> Pruning $PRUNE_COUNT old version(s) (keeping $MAX_VERSIONS)..."
  ls -1t "$VERSIONS_DIR"/ParentSync-*.AppImage | tail -n "$PRUNE_COUNT" | while read -r old; do
    echo "     Removing: $(basename "$old")"
    rm -f "$old"
  done
fi

# Show kept versions
echo "  -> Installed versions:"
ls -1t "$VERSIONS_DIR"/ParentSync-*.AppImage | head -n "$MAX_VERSIONS" | while read -r v; do
  MARKER=""
  if [ "$(readlink -f ~/.local/bin/ParentSync.AppImage)" = "$(readlink -f "$v")" ]; then
    MARKER=" (active)"
  fi
  echo "     $(basename "$v")$MARKER"
done

# ── Install icons ──────────────────────────────────────────────────

ICON_PATH=""
if [ -f "$PROJECT_DIR/assets/icon.svg" ] && command -v rsvg-convert &>/dev/null; then
  for size in 16 24 32 48 64 128 256 512; do
    dir="$HOME/.local/share/icons/hicolor/${size}x${size}/apps"
    mkdir -p "$dir"
    rsvg-convert -w "$size" -h "$size" "$PROJECT_DIR/assets/icon.svg" -o "$dir/parentsync.png"
  done
  ICON_PATH="$HOME/.local/share/icons/hicolor/256x256/apps/parentsync.png"
  echo "  -> Icons installed (all sizes)"
elif [ -f "$PROJECT_DIR/assets/icon.png" ]; then
  mkdir -p ~/.local/share/icons/hicolor/256x256/apps
  cp "$PROJECT_DIR/assets/icon.png" ~/.local/share/icons/hicolor/256x256/apps/parentsync.png
  ICON_PATH="$HOME/.local/share/icons/hicolor/256x256/apps/parentsync.png"
  echo "  -> Icon installed (256x256)"
fi

if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t ~/.local/share/icons/hicolor/ 2>/dev/null || true
fi

# ── Create launcher script ─────────────────────────────────────────
# Kills any existing instance, then starts the latest AppImage.

cat > ~/.local/bin/parentsync-launcher.sh << 'LAUNCHER'
#!/usr/bin/env bash
# Kill previous ParentSync instance, then start the latest one.
pkill -f "ParentSync.AppImage" 2>/dev/null || true
sleep 1
exec "$HOME/.local/bin/ParentSync.AppImage" --no-sandbox "$@"
LAUNCHER
chmod +x ~/.local/bin/parentsync-launcher.sh
echo "  -> Launcher script installed"

# ── Create systemd user service ────────────────────────────────────

cat > ~/.config/systemd/user/parentsync.service << EOF
[Unit]
Description=ParentSync — Family task manager
After=graphical-session.target

[Service]
Type=simple
ExecStart=$HOME/.local/bin/ParentSync.AppImage --no-sandbox
ExecStop=/bin/kill -TERM \$MAINPID
Restart=on-failure
RestartSec=5
Environment=DISPLAY=${DISPLAY:-:0}
Environment=XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}
Environment=XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable parentsync.service
echo "  -> Systemd service installed and enabled (auto-start on login)"

# ── Create .desktop entry ──────────────────────────────────────────
# Clicking the icon kills the old instance and starts fresh via launcher.

cat > ~/.local/share/applications/parentsync.desktop << EOF
[Desktop Entry]
Name=ParentSync
Comment=Family task manager with WhatsApp & Gmail integration
Exec=$HOME/.local/bin/parentsync-launcher.sh
Icon=$ICON_PATH
Type=Application
Categories=Office;ProjectManagement;
Terminal=false
StartupNotify=true
StartupWMClass=ParentSync
EOF

chmod +x ~/.local/share/applications/parentsync.desktop
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
echo "  -> Desktop entry registered"

# Desktop shortcut
DESKTOP_DIR="$HOME/Desktop"
if [ -d "$DESKTOP_DIR" ]; then
  cp ~/.local/share/applications/parentsync.desktop "$DESKTOP_DIR/parentsync.desktop"
  chmod +x "$DESKTOP_DIR/parentsync.desktop"
  gio set "$DESKTOP_DIR/parentsync.desktop" metadata::trusted true 2>/dev/null || true
  echo "  -> Desktop shortcut created"
fi

# ── Start the service ──────────────────────────────────────────────

echo ""
echo "Starting ParentSync..."
systemctl --user start parentsync.service
sleep 2

if systemctl --user is-active --quiet parentsync.service; then
  echo "ParentSync is running!"
else
  echo "WARNING: Service did not start. Check: systemctl --user status parentsync.service"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "  Version:   $VERSION"
echo "  AppImage:  ~/.local/bin/ParentSync.AppImage → $VERSIONED_NAME"
echo "  Database:  ~/.config/parentsync/parentsync.db (unchanged)"
echo "  Versions:  $VERSIONS_DIR/ ($MAX_VERSIONS kept)"
echo "  Service:   systemctl --user {start|stop|restart|status} parentsync.service"
echo ""
echo "  Click the desktop icon to restart the app."
echo "  The app auto-starts on login."

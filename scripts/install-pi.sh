#!/usr/bin/env bash
#
# TempestLens — Raspberry Pi kiosk installer.
#
#   curl -fsSL https://raw.githubusercontent.com/rtheil/tempest-lens/main/scripts/install-pi.sh | bash
#
# Installs Node (if needed), fetches + builds TempestLens, runs it as a systemd
# service, and launches a fullscreen Chromium kiosk pointed at it on boot.
# After it finishes, open http://<this-pi>.local:<PORT> from any device and
# paste your Tempest token to finish setup.
#
# Target: Raspberry Pi OS (Bullseye/Bookworm) with the desktop. Run as the
# normal 'pi'-style user (NOT root); the script uses sudo where it needs to.
#
# Override with env vars, e.g.:  PORT=8080 BRANCH=dev bash install-pi.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/rtheil/tempest-lens.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-$HOME/tempest-lens}"
PORT="${PORT:-8000}"
SERVICE="tempest-lens"
NODE_MAJOR="20"

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }

if [ "$(id -u)" = "0" ]; then
  echo "Please run as your normal user (not root); the script uses sudo as needed." >&2
  exit 1
fi
USER_NAME="$(id -un)"

# --------------------------------------------------------------------------- #
say "Installing prerequisites (git, unclutter)…"
sudo apt-get update -y
sudo apt-get install -y git unclutter curl ca-certificates xz-utils

# --------------------------------------------------------------------------- #
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  if [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then NODE_OK=1; fi
fi
if [ "$NODE_OK" = "1" ]; then
  say "Node $(node -v) already present — good."
else
  ARCH="$(uname -m)"
  if [ "$ARCH" = "armv7l" ] || [ "$ARCH" = "armv6l" ]; then
    # NodeSource dropped 32-bit ARM (armhf) at v20 — use the official nodejs.org
    # tarball instead. (64-bit Pi OS reports aarch64 and uses NodeSource below.)
    FILE="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" | grep -o "node-v[0-9.]*-linux-${ARCH}.tar.xz" | head -1)"
    [ -n "$FILE" ] || { echo "No Node v${NODE_MAJOR} build for ${ARCH}." >&2; exit 1; }
    say "Installing ${FILE%-linux*} (official ${ARCH} build)…"
    curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/${FILE}" -o /tmp/node.tar.xz
    sudo mkdir -p /usr/local/lib/nodejs
    sudo tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
    NODE_ROOT="/usr/local/lib/nodejs/${FILE%.tar.xz}"
    sudo ln -sf "$NODE_ROOT/bin/node" /usr/local/bin/node
    sudo ln -sf "$NODE_ROOT/bin/npm" /usr/local/bin/npm
    sudo ln -sf "$NODE_ROOT/bin/npx" /usr/local/bin/npx
    rm -f /tmp/node.tar.xz
  else
    say "Installing Node.js ${NODE_MAJOR}.x (NodeSource)…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
fi
NODE_BIN="$(command -v node)"

# --------------------------------------------------------------------------- #
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout in $APP_DIR…"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  say "Cloning TempestLens into $APP_DIR…"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

say "Installing dependencies + building…"
cd "$APP_DIR"
npm install
npm run build

# --------------------------------------------------------------------------- #
say "Installing systemd service ($SERVICE)…"
sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=TempestLens weather dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
ExecStart=${NODE_BIN} ${APP_DIR}/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl restart "$SERVICE"

# --------------------------------------------------------------------------- #
# Let the service user reboot / power off without a password, so the in-app
# Power buttons work. Scoped to exactly those two commands.
say "Granting reboot/shutdown permission (sudoers)…"
SUDOERS=/etc/sudoers.d/tempest-lens
sudo tee "$SUDOERS" >/dev/null <<SUDO
${USER_NAME} ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /bin/systemctl reboot, /bin/systemctl poweroff
SUDO
sudo chmod 0440 "$SUDOERS"
sudo visudo -cf "$SUDOERS" >/dev/null || { warn "sudoers file invalid — removing it."; sudo rm -f "$SUDOERS"; }

# --------------------------------------------------------------------------- #
say "Setting up the Chromium kiosk…"
CHROMIUM="$(command -v chromium || command -v chromium-browser || true)"
if [ -z "$CHROMIUM" ]; then
  warn "Chromium not found — install it (sudo apt install chromium) then re-run, or point your own browser at the URL below."
fi

KIOSK="$HOME/tempest-lens-kiosk.sh"
cat > "$KIOSK" <<KIOSKSCRIPT
#!/bin/bash
# Launch Chromium fullscreen against the local TempestLens server.
export DISPLAY=:0
# Wait for the service to answer before opening the browser.
for i in \$(seq 1 90); do
  curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
# No screen blanking / power management on a wall display.
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
unclutter -idle 0.5 -root &
PROFILE="\$HOME/.config/chromium-kiosk"
mkdir -p "\$PROFILE"
rm -f "\$PROFILE"/Singleton* 2>/dev/null || true
exec ${CHROMIUM:-chromium} \\
  --kiosk \\
  --user-data-dir="\$PROFILE" \\
  --no-first-run \\
  --disable-infobars \\
  --noerrdialogs \\
  --disable-session-crashed-bubble \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  --overscroll-history-navigation=0 \\
  "http://localhost:${PORT}"
KIOSKSCRIPT
chmod +x "$KIOSK"

# Wire it into the LXDE session autostart (X11 desktop).
AUTOSTART_DIR="$HOME/.config/lxsession/LXDE-pi"
if [ -d "$HOME/.config/lxsession" ]; then
  mkdir -p "$AUTOSTART_DIR"
  AUTOSTART="$AUTOSTART_DIR/autostart"
  touch "$AUTOSTART"
  grep -qF "tempest-lens-kiosk.sh" "$AUTOSTART" || echo "@$KIOSK" >> "$AUTOSTART"
  say "Kiosk wired into LXDE autostart."
else
  warn "LXDE session not detected. Your Pi OS may use Wayland (Bookworm)."
  warn "Add this to your desktop autostart manually: @$KIOSK"
fi

# --------------------------------------------------------------------------- #
# Desktop auto-login — required for the kiosk to start unattended on boot (the
# autostart only runs once a desktop session logs in). On by default; opt out
# with AUTOLOGIN=0.
AUTOLOGIN="${AUTOLOGIN:-1}"
if [ "$AUTOLOGIN" = "1" ]; then
  warn "Enabling DESKTOP AUTO-LOGIN so the kiosk launches on boot with no keyboard/login."
  warn "Security note: anyone who can power on this Pi lands directly in your desktop session."
  warn "Don't want that? Re-run with:  AUTOLOGIN=0   (you'll then log in manually for the kiosk to start)."
  if command -v raspi-config >/dev/null 2>&1; then
    sudo raspi-config nonint do_boot_behaviour B4 \
      && say "Desktop auto-login enabled." \
      || warn "Could not set auto-login automatically — set 'System → Boot → Desktop Autologin' via raspi-config."
  else
    warn "raspi-config not found — enable 'Desktop Autologin' manually so the kiosk starts on boot."
  fi
else
  warn "Skipping desktop auto-login (AUTOLOGIN=0). The kiosk will start only after you log in to the desktop."
fi

# --------------------------------------------------------------------------- #
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Done!"
cat <<DONE

  TempestLens is running as a service (sudo systemctl status ${SERVICE}).

  Finish setup from any device on your network:

      http://$(hostname).local:${PORT}
      http://${IP:-<pi-ip>}:${PORT}

  Paste your Tempest token (tempestwx.com → Settings → Tokens) and it will
  find your station automatically. Reboot to launch the kiosk fullscreen.

DONE

#!/usr/bin/env bash
set -euo pipefail

# Pulls the latest code, installs dependencies, and restarts the service.
# Usage: ./scripts/update.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="envisalink-syslog-listener"

cd "$REPO_DIR"

echo "Pulling latest changes ..."
git pull --ff-only

echo "Installing dependencies ..."
npm ci --omit=dev

LOGROTATE_FILE="${REPO_DIR}/${SERVICE_NAME}.logrotate"
if [[ -f "$LOGROTATE_FILE" ]]; then
  echo "Updating logrotate config ..."
  sudo cp "$LOGROTATE_FILE" /etc/logrotate.d/"$SERVICE_NAME"
fi

echo "Restarting $SERVICE_NAME ..."
sudo systemctl restart "$SERVICE_NAME"

echo "Done. Status:"
sudo systemctl status "$SERVICE_NAME" --no-pager

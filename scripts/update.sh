#!/usr/bin/env bash
set -euo pipefail

# Pulls the latest code, installs dependencies, and restarts the service.
# Usage: ./scripts/update.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SERVICE_NAME="envisalink-syslog-listener"

cd "$REPO_DIR"

echo "Pulling latest changes ..."
git pull

echo "Installing dependencies ..."
npm install --production

echo "Restarting $SERVICE_NAME ..."
sudo systemctl restart "$SERVICE_NAME"

echo "Done. Status:"
systemctl status "$SERVICE_NAME" --no-pager

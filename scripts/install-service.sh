#!/usr/bin/env bash
set -euo pipefail

# Copies the local service file to systemd, reloads, and restarts the service.
# Usage: ./scripts/install-service.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

SERVICE_NAME="envisalink-syslog-listener"
SERVICE_FILE="${REPO_DIR}/${SERVICE_NAME}.service"

if [[ ! -f "$SERVICE_FILE" ]]; then
  echo "Error: $SERVICE_FILE not found in current directory."
  echo "Run: cp ${SERVICE_FILE}.sample ${SERVICE_FILE} and edit it first."
  exit 1
fi

echo "Copying $SERVICE_FILE to /etc/systemd/system/ ..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/

LOGROTATE_FILE="${REPO_DIR}/${SERVICE_NAME}.logrotate"
if [[ -f "$LOGROTATE_FILE" ]]; then
  echo "Installing logrotate config ..."
  sudo cp "$LOGROTATE_FILE" /etc/logrotate.d/"$SERVICE_NAME"
fi

echo "Reloading systemd daemon ..."
sudo systemctl daemon-reload

echo "Restarting $SERVICE_NAME ..."
sudo systemctl restart "$SERVICE_NAME"

echo "Done. Status:"
systemctl status "$SERVICE_NAME" --no-pager

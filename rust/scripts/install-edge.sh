#!/usr/bin/env bash
# Install the ADS-B edge binaries on a Raspberry Pi. Run with sudo on the Pi.
#
# Idempotent: safe to re-run to upgrade binaries. Existing configs in
# /etc/adsb are never overwritten -- new ones are dropped alongside as
# *.toml.new so an upgrade cannot silently change a running node's settings.
set -euo pipefail

SRC="${SRC:-/tmp}"
BIN=/usr/local/bin
CFG=/etc/adsb
DATA=/var/lib/adsb
UNITS=/etc/systemd/system

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo bash $0)" >&2; exit 1; }

arch=$(uname -m)
echo "Detected architecture: $arch"
case "$arch" in
  aarch64) storage_capable=yes ;;
  armv7l|armv6l)
    storage_capable=no
    echo "NOTE: 32-bit ARM. DuckDB has no 32-bit support, so this node can run"
    echo "      the feed client only. Storage must live on an aarch64 node."
    ;;
  *) storage_capable=yes; echo "NOTE: unexpected arch; proceeding." ;;
esac

# Service account. No login shell, no home of its own beyond the data dir --
# which doubles as HOME so DuckDB has somewhere to cache its extensions.
if ! id adsb >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin adsb
  echo "Created service user 'adsb'"
fi

install -d -o adsb -g adsb -m 0750 "$DATA"
install -d -m 0755 "$CFG"

install_config() { # install_config <src> <dest>
  if [ -f "$2" ]; then
    install -m 0644 "$1" "$2.new"
    echo "  kept existing $2 (new version at $2.new)"
  else
    install -m 0644 "$1" "$2"
    echo "  installed $2"
  fi
}

echo "Installing feed client..."
install -m 0755 "$SRC/adsb-pulsar-client" "$BIN/"
install -m 0644 "$SRC/adsb-pulsar-client.service" "$UNITS/"
install_config "$SRC/feed.example.toml" "$CFG/feed.toml"

if [ "$storage_capable" = yes ] && [ -f "$SRC/adsb-data-server" ]; then
  echo "Installing data server..."
  install -m 0755 "$SRC/adsb-data-server" "$BIN/"
  install -m 0644 "$SRC/adsb-data-server.service" "$UNITS/"
  install_config "$SRC/data-server.example.toml" "$CFG/data-server.toml"
fi

systemctl daemon-reload

cat <<EOF

Installed. Before starting, edit the configs -- in particular set a unique
source_id per node, or the fleet's data cannot be attributed:

  \$EDITOR $CFG/feed.toml
$( [ "$storage_capable" = yes ] && echo "  \$EDITOR $CFG/data-server.toml" )

Then:

  systemctl enable --now adsb-pulsar-client
$( [ "$storage_capable" = yes ] && echo "  systemctl enable --now adsb-data-server" )
  journalctl -u adsb-pulsar-client -f

The MQTT hop needs a broker. On this node:  apt install mosquitto
EOF

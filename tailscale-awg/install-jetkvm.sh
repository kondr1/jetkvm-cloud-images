#!/bin/sh
# Installs Tailscale with AmneziaWG/QUIC transports on a JetKVM (BusyBox, armv7) into
# /userdata, which survives firmware updates, and starts it now and on every boot.
#
#   wget -qO- https://github.com/kondr1/jetkvm-cloud-images/releases/download/@TAG@/install-jetkvm.sh | sh
#
# The release tag and archive digest below are filled in when the release is built.
set -eu
TAG=@TAG@
SHA256=@SHA256@
BASE=${BASE:-https://github.com/kondr1/jetkvm-cloud-images/releases/download/$TAG}
DIR=/userdata/tailscale
tmp=/userdata/tailscale-install.$$

fetch() { # fetch <url> <file>
  if command -v curl > /dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi
}

mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
echo "downloading $BASE/tailscale-awg-linux-armv7.tar.gz"
fetch "$BASE/tailscale-awg-linux-armv7.tar.gz" "$tmp/ts.tgz"
echo "$SHA256  $tmp/ts.tgz" | sha256sum -c -
tar -xzf "$tmp/ts.tgz" -C "$tmp"

[ -x /userdata/init.d/S30tailscale ] && /userdata/init.d/S30tailscale stop || true
mkdir -p "$DIR" /userdata/init.d
mv "$tmp/tailscaled" "$DIR/tailscaled"
chmod 755 "$DIR/tailscaled"
mv "$tmp/S30tailscale" /userdata/init.d/S30tailscale
chmod 755 /userdata/init.d/S30tailscale
/userdata/init.d/S30tailscale start

sleep 3
"$DIR/tailscaled" --version | head -1
echo "installed. Next, once:"
echo "  tailscale up --login-server=https://<headscale> --auth-key=<key> --exit-node=<exit node> --exit-node-allow-lan-access"

#!/bin/sh
# Render-service entrypoint.
#
# The service renders UNTRUSTED, uploaded HTML in Chromium. The export ZIP is
# fully self-contained (all assets + vendored GSAP are bundled at build time and
# served to Chromium over loopback), so the render needs ZERO outbound network.
# We enforce that here: block all egress except loopback and replies on already
# established (app-initiated) connections. This is the boundary that stops the
# untrusted page from initiating connections back to the app (e.g. the compose
# `openmaic` service) or anywhere else, even though both share a Docker network.
#
# Requires the container to start as root with CAP_NET_ADMIN (compose:
# `cap_add: [NET_ADMIN]`). We install the rules as root, then drop to the
# unprivileged `render` user for the Node process. If iptables or the capability
# is unavailable, we log and continue WITHOUT lockdown rather than fail to boot —
# so the service still runs in constrained environments (the operator is warned).
set -eu

lockdown() {
  # ESTABLISHED,RELATED lets the Hono API respond to the app's inbound requests;
  # loopback lets the producer's file server + Chromium talk locally. Everything
  # else outbound (new connections, DNS to resolve `openmaic`, etc.) is dropped.
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -P OUTPUT DROP
  # Mirror for IPv6 where available; ignore if the stack/table is absent.
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
}

if [ "${RENDER_EGRESS_LOCKDOWN:-true}" = "true" ]; then
  if [ "$(id -u)" = "0" ] && command -v iptables >/dev/null 2>&1 && lockdown 2>/dev/null; then
    echo "[render-service] egress lockdown active (outbound blocked except loopback)"
  else
    echo "[render-service] WARNING: egress lockdown NOT applied (needs root + CAP_NET_ADMIN + iptables). Chromium can reach the Docker network." >&2
  fi
fi

# Drop privileges to the unprivileged render user for the Node process. When
# already running as that user (no lockdown / non-root start), exec directly.
if [ "$(id -u)" = "0" ]; then
  exec setpriv --reuid=render --regid=render --init-groups node_modules/.bin/tsx src/main.ts
fi
exec node_modules/.bin/tsx src/main.ts

#!/bin/bash
# Stands in for the grok executable in the quota verifier. It re-executes
# itself in a new network namespace that has loopback only, starts the
# recorder there and then becomes grok, so the probe's process group holds
# both. KAOIRO_QUOTA_RECORDER, KAOIRO_QUOTA_PORT, KAOIRO_QUOTA_LOG and
# KAOIRO_QUOTA_GROK come from the verifier; the arguments are grok's.
set -u
if [ "${KAOIRO_QUOTA_INSIDE:-}" != 1 ]; then
  export KAOIRO_QUOTA_INSIDE=1
  exec unshare --user --map-root-user --net -- "$0" "$@"
fi
ip link set lo up || exit 97
python3 -I "$KAOIRO_QUOTA_RECORDER" "$KAOIRO_QUOTA_PORT" "$KAOIRO_QUOTA_LOG" &
for _ in $(seq 100); do
  [ -e "$KAOIRO_QUOTA_LOG.ready" ] && break
  sleep 0.05
done
[ -e "$KAOIRO_QUOTA_LOG.ready" ] || exit 98
exec "$KAOIRO_QUOTA_GROK" "$@"

#!/bin/bash
set -e
# The non-root `agent` user needs to write its Claude config on the root-owned
# persistent mount. Create + chown the config dir, then hand off to the base
# entrypoint (browser stack runs as root, unchanged).
mkdir -p /data/profile/.claude
chown -R agent:agent /data/profile/.claude
exec /entrypoint.sh

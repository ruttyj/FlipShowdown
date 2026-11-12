#!/bin/sh
# Entry point of the `dev` compose service: installs dependencies when needed, then runs the
# API server and the Vite dev server with hot reload.
set -e

# node_modules folders are Docker volumes (Linux builds, separate from the host's), so
# reinstall only when the lockfile changed since the last install into that volume.
install_if_changed() {
    dir="$1"
    marker="$dir/node_modules/.lockfile-hash"
    hash=$(sha256sum "$dir/package-lock.json" | cut -d ' ' -f 1)

    if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$hash" ]; then
        echo "Installing dependencies in $dir ..."
        (cd "$dir" && npm ci --no-audit --no-fund)
        echo "$hash" > "$marker"
    fi
}

install_if_changed /workspace
install_if_changed /workspace/server

# Restarts the API when server/src or shared changes. -L polls because bind mounts from Windows/macOS
# don't deliver file-change events into the container.
(cd /workspace/server && npx nodemon -L --watch src --watch ../shared src/index.js) &

exec npx vite --host 0.0.0.0 --port 5173 --strictPort

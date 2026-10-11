#!/bin/sh
set -eu

# The postgres service is created by docker-compose; here we apply committed migrations,
# retrying until the database accepts connections.
attempt=0
until node /app/docker/migrate.mjs; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo "database not reachable after ${attempt} attempts" >&2
        exit 1
    fi
    echo "waiting for database (attempt ${attempt})" >&2
    sleep 2
done

exec "$@"

#!/bin/bash
set -e

cd /src

if [ -d "$node_modules" ]; then
    rm -r node_modules
fi
npm cache clean --force
npm install
cd static
bower install --allow-root

until npm start -- --ws_uri=ws://${KURENTO_MEDIA_SERVER_HOST}:${KURENTO_MEDIA_SERVER_PORT}/kurento; do
    echo "Server 'kurento-many2many' crashed with exit code $?.  Respawning.." >&2
    sleep 1
done

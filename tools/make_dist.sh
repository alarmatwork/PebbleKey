#!/bin/sh
# Builds the watchapp and puts a copy fit for publishing in dist/PebbleKey.pbw.
#
# The SDK adds a JavaScript source map to the .pbw. It is only a debugging aid, and it records
# folder paths from the computer that built it, so the published copy goes without it.
set -e
cd "$(dirname "$0")/.."
pebble build
mkdir -p dist
cp build/*.pbw dist/PebbleKey.pbw
zip -q -d dist/PebbleKey.pbw pebble-js-app.js.map
echo "Wrote dist/PebbleKey.pbw"

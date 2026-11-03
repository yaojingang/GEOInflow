#!/bin/sh
set -eu
export PATH="$PWD/node_modules/.bin:$PATH"
node dist/liekan-warehouse-start-check.mjs
node scripts/liekan-schema-check.mjs --migrations-only --allow-pending
node scripts/check-db.js
node scripts/liekan-schema-check.mjs
node scripts/liekan-migrate.mjs
node scripts/liekan-seed-demo.mjs --automatic
node scripts/liekan-queue-bootstrap.mjs
node scripts/update-tracker.js
exec node server.js

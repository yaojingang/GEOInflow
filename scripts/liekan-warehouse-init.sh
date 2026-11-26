#!/bin/sh
set -eu
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/liekan-schema-check.mjs --migrations-only --allow-pending
node scripts/check-db.js
node scripts/liekan-schema-check.mjs
node scripts/liekan-migrate.mjs

run_v2() {
  if [ -f dist/liekan-warehouse-v2.mjs ]; then
    node dist/liekan-warehouse-v2.mjs "$@"
  else
    tsx scripts/liekan-warehouse-v2.mts "$@"
  fi
}

run_v2 init

if [ "${LIEKAN_INSTALL_MODE:-fresh}" = fresh ] && [ "${LIEKAN_SEED_DEMO:-true}" = true ]; then
  run_v2 seed-demo --automatic
fi

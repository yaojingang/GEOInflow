#!/bin/sh
set -eu
export PATH="$PWD/node_modules/.bin:$PATH"
case "${LIEKAN_INSTALL_MODE:-}" in fresh|pg-transition) ;; *) printf '%s\n' 'Set LIEKAN_INSTALL_MODE=fresh or pg-transition.' >&2; exit 1;; esac
node scripts/liekan-schema-check.mjs --migrations-only --allow-pending
node scripts/check-db.js
node scripts/liekan-schema-check.mjs
node scripts/liekan-migrate.mjs
node scripts/liekan-queue-bootstrap.mjs
node dist/liekan-warehouse-command.mjs install --mode "$LIEKAN_INSTALL_MODE"

if [ "$LIEKAN_INSTALL_MODE" = fresh ] && [ "${LIEKAN_SEED_DEMO:-true}" = true ]; then
  node dist/liekan-warehouse-command.mjs seed-demo
fi

#!/usr/bin/env bash
# Lance les tests hors navigateur de la surcouche locale (core/local_records.js).
# Voir scripts/tests/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="$ROOT/scripts/tests"
ESBUILD="$ROOT/scripts/node_modules/.bin/esbuild"

if [ ! -x "$ESBUILD" ]; then
  echo "esbuild introuvable. Lancez d'abord : (cd scripts && npm install)"
  exit 1
fi

if [ ! -d "$TESTS_DIR/node_modules/fake-indexeddb" ]; then
  echo "→ Installation de fake-indexeddb (test uniquement)..."
  (cd "$TESTS_DIR" && npm install --no-audit --no-fund --silent)
fi

echo "→ Construction du bundle de test..."
cat > "$TESTS_DIR/.entry.js" <<EOF
export * from "$ROOT/static/src/core/local_records.js";
export { db } from "$ROOT/static/src/core/orm_service.js";
export { initRulesEngine } from "$ROOT/static/src/model/rules_engine/rules_engine.js";
export { allRules } from "$ROOT/static/src/model/rules_engine/rules/index.js";
EOF

"$ESBUILD" "$TESTS_DIR/.entry.js" --bundle --format=esm --target=es2020 \
  --outfile="$TESTS_DIR/.app-test.mjs" --log-level=warning

echo "→ Exécution des tests..."
ROOT_DIR="$ROOT" node "$TESTS_DIR/local_records.test.mjs"

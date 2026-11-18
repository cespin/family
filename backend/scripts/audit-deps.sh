#!/usr/bin/env bash
#
# Checks functions/Cargo.lock against the RustSec advisories, the licence policy and the source
# allowlist in functions/deny.toml. build-functions.sh runs this before building anything.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/../functions"

if ! cargo deny --version >/dev/null 2>&1; then
  echo "error: cargo-deny is not installed. Run: cargo install --locked cargo-deny" >&2
  exit 1
fi

echo "==> Auditing dependencies"
cargo deny --locked check advisories licenses sources bans

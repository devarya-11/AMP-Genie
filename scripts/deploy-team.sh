#!/usr/bin/env bash
# Deploy AMP Genie to the TEAM deployment (amp-genie-netcore.pages.dev,
# Hriday's Cloudflare account) — the canonical multi-user instance.
#
# The committed wrangler.toml belongs to devarya's original project, so this
# script patches a throwaway copy: project name, the team KV namespace id,
# and the Genie 2.0 D1 binding (which only exists on the team account), then
# deploys and restores the original. NEVER commit the patched toml.
#
# Usage: bash scripts/deploy-team.sh
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_NAME="amp-genie-netcore"
TEAM_KV_ID="f65267ebc8be405494fe09a094f29423"
DEVARYA_KV_ID="45848d264860419eae8c4869900eff10"
TEAM_D1_NAME="amp-genie-db"
TEAM_D1_ID="a8d7af54-ac4c-48c5-91e2-99266c3413b5"

cp wrangler.toml /tmp/wrangler.toml.orig
trap 'cp /tmp/wrangler.toml.orig wrangler.toml; echo "wrangler.toml restored"' EXIT

sed -i '' \
  -e "s/^name = \"amp-genie\"/name = \"${TEAM_NAME}\"/" \
  -e "s/id = \"${DEVARYA_KV_ID}\"/id = \"${TEAM_KV_ID}\"/" \
  wrangler.toml

# Genie 2.0: the shared D1 database (brands/pitches/examples/assets/contacts).
if ! grep -q d1_databases wrangler.toml; then
  cat >> wrangler.toml <<EOF

[[d1_databases]]
binding = "DB"
database_name = "${TEAM_D1_NAME}"
database_id = "${TEAM_D1_ID}"
EOF
fi

npx wrangler pages deploy

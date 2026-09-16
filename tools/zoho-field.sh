#!/bin/bash
# Create (or preview) a custom field in a Zoho CRM module, from the command line.
#
# Why this exists: creating a Zoho field needs the org's refresh token and the
# Zoho client secret, both of which live server-side in the zoho-crm edge
# function. This script is just the door-knock -- it never sees a Zoho
# credential, and it never prints the Supabase service key it authenticates
# with (the key is read from the Supabase CLI into a variable and used once).
#
# Usage:
#   tools/zoho-field.sh check  '<field json>'   # preview -- writes nothing
#   tools/zoho-field.sh create '<field json>'   # actually creates it
#
# The field json is the `field` object the edge function's create_field action
# takes, plus a "module" key. Example:
#   tools/zoho-field.sh check '{"module":"Deals","label":"Referral Source",
#     "data_type":"picklist","picklist_values":["Zillow","Past client"]}'
set -euo pipefail

MODE="${1:-}"
SPEC="${2:-}"
if [[ "$MODE" != "check" && "$MODE" != "create" ]] || [[ -z "$SPEC" ]]; then
  echo "usage: $0 check|create '<json>'" >&2
  exit 2
fi
CONFIRM=false
[[ "$MODE" == "create" ]] && CONFIRM=true

PROJECT_REF="ipqoqhsnjubopybujetn"
ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/zoho-crm"
SUPABASE="${SUPABASE_BIN:-$HOME/.local/bin/supabase}"

# The service-role key doubles as the admin identity in zoho-crm's
# authorizeCaller (that is the documented "ops tooling" path). Pulled fresh
# each run so nothing is written to disk, and never echoed.
KEY="$(
  "$SUPABASE" projects api-keys --project-ref "$PROJECT_REF" -o env 2>/dev/null \
    | sed -n 's/^SUPABASE_SERVICE_ROLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'
)"
if [[ -z "$KEY" ]]; then
  echo "Could not read the service-role key from the Supabase CLI. Is it logged in?" >&2
  exit 1
fi

# Split the caller's json into module + field, so the shape matches what the
# edge function expects and a typo'd module can't be mistaken for a field key.
BODY="$(
  MODE_CONFIRM="$CONFIRM" SPEC_JSON="$SPEC" python3 - <<'PY'
import json, os, sys
spec = json.loads(os.environ["SPEC_JSON"])
module = spec.pop("module", "Deals")
print(json.dumps({
    "action": "create_field",
    "module": module,
    "field": spec,
    "confirm": os.environ["MODE_CONFIRM"] == "true",
}))
PY
)"

curl -sS -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $KEY" \
  -H "apikey: $KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  | python3 -m json.tool

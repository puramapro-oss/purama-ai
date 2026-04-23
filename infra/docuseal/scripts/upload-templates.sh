#!/usr/bin/env bash
# Upload 8 Purama contract templates to DocuSeal.
# Flow: HTML → wkhtmltopdf → PDF → base64 → POST /api/templates/pdf (free endpoint).
# Idempotent: deletes existing templates by name then recreates.
set -euo pipefail

TEMPLATES_DIR="${TEMPLATES_DIR:-/docker/docuseal/templates}"
DOCUSEAL_URL="${DOCUSEAL_URL:-http://localhost:3001}"
DOCUSEAL_TOKEN="${DOCUSEAL_TOKEN:-}"
SUPABASE_URL="${SUPABASE_URL:-http://localhost:8000}"
SUPABASE_SVC="${SUPABASE_SVC:-}"
WORK=/tmp/docuseal-upload

[ -n "$DOCUSEAL_TOKEN" ] || { echo "DOCUSEAL_TOKEN required"; exit 1; }
[ -n "$SUPABASE_SVC" ] || { echo "SUPABASE_SVC required"; exit 1; }
command -v wkhtmltopdf >/dev/null || { echo "wkhtmltopdf required"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }

log() { echo "[$(date +%H:%M:%S)] $*"; }

mkdir -p "$WORK"

# slug|file|name|tier|rate|months
TEMPLATES=(
  "ambassadeur-bronze|ambassadeur.html|Ambassadeur Bronze|bronze|10|12"
  "ambassadeur-argent|ambassadeur.html|Ambassadeur Argent|argent|15|12"
  "ambassadeur-or|ambassadeur.html|Ambassadeur Or|or|20|12"
  "ambassadeur-platine|ambassadeur.html|Ambassadeur Platine|platine|25|24"
  "ambassadeur-eternel|ambassadeur.html|Ambassadeur Éternel (héréditaire)|eternel|30|1200"
  "partenariat-business|partenariat-business.html|Partenariat Business|null|null|12"
  "territoire-purama|territoire-purama.html|Convention Territoire Purama|null|null|36"
  "prestation-freelance|prestation-freelance.html|Contrat Prestation Freelance|null|null|3"
)

tier_label() {
  case "$1" in
    bronze)  echo "Bronze" ;;
    argent)  echo "Argent" ;;
    or)      echo "Or" ;;
    platine) echo "Platine" ;;
    eternel) echo "Éternel" ;;
    *)       echo "" ;;
  esac
}

log "Fetching existing DocuSeal templates…"
EXISTING=$(curl -sf -H "X-Auth-Token: $DOCUSEAL_TOKEN" "$DOCUSEAL_URL/api/templates?limit=100")
echo "$EXISTING" | jq -r '.data[]? | "\(.id)\t\(.name)"' > "$WORK/existing.txt"
log "  found $(wc -l < "$WORK/existing.txt") existing"

RESULTS=""

for entry in "${TEMPLATES[@]}"; do
    IFS='|' read -r slug file name tier rate months <<< "$entry"
    filepath="$TEMPLATES_DIR/$file"
    [ -f "$filepath" ] || { log "MISSING $filepath"; continue; }

    # 1. Substitute tier variables if ambassadeur, write rendered HTML
    rendered_html="$WORK/$slug.html"
    if [ "$tier" != "null" ]; then
        TIER_LBL=$(tier_label "$tier")
        sed \
            -e "s/{{tier_label}}/${TIER_LBL}/g" \
            -e "s/{{commission_rate}}/${rate}/g" \
            -e "s/{{duration_months}}/${months}/g" \
            "$filepath" > "$rendered_html"
    else
        cp "$filepath" "$rendered_html"
    fi

    # 2. HTML → PDF
    rendered_pdf="$WORK/$slug.pdf"
    wkhtmltopdf --quiet --encoding UTF-8 \
        --margin-top 15 --margin-bottom 15 --margin-left 15 --margin-right 15 \
        --enable-local-file-access \
        "$rendered_html" "$rendered_pdf" 2>/dev/null
    [ -s "$rendered_pdf" ] || { log "FAIL wkhtmltopdf $slug"; exit 2; }
    log "📄 PDF $slug ($(du -h "$rendered_pdf" | cut -f1))"

    # 3. Delete existing by name (idempotency)
    DS_NAME="Purama — $name"
    EXISTING_ID=$(awk -F'\t' -v n="$DS_NAME" '$2==n {print $1; exit}' "$WORK/existing.txt" || true)
    if [ -n "$EXISTING_ID" ]; then
        log "↻ DELETE existing id=$EXISTING_ID"
        curl -s -X DELETE -H "X-Auth-Token: $DOCUSEAL_TOKEN" \
             "$DOCUSEAL_URL/api/templates/$EXISTING_ID" > /dev/null
    fi

    # 4. Base64 + upload PDF template
    B64=$(base64 -w0 "$rendered_pdf")
    PAYLOAD=$(jq -n \
      --arg html_name "$DS_NAME" \
      --arg doc_name "$slug.pdf" \
      --arg file "$B64" \
      --arg eid "$slug" \
      '{name:$html_name, external_id:$eid, documents:[{name:$doc_name, file:$file}]}')

    log "↑ UPLOAD $slug"
    RESPONSE=$(echo "$PAYLOAD" | curl -s -X POST \
        -H "X-Auth-Token: $DOCUSEAL_TOKEN" \
        -H "Content-Type: application/json" \
        --data-binary @- \
        "$DOCUSEAL_URL/api/templates/pdf")

    NEW_ID=$(echo "$RESPONSE" | jq -r '.id // empty')
    if [ -z "$NEW_ID" ]; then
        log "  FAIL: $(echo "$RESPONSE" | jq -c . 2>/dev/null | head -c 500)"
        exit 3
    fi
    log "  → DocuSeal id=$NEW_ID"

    # 5. Upsert in purama_ai.contract_templates via Kong REST
    TIER_JSON=$([ "$tier" = "null" ] && echo "null" || jq -Rn --arg t "$tier" '$t')
    UPSERT=$(jq -n \
      --arg slug "$slug" --arg name "$name" \
      --arg desc "DocuSeal ID $NEW_ID" \
      --argjson tier "$TIER_JSON" \
      --argjson dsid "$NEW_ID" \
      '{slug:$slug, version:1, name:$name, description:$desc, html_template:"(pdf in DocuSeal)", variables:[], tier_required:$tier, docuseal_template_id:$dsid, active:true}')

    UPSERT_STATUS=$(curl -s -o "$WORK/upsert.log" -w "%{http_code}" -X POST \
      -H "apikey: $SUPABASE_SVC" \
      -H "Authorization: Bearer $SUPABASE_SVC" \
      -H "Content-Type: application/json" \
      -H "Accept-Profile: purama_ai" \
      -H "Content-Profile: purama_ai" \
      -H "Prefer: resolution=merge-duplicates,return=minimal" \
      --data "$UPSERT" \
      "$SUPABASE_URL/rest/v1/contract_templates")
    if [ "$UPSERT_STATUS" = "201" ] || [ "$UPSERT_STATUS" = "204" ]; then
        log "  ✓ Supabase upserted (HTTP $UPSERT_STATUS)"
    else
        log "  ⚠ Supabase HTTP $UPSERT_STATUS: $(head -c 200 "$WORK/upsert.log")"
    fi

    RESULTS+="$slug → DocuSeal #$NEW_ID"$'\n'
done

log ""
log "=== RESULTS ==="
printf '%s\n' "$RESULTS"
log "✅ Done"

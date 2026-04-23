#!/usr/bin/env bash
# Generate 8 PDFs from HTML templates with tier variable substitution
set -euo pipefail

TEMPLATES_DIR="${TEMPLATES_DIR:-/docker/docuseal/templates}"
WORK=/tmp/docuseal-upload
mkdir -p "$WORK"

TEMPLATES=(
  "ambassadeur-bronze|ambassadeur.html|bronze|10|12"
  "ambassadeur-argent|ambassadeur.html|argent|15|12"
  "ambassadeur-or|ambassadeur.html|or|20|12"
  "ambassadeur-platine|ambassadeur.html|platine|25|24"
  "ambassadeur-eternel|ambassadeur.html|eternel|30|1200"
  "partenariat-business|partenariat-business.html|null|null|12"
  "territoire-purama|territoire-purama.html|null|null|36"
  "prestation-freelance|prestation-freelance.html|null|null|3"
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

for entry in "${TEMPLATES[@]}"; do
    IFS='|' read -r slug file tier rate months <<< "$entry"
    filepath="$TEMPLATES_DIR/$file"
    [ -f "$filepath" ] || { echo "MISSING $filepath"; exit 1; }

    rendered="$WORK/$slug.html"
    if [ "$tier" != "null" ]; then
        TIER_LBL=$(tier_label "$tier")
        sed \
            -e "s/{{tier_label}}/${TIER_LBL}/g" \
            -e "s/{{commission_rate}}/${rate}/g" \
            -e "s/{{duration_months}}/${months}/g" \
            "$filepath" > "$rendered"
    else
        cp "$filepath" "$rendered"
    fi

    wkhtmltopdf --quiet --encoding UTF-8 \
        --margin-top 15 --margin-bottom 15 --margin-left 15 --margin-right 15 \
        --enable-local-file-access \
        "$rendered" "$WORK/$slug.pdf" 2>/dev/null
    [ -s "$WORK/$slug.pdf" ] || { echo "FAIL $slug"; exit 2; }
    echo "✓ $slug.pdf ($(du -h "$WORK/$slug.pdf" | cut -f1))"
done

echo ""
echo "All 8 PDFs generated in $WORK"
ls -la "$WORK"/*.pdf

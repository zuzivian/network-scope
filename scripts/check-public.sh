#!/bin/sh
# Build the public bundle and fail if it contains anything from data/leak-terms.txt
# (a gitignored list of your own names, units and identifiers), or the full name of
# anyone in your local graph files (vault, WhatsApp, LinkedIn).
set -e
cd "$(dirname "$0")/.."
rm -rf dist
npx vite build --mode public >/dev/null
[ -f data/leak-terms.txt ] || { echo "No data/leak-terms.txt; add terms that must never ship."; exit 1; }
terms=$(mktemp)
cat data/leak-terms.txt > "$terms"
python3 -I - "$terms" <<'EOF'
import json, sys
from pathlib import Path
names = set()
for f in ("data/graph.json", "data/imported.json", "data/linkedin.json"):
    p = Path(f)
    if p.exists():
        names |= {x["name"] for x in json.loads(p.read_text())["people"] if len(x["name"].split()) > 1 and len(x["name"]) > 6}
with open(sys.argv[1], "a") as out:
    out.write("\n" + "\n".join(sorted(names)) + "\n")
EOF
sed -i "" "/^[[:space:]]*$/d" "$terms"
# The public repo's address is meant to ship (the privacy page links it). Remove exactly the strings in
# scripts/public-allow.txt from a scratch copy, then scan: every other appearance of a term still fails.
scan=$(mktemp -d)
trap 'rm -rf "$terms" "$scan"' EXIT
cp -R dist/. "$scan"
while IFS= read -r allow; do
  [ -n "$allow" ] && grep -rlF "$allow" "$scan" | while IFS= read -r f; do
    ALLOW="$allow" perl -0pi -e 's/\Q$ENV{ALLOW}\E//g' "$f"
  done
done < scripts/public-allow.txt
hits=$(cd "$scan" && grep -rio -F -f "$terms" . | sort | uniq -c || true)
if [ -n "$hits" ]; then echo "LEAK: public bundle contains private terms:"; echo "$hits"; exit 1; fi
echo "Public bundle clean ($(grep -c . "$terms") terms and names checked): dist/ is safe to deploy."

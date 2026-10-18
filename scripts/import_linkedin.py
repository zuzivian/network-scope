#!/usr/bin/env python3
"""Build data/linkedin.json from LinkedIn's Connections.csv (local mode).

What it keeps: names, company, position, connection date and profile URL.
Email addresses are dropped when the CSV is copied into data/linkedin/connections.csv.

People are matched to the vault (data/graph.json) and the WhatsApp import (data/imported.json)
by name, so a LinkedIn connection you already know joins the same dot. Companies are placed by
`linkedinOrgRules` in data/tag-map.json; any other company with 3+ connections becomes its own
context under Industry. Sort decisions in data/assignments.json win over both.

Run:  python3 -I scripts/import_linkedin.py [path/to/Connections.csv]
      (the path is only needed the first time, or to refresh from a newer export)
"""
from __future__ import annotations

import collections
import csv
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/linkedin/connections.csv"

# Shared helpers from the WhatsApp importer (loaded by path: -I keeps scripts/ off sys.path).
_spec = importlib.util.spec_from_file_location("import_whatsapp", ROOT / "scripts/import_whatsapp.py")
wa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(wa)
slug, same_person = wa.slug, wa.same_person

KEEP = ["First Name", "Last Name", "URL", "Company", "Position", "Connected On"]
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def read_export(path: Path) -> list[dict[str, str]]:
    """LinkedIn's file starts with a few 'Notes:' lines before the real header."""
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    at = next((i for i, l in enumerate(lines) if re.match(r'^\s*"?First Name"?\s*,', l)), None)
    if at is None:
        sys.exit(f"{path}: no 'First Name, Last Name, ...' header row; is this LinkedIn's Connections.csv?")
    return list(csv.DictReader(io.StringIO("\n".join(lines[at:]))))


def iso(d: str) -> str | None:
    m = re.match(r"(\d{1,2}) (\w{3})\w* (\d{4})", d or "")
    return f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m and m.group(2).lower() in MONTHS else None


def clean_name(first: str, last: str) -> str:
    """'Jane Doe, CFA' / 'Jane (She/Her) Doe' / emoji -> 'Jane Doe'."""
    n = f"{first} {last}"
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r",.*$", "", n)
    n = re.sub(r"[^\w\s'.-]", " ", n)
    return re.sub(r"\s+", " ", n).strip(" .-")


def main() -> None:
    if len(sys.argv) > 1:
        rows = read_export(Path(sys.argv[1]).expanduser())
        SRC.parent.mkdir(parents=True, exist_ok=True)
        with SRC.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, KEEP, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
    if not SRC.exists():
        sys.exit(f"No {SRC.relative_to(ROOT)} yet: pass the path to LinkedIn's Connections.csv once.")
    rows = list(csv.DictReader(SRC.open(encoding="utf-8")))

    cfg = json.loads((ROOT / "data/tag-map.json").read_text())
    me_names = {n.lower() for n in cfg.get("me_names", [])}
    aliases = cfg.get("aliases", {})
    rules = [(re.compile(r["match"], re.I), r["contexts"]) for r in cfg.get("linkedinOrgRules", [])]

    graph = json.loads((ROOT / "data/graph.json").read_text())
    imp_path = ROOT / "data/imported.json"
    imported = json.loads(imp_path.read_text()) if imp_path.exists() else {"people": [], "contexts": []}
    known = {p["id"]: p for p in imported["people"]} | {p["id"]: p for p in graph["people"]}
    by_slug = {slug(p["name"]): p["id"] for p in known.values()}
    ctx_ids = {c["id"] for c in graph["contexts"] + imported["contexts"] + cfg.get("contexts", [])}
    multi = [p for p in known.values() if len(p["name"].split()) > 1]

    apath = ROOT / "data/assignments.json"
    assign = json.loads(apath.read_text()) if apath.exists() else {}
    decisions: dict[str, dict] = assign.get("decisions", {})
    ctx_ids |= {c["id"] for c in assign.get("contexts", [])}
    cpath = ROOT / "data/contacts.json"
    roster = json.loads(cpath.read_text()) if cpath.exists() else []
    # A decision made on someone's WhatsApp card applies to their LinkedIn row too.
    decision_by_pid = {c["personId"]: decisions[c["key"]] for c in roster if c["key"] in decisions}
    roster_pids = {c["personId"] for c in roster} | {c["key"] for c in roster}

    fuzzy: dict[str, list[str]] = collections.defaultdict(list)

    def short_ok(a: str, b: str) -> bool:
        fa, fb = (re.sub(r"\W", "", x.split()[0].lower()) for x in (a, b))
        return fa == fb or wa.NICKNAMES.get(fa) == fb or wa.NICKNAMES.get(fb) == fa or min(len(fa), len(fb)) >= 4

    def match(name: str) -> str | None:
        if name in aliases:
            return aliases[name]
        w = name.split()
        for v in [name, " ".join(w[::-1])] if len(w) == 2 else [name]:
            if slug(v) in by_slug:
                return by_slug[slug(v)]
        # LinkedIn names are full names, so be stricter than WhatsApp: no first-initial matches,
        # nickname prefixes of 4+ letters only, and nothing that fits two people.
        if len(w) > 1:
            hits = [c for c in multi if same_person(name, c["name"], False) and short_ok(name, c["name"])]
            if len(hits) == 1:
                fuzzy[hits[0]["id"]].append(name)
                return hits[0]["id"]
        return None

    org_of = lambda r: (r.get("Company") or "").strip()
    company_n = collections.Counter(slug(org_of(r)) for r in rows if org_of(r))
    new_ctx: dict[str, dict] = {}

    def company_ctx(org: str) -> str:
        s = slug(org)
        cid = s if s not in ctx_ids or s in new_ctx else f"li-{s}"
        new_ctx.setdefault(cid, {"id": cid, "name": org, "parent": "industry"})
        return cid

    names = [clean_name(r.get("First Name", ""), r.get("Last Name", "")) for r in rows]
    matches = {n: match(n) for n in set(names) if n}  # first pass, so ambiguity is known before placing anyone
    people: dict[str, dict] = {}
    extra_roster: list[dict] = []
    stats = collections.Counter()
    for r, name in zip(rows, names):
        if not name or name.lower() in me_names:
            stats["skipped"] += 1
            continue
        org, role = org_of(r), (r.get("Position") or "").strip()
        hit = list(dict.fromkeys(c for rx, cs in rules if rx.search(f"{org} | {role}") for c in cs))
        found = matches[name]
        if found and len(fuzzy.get(found, [])) > 1:
            found = None  # two LinkedIn rows fit the same person: treat neither as them
        pid = found or slug(name)
        if pid in known and not found:
            pid = f"{pid}-li"  # same slug as someone in the vault, but not the same person
        key = slug(name)
        d = decisions.get(key) or decision_by_pid.get(pid) or {}
        if d.get("exclude"):
            stats["excluded"] += 1
            continue
        if d.get("contexts"):
            ctxs = d["contexts"]
        elif found:
            ctxs = hit  # already placed; only add contexts the rules are sure of
        else:
            ctxs = hit or ([company_ctx(org)] if org and company_n[slug(org)] >= 3 else ["industry"])
        stats["matched" if found else "new"] += 1
        connected = iso(r.get("Connected On", ""))
        p = people.setdefault(pid, {"id": pid, "name": name, "contexts": [], "closeness": 3})
        p["contexts"] = list(dict.fromkeys(p["contexts"] + ctxs))
        if org:
            p["org"] = org
        if role:
            p["role"] = role
        p["notes"] = " ".join(x for x in [f"LinkedIn connection since {connected}." if connected else "", r.get("URL", "")] if x)
        if not found and key not in roster_pids and pid not in roster_pids:
            extra_roster.append({
                "key": key, "name": name, "raw": name, "rank": None, "tags": [], "suggested": hit,
                "lastContact": None, "personId": pid, "inVault": False, "queue": "linkedin", "region": "unknown",
                "notion": None, "org": " · ".join(x for x in [org, role] if x) or None,
            })

    out = {"me": graph["me"], "contexts": list(new_ctx.values()), "people": list(people.values()), "links": []}
    (ROOT / "data/linkedin.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    (ROOT / "data/linkedin-contacts.json").write_text(json.dumps(extra_roster, indent=0, ensure_ascii=False))

    review = ["# LinkedIn import review", "", f"{len(rows)} rows: {stats['matched']} matched people you already had, "
              f"{stats['new']} new, {stats['excluded']} excluded by Sort decisions.", "",
              "## Matched by similar name (check these)", ""]
    review += [f"- {n} → {known[pid]['name']}" for pid, ns in sorted(fuzzy.items()) if len(ns) == 1 for n in ns]
    review += ["", "## Not merged: several LinkedIn rows fit one person", ""]
    review += [f"- {', '.join(ns)} ↔ {known[pid]['name']}" for pid, ns in sorted(fuzzy.items()) if len(ns) > 1]
    review += ["", "## Company contexts created (3+ connections, no rule)", ""]
    review += [f"- {c['name']} ({company_n[slug(c['name'])]})" for c in new_ctx.values()]
    unplaced = collections.Counter(org_of(r) for r in rows if org_of(r) and company_n[slug(org_of(r))] < 3
                                   and not any(rx.search(org_of(r)) for rx, _ in rules))
    review += ["", "## Companies with 1–2 connections (placed under Industry)", "", f"{len(unplaced)} companies."]
    (ROOT / "data/linkedin-review.md").write_text("\n".join(review) + "\n")

    per_ctx = collections.Counter(c for p in people.values() for c in p["contexts"])
    print(f"{len(people)} LinkedIn people ({stats['matched']} matched, {stats['new']} new), {len(new_ctx)} company contexts")
    print("per context:", ", ".join(f"{c}×{n}" for c, n in per_ctx.most_common(15)))


if __name__ == "__main__":
    sys.exit(main())

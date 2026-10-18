#!/usr/bin/env python3
"""Build data/linkedin.json from LinkedIn's Connections.csv (local mode).

What it keeps: names, company, position, connection date and profile URL.
Email addresses are dropped when the CSV is copied into data/linkedin/connections.csv.

People are matched to the vault (data/graph.json) and the WhatsApp import (data/imported.json)
by name, so a LinkedIn connection you already know joins the same dot. Everyone else is placed by
the strongest evidence available, and the reason is kept on the person:

  1. a Sort decision (data/assignments.json)
  2. your phone contacts: the same person's contact-name tags (data/contacts.json)
  3. Notion: your Classmate Network
  4. their company or title naming one of your schools or employers (`linkedinOrgRules`, plus
     the organisations in your own LinkedIn education.csv / positions.csv)
  5. when you connected: during a past school period (from education.csv) and not during a job
  6. otherwise Industry, with a company context when 3+ connections share it

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


def parse_when(s: str, end: bool, school: bool) -> str | None:
    """'2015' / 'Nov 2023' -> ISO date. Year-only school dates mean the academic year (Aug start, Jun end)."""
    s = (s or "").strip()
    m = re.fullmatch(r"(\w{3})\w* (\d{4})", s)
    if m and m.group(1).lower() in MONTHS:
        mo, y = MONTHS[m.group(1).lower()], int(m.group(2))
        return f"{y}-{mo:02d}-{28 if end else 1:02d}"
    if re.fullmatch(r"\d{4}", s):
        return f"{s}-{'06-30' if end else '08-01'}" if school else f"{s}-{'12-31' if end else '01-01'}"
    return None


def own_timeline(rules) -> tuple[list[dict], list[tuple[str, list[str]]]]:
    """Your own education.csv / positions.csv (copied from the LinkedIn export) as dated phases."""
    phases, orgs = [], []
    for fname, col, start, end, school in (("education.csv", "School Name", "Start Date", "End Date", True),
                                           ("positions.csv", "Company Name", "Started On", "Finished On", False)):
        f = SRC.parent / fname
        if not f.exists():
            continue
        for r in csv.DictReader(f.open(encoding="utf-8-sig")):
            org = (r.get(col) or "").strip()
            ctxs = list(dict.fromkeys(c for rx, cs in rules if rx.search(org) for c in cs))
            if org and ctxs:
                orgs.append((org, ctxs))
            a, b = parse_when(r.get(start, ""), False, school), parse_when(r.get(end, ""), True, school)
            if org and a:
                phases.append({"org": org, "contexts": ctxs, "start": a, "end": b or "9999-12-31", "school": school})
    return phases, orgs


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
    # Your phone contacts, by name: their tags already say where you know them from.
    roster_ctx: dict[str, list[str]] = collections.defaultdict(list)
    for c in roster:
        if c.get("suggested"):
            for v in {slug(c["name"]), slug(" ".join(c["name"].split()[::-1]))}:
                roster_ctx[v] = list(dict.fromkeys(roster_ctx[v] + c["suggested"]))
    roster_multi = [c for c in roster if c.get("suggested") and len(c["name"].split()) > 1]

    # Notion Classmate Network: people from your programme.
    classmates: set[str] = set()
    npath = ROOT / "data/notion/classmate-network.json"
    for r in (json.loads(npath.read_text()) if npath.exists() else []):
        n = re.sub(r"\s*\([^)]*\)", "", r.get("Name") or "").strip()
        if n:
            classmates |= {slug(n), slug(" ".join(n.split()[::-1]))}
    classmate_ctx = next((r["context"] for r in cfg.get("whereMet", []) if re.search(r["match"], "classmate", re.I)), None)

    phases, own_orgs = own_timeline(rules)
    today = __import__("datetime").date.today().isoformat()
    # Past school periods place people you connected with then, unless you were also in a job.
    school_windows = [ph for ph in phases if ph["school"] and ph["contexts"] and ph["end"] < today]
    job_windows = [ph for ph in phases if not ph["school"]]
    own_org_slugs = [(slug(o), cs) for o, cs in own_orgs]

    def from_roster(name: str) -> list[str]:
        w = name.split()
        for v in [name, " ".join(w[::-1])]:
            if roster_ctx.get(slug(v)):
                return roster_ctx[slug(v)]
        if len(w) > 1:
            hits = [c for c in roster_multi if same_person(name, c["name"], False) and short_ok(name, c["name"])]
            if len({tuple(c["suggested"]) for c in hits}) == 1:
                return hits[0]["suggested"]
        return []

    def from_dates(connected: str | None) -> tuple[list[str], str]:
        if not connected:
            return [], ""
        if any(ph["start"] <= connected <= ph["end"] for ph in job_windows):
            return [], ""
        hits = [ph for ph in school_windows if ph["start"] <= connected <= ph["end"]]
        if len({tuple(ph["contexts"]) for ph in hits}) != 1:
            return [], ""
        return hits[0]["contexts"], hits[0]["org"]

    def guess(connected: str | None) -> list[str]:
        """Weak evidence for Sort only: where you were when you connected (a current school counts too)."""
        if not connected:
            return []
        here = [ph for ph in phases if ph["contexts"] and ph["start"] <= connected <= ph["end"]]
        here.sort(key=lambda ph: not ph["school"])  # a school you were at outranks a job held at the same time
        return here[0]["contexts"] if here else []
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
    reasons = collections.Counter()
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
        connected = iso(r.get("Connected On", ""))
        own = [c for o, cs in own_org_slugs if o and o in slug(f"{org} {role}") for c in cs]
        hit = list(dict.fromkeys(hit + own))
        why = ""
        if d.get("contexts"):
            ctxs, why = d["contexts"], "your Sort decision"
        elif found:
            ctxs = hit  # already placed; only add contexts the rules are sure of
        elif (rc := from_roster(name)):
            ctxs, why = rc, "the tags on their phone contact"
        elif key in classmates and classmate_ctx:
            ctxs, why = [classmate_ctx], "your Notion Classmate Network"
        elif hit:
            ctxs, why = hit, f"their company or title ({org or role})"
        elif (dc := from_dates(connected))[0]:
            ctxs, why = dc[0], f"connecting on {connected}, while you were at {dc[1]}"
        else:
            ctxs = [company_ctx(org)] if org and company_n[slug(org)] >= 3 else ["industry"]
            why = "no evidence beyond their current company"
        stats["matched" if found else "new"] += 1
        if not found:
            reasons[why.split(" (")[0].split(" on ")[0]] += 1
        p = people.setdefault(pid, {"id": pid, "name": name, "contexts": [], "closeness": 3})
        p["contexts"] = list(dict.fromkeys(p["contexts"] + ctxs))
        if org:
            p["org"] = org
        if role:
            p["role"] = role
        p["notes"] = " ".join(x for x in [f"LinkedIn connection since {connected}." if connected else "",
                                          f"Placed by {why}." if why and not found else "", r.get("URL", "")] if x)
        if not found and key not in roster_pids and pid not in roster_pids:
            extra_roster.append({
                "key": key, "name": name, "raw": name, "rank": None, "tags": [], "suggested": ctxs if why.startswith(("connecting", "their")) else hit or guess(connected),
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
    review += ["", "## How new people were placed", ""]
    review += [f"- {n} × {w}" for w, n in reasons.most_common()]
    review += ["", "## Your timeline (from education.csv / positions.csv)", ""]
    review += [f"- {ph['org']}: {ph['start']} → {ph['end']} → {', '.join(ph['contexts']) or '(no context)'}" for ph in phases]
    review += ["", "## Company contexts created (3+ connections, no rule)", ""]
    review += [f"- {c['name']} ({company_n[slug(c['name'])]})" for c in new_ctx.values()]
    unplaced = collections.Counter(org_of(r) for r in rows if org_of(r) and company_n[slug(org_of(r))] < 3
                                   and not any(rx.search(org_of(r)) for rx, _ in rules))
    review += ["", "## Companies with 1–2 connections (placed under Industry)", "", f"{len(unplaced)} companies."]
    (ROOT / "data/linkedin-review.md").write_text("\n".join(review) + "\n")

    per_ctx = collections.Counter(c for p in people.values() for c in p["contexts"])
    print(f"{len(people)} LinkedIn people ({stats['matched']} matched, {stats['new']} new), {len(new_ctx)} company contexts")
    print("placed by:", ", ".join(f"{w} ×{n}" for w, n in reasons.most_common()))
    print("per context:", ", ".join(f"{c}×{n}" for c, n in per_ctx.most_common(15)))


if __name__ == "__main__":
    sys.exit(main())

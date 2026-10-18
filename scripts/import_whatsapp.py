#!/usr/bin/env python3
"""Build data/imported.json from WhatsApp Desktop's local databases (read-only).

What it reads, and nothing else:
  - ContactsV2.sqlite: contact display names (your address book as WhatsApp sees it)
  - ChatStorage.sqlite: group names, group member lists, last-message *dates* of 1:1 chats
Message text is never read. Phone numbers and WhatsApp IDs are used only in memory
to join tables and are never written out.

Tags in contact names ("MAJ Alex Rivera 140", "Lena … GSB'28 NU'21") place people in
contexts via data/tag-map.json. Small WhatsApp groups map to contexts via the same file.
Anything not in the map is listed in data/import-review.md for a human to decide.

Run:  python3 -I scripts/import_whatsapp.py
"""
from __future__ import annotations

import collections
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WA = Path.home() / "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
APPLE_EPOCH = 978307200

RANKS = {
    "REC", "PTE", "LCP", "CPL", "CFC", "3SG", "2SG", "1SG", "SSG", "MSG", "3WO", "2WO", "1WO", "MWO", "SWO", "CWO",
    "OCT", "2LT", "LTA", "CPT", "MAJ", "LTC", "SLTC", "COL", "BG", "MG", "LG",
    "ME1", "ME1T", "ME2", "ME3", "ME4", "ME5", "ME6", "ME7", "ME8",
}


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def split_name(raw: str, known_tags: set[str]) -> tuple[str, list[str], str | None]:
    """'MAJ Theo Marsh 140/142' -> ('Theo Marsh', ['140', '142'], 'MAJ')."""
    text = raw.replace("’", "'").replace("_", " ")
    tags, rank, keep = [], None, []
    for tok in re.findall(r"\([^)]*\)|\S+", text):
        bare = tok.strip("()[],")
        parts = re.split(r"[/]", bare) if "/" in bare and re.search(r"\d", bare) else [bare]
        is_tag = False
        for p in parts:
            up = p.upper()
            if up in RANKS and rank is None:
                rank, is_tag = up, True
            elif (p in known_tags or up in known_tags or re.fullmatch(r"[A-Z0-9&'.+-]{2,}|\d{2,}[A-Za-z]*", p)
                  or re.fullmatch(r"(GSB|NU|MSx|Partner)'?\d{2}", p, re.I) or p.lower() in {"bravo", "alpha", "charlie"}):
                tags.append(p)
                is_tag = True
        if tok.startswith("("):
            tags.extend(t for t in re.split(r"[\s/]+", bare) if t)
            is_tag = True
        if not is_tag:
            keep.append(tok)
    name = re.sub(r"\s+", " ", " ".join(keep)).strip(" -,")
    # "Joseph Joseph Ward" (underscore artefact) -> "Joseph Ward"
    words = name.split()
    name = " ".join(w for i, w in enumerate(words) if i == 0 or w.lower() != words[i - 1].lower())
    return name, tags, rank


NICKNAMES = {"joe": "joseph", "mike": "michael", "dom": "dominique", "dave": "david", "nick": "nicholas",
             "ben": "benjamin", "alex": "alexander", "sam": "samuel", "tash": "natasha", "din": "nadine"}


def same_person(a: str, b: str, rare_surname: bool) -> bool:
    """Conservative: contact name a vs vault name b."""
    wa, wb = a.lower().replace('"', "").split(), b.lower().replace('"', "").split()
    if len(wa) < 2 or len(wb) < 2:
        return False
    fa, fb = re.sub(r"\W", "", wa[0]), re.sub(r"\W", "", wb[0])
    if wa[-1] != wb[-1]:
        # One-letter surname typo, only with an identical first name ("Yudhistra" vs "Yudhistira").
        import difflib
        close = len(wa[-1]) >= 6 and difflib.SequenceMatcher(None, wa[-1], wb[-1]).ratio() >= 0.9
        return close and fa == fb
    if fa == fb or NICKNAMES.get(fa) == fb or NICKNAMES.get(fb) == fa:
        return True
    if min(len(fa), len(fb)) >= 3 and (fa.startswith(fb) or fb.startswith(fa)):
        return True
    return rare_surname and fa[0] == fb[0]


def tag_key(t: str) -> str:
    t = t.replace("’", "'")
    m = re.fullmatch(r"(GSB|NU|MSx|Partner)'?(\d{2})", t, re.I)
    if m:
        return m.group(1).upper() + "'"
    return t.upper()


def main() -> None:
    cfg = json.loads((ROOT / "data/tag-map.json").read_text())
    tag_map: dict[str, list[str]] = {k.upper(): v for k, v in cfg["tags"].items()}
    group_map: dict[str, str] = cfg["groups"]
    new_contexts = cfg.get("contexts", [])
    me_names = {n.lower() for n in cfg.get("me_names", [])}
    known = set(tag_map)

    graph = json.loads((ROOT / "data/graph.json").read_text())
    existing = {p["id"]: p for p in graph["people"]}
    existing_by_name = {slug(p["name"]): p["id"] for p in graph["people"]}
    by_last = collections.defaultdict(list)
    for p in graph["people"]:
        by_last[p["name"].split()[-1].lower()].append(p)

    contacts = ro(WA / "ContactsV2.sqlite").execute(
        "SELECT ZFULLNAME, ZWHATSAPPID, ZLID FROM ZWAADDRESSBOOKCONTACT WHERE ZFULLNAME IS NOT NULL").fetchall()

    # macOS Contacts (needs Full Disk Access): company and job title are extra tags, and
    # contacts that aren't on WhatsApp join the roster. Notes are never read.
    org_of: dict[str, str] = {}
    ab_region: dict[str, str] = {}
    ab_only: list[tuple[str, None, None]] = []
    org_rules = [(re.compile(r["match"], re.I), r["contexts"]) for r in cfg.get("orgRules", [])]
    try:
        import glob
        wa_names = {slug(r[0]) for r in contacts}
        for f in glob.glob(str(Path.home() / "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb")):
            ab = ro(Path(f))
            phones = {}
            for owner, num in ab.execute("SELECT ZOWNER, ZFULLNUMBER FROM ZABCDPHONENUMBER"):
                n = re.sub(r"[^0-9+]", "", num or "")
                phones.setdefault(owner, "sg" if n.startswith("+65") or (len(n) == 8 and n[0] in "689") else "us" if n.startswith("+1") else "other")
            for pk, first, middle, last, org, title in ab.execute(
                    "SELECT Z_PK, ZFIRSTNAME, ZMIDDLENAME, ZLASTNAME, ZORGANIZATION, ZJOBTITLE FROM ZABCDRECORD WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL"):
                full = " ".join(x for x in (first, middle, last) if x)
                short = " ".join(x for x in (first, last) if x)
                extra = " ".join(x for x in (org, title) if x and not re.search(r"\+?\d{8,}", x))
                for k in {slug(full), slug(short)}:
                    if extra:
                        org_of[k] = extra
                    ab_region[k] = phones.get(pk, "unknown")
                if slug(full) not in wa_names and slug(short) not in wa_names:
                    ab_only.append((full, None, None))
    except sqlite3.OperationalError:
        pass  # no Full Disk Access: WhatsApp's copy only
    contacts = contacts + ab_only
    chat = ro(WA / "ChatStorage.sqlite")
    last_1to1 = {jid: d for jid, d in chat.execute(
        "SELECT ZCONTACTJID, ZLASTMESSAGEDATE FROM ZWACHATSESSION WHERE ZSESSIONTYPE=0 AND ZLASTMESSAGEDATE IS NOT NULL")}
    groups = {pk: name for pk, name in chat.execute("SELECT Z_PK, ZPARTNERNAME FROM ZWACHATSESSION WHERE ZSESSIONTYPE=1")}
    push = {j: n for j, n in chat.execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME WHERE ZPUSHNAME <> ''")}
    members = collections.defaultdict(list)
    for sess, jid, cname in chat.execute(
            "SELECT ZCHATSESSION, ZMEMBERJID, ZCONTACTNAME FROM ZWAGROUPMEMBER WHERE ZISACTIVE=1"):
        members[sess].append((jid, cname or push.get(jid)))

    def iso(d):
        import datetime
        return datetime.datetime.utcfromtimestamp(d + APPLE_EPOCH).date().isoformat() if d else None

    cleaned = [(raw, *split_name(raw, known)) for raw, _, _ in contacts]
    surname_count = collections.Counter(n.split()[-1].lower() for _, n, _, _ in cleaned if n and len(n.split()) > 1)
    surname_count.update(p["name"].split()[-1].lower() for p in graph["people"] if len(p["name"].split()) > 1)

    aliases = cfg.get("aliases", {})

    def match_existing(name: str):
        if name in aliases:
            return aliases[name]
        hit = existing_by_name.get(slug(name))
        if hit:
            return hit
        last = name.split()[-1].lower() if len(name.split()) > 1 else None
        for cand in [c for c in graph["people"] if len(c["name"].split()) > 1]:
            if same_person(name, cand["name"], surname_count[last] <= 2):
                merged.append((name, cand["name"]))
                return cand["id"]
        return None

    merged: list[tuple[str, str]] = []

    # ---- decisions from the Sort screen (data/assignments.json) ----
    apath = ROOT / "data/assignments.json"
    assign = json.loads(apath.read_text()) if apath.exists() else {}
    decisions: dict[str, dict] = assign.get("decisions", {})
    new_contexts = new_contexts + [c for c in assign.get("contexts", []) if c["id"] not in {x["id"] for x in new_contexts}]

    # ---- Notion: who you've actually met (Classmate Network + Networking Tracker) ----
    def variants(n: str) -> set[str]:
        """'Nivedita (Nivi) Shukla' -> {nivedita-shukla, nivi-shukla, shukla-nivedita, ...}"""
        nick = re.search(r"\(([^)]+)\)", n)
        base = re.sub(r"\s*\([^)]*\)", "", n).strip()
        out = {slug(base)}
        w = base.split()
        if len(w) == 2:
            out.add(slug(f"{w[1]} {w[0]}"))
        if nick and len(w) >= 2:
            out.add(slug(f"{nick.group(1)} {w[-1]}"))
        return out
    notion_met: dict[str, str] = {}
    for f, met in (("classmate-network", lambda r: (r.get("Status") or "") != "Not Yet Met" and (r.get("Status") or r.get("Last Met"))),
                   ("networking-tracker", lambda r: r.get("Last Contacted") or r.get("Status") in ("Had Chat", "Meeting complete", "Following Up"))):
        fp = ROOT / f"data/notion/{f}.json"
        if fp.exists():
            for r in json.loads(fp.read_text()):
                if r.get("Name") and met(r):
                    for v in variants(r["Name"]):
                        notion_met.setdefault(v, r["Name"])
    region = {}
    for _, wa_id, lid in contacts:
        n = (wa_id or "").split("@")[0]
        region[wa_id or lid] = "sg" if n.startswith("65") else "us" if n.startswith("1") else "other" if n else "unknown"

    # ---- every contact, with a suggestion and a queue ----
    people: dict[str, dict] = {}
    jid_to_id: dict[str, str] = {}
    unmapped = collections.Counter()
    unmapped_examples = collections.defaultdict(list)
    maybe_same = []
    roster: dict[str, dict] = {}
    for raw, wa_id, lid in contacts:
        name, tags, rank = split_name(raw, known)
        if not name or name.lower() in me_names:
            continue
        key = slug(raw)
        ctxs, gsb_only = [], True
        org = org_of.get(slug(raw)) or org_of.get(slug(name))
        if org:
            hit = [c for rx, cs in org_rules if rx.search(org) for c in cs]
            if hit:
                ctxs += hit
                gsb_only = gsb_only and set(hit) <= {"gsb"}
            else:
                _, otags, orank = split_name(f"x {org}", known)
                tags = tags + [t for t in otags if t not in tags]
                rank = rank or orank
        expanded = []
        for t in tags:
            k = tag_key(t)
            parts = [tag_key(x) for x in re.split(r"[-/]", t) if x] if k not in tag_map else [k]
            expanded += parts if any(x in tag_map for x in parts) else [k]
        for k in expanded:
            if k in tag_map:
                ctxs += tag_map[k]
                if not tag_map[k] or tag_map[k][0] != "gsb":
                    gsb_only = False
            elif k not in RANKS:
                unmapped[k] += 1
                if len(unmapped_examples[k]) < 3:
                    unmapped_examples[k].append(name)
        if rank and not any(c != "gsb" for c in ctxs):
            ctxs.append("saf")
            gsb_only = False
        ctxs = list(dict.fromkeys(ctxs))
        notion_name = next((notion_met[v] for v in variants(name) if v in notion_met), None)
        pid = match_existing(name) or (slug(re.sub(r"\s*\([^)]*\)", "", notion_name)) if notion_name else None) or slug(name)
        if notion_name and notion_name != name and pid == slug(re.sub(r"\s*\([^)]*\)", "", notion_name)):
            pid = slug(notion_name)  # same id the app derives from the Notion row
        if pid in existing and not match_existing(name):
            pid = f"{pid}-wa"  # a contact whose slug merely collides with a vault id is someone else
        last = max(filter(None, [last_1to1.get(wa_id), last_1to1.get(lid)]), default=None)
        reg = region.get(wa_id or lid) or ab_region.get(slug(raw)) or ab_region.get(slug(name)) or "unknown"

        if notion_name and (not ctxs or set(ctxs) <= {"gsb"}):
            ctxs = list(dict.fromkeys(ctxs + ["gsb"]))
            queue = "placed"
        elif any(c not in ("saf", "gsb") for c in ctxs):
            queue = "placed"
        elif "saf" in ctxs:
            queue = "saf"
        elif ctxs:
            queue = "gsb"
        else:
            queue = "sg" if reg == "sg" else "elsewhere"
        if key not in roster:
            roster[key] = {"key": key, "name": name, "raw": raw, "rank": rank, "tags": [t for t in tags if t.upper() != (rank or "")],
                           "suggested": ctxs, "lastContact": iso(last), "personId": pid, "inVault": pid in existing, "queue": queue,
                           "region": reg, "notion": notion_name, "org": org}

        d = decisions.get(key, {})
        if d.get("exclude"):
            for j in (wa_id, lid):
                if j:
                    jid_to_id[j] = "!x"
            continue
        if d.get("contexts"):
            ctxs, gsb_only = d["contexts"], False
        if not ctxs:
            continue
        # GSB-only contacts come from a classmate import; keep only people you actually talk to.
        if gsb_only and pid not in existing and not last and not notion_name:
            for j in (wa_id, lid):
                if j:
                    jid_to_id[j] = f"?{pid}|{name}"
            continue
        p = people.setdefault(pid, {"id": pid, "name": name, "contexts": [], "closeness": 3, "source": "WhatsApp contacts"})
        p["contexts"] = list(dict.fromkeys(p["contexts"] + ctxs)) if not d.get("contexts") else list(dict.fromkeys(d["contexts"]))
        if d.get("closeness"):
            p["closeness"] = d["closeness"]
        if rank:
            p["role"] = rank
        if last:
            p["lastContact"] = max(p.get("lastContact") or "", iso(last))
        for j in (wa_id, lid):
            if j:
                jid_to_id[j] = pid
        if pid not in existing and len(name.split()) == 1:
            for cand in graph["people"]:
                if cand["name"].split()[0].lower() == name.lower() and len(cand["name"].split()) == 1:
                    maybe_same.append((name, cand["name"]))

    (ROOT / "data/contacts.json").write_text(json.dumps(list(roster.values()), indent=0, ensure_ascii=False))

    # ---- small groups -> contexts ----
    group_hits = []
    unmapped_groups = []
    for pk, gname in groups.items():
        target = next((v for k, v in group_map.items() if (gname or "").startswith(k)), None)
        if not target:
            if 2 < len(members[pk]) <= 30:
                unmapped_groups.append((gname or "(unnamed)", len(members[pk])))
            continue
        small = len(members[pk]) <= 30
        n = 0
        for jid, cname in members[pk]:
            ref = jid_to_id.get(jid)
            if ref is None and cname and small:
                nm, _, _ = split_name(cname, known)
                ref = f"?{slug(nm)}|{nm}" if nm and nm.lower() not in me_names else None
            if not ref or ref == "!x":
                continue
            if ref.startswith("?"):
                if not small:
                    continue
                pid, nm = ref[1:].split("|", 1)
                ref = pid
                people.setdefault(pid, {"id": pid, "name": nm, "contexts": [], "closeness": 3, "source": "WhatsApp groups"})
            people[ref]["contexts"] = list(dict.fromkeys(people[ref]["contexts"] + [target]))
            n += 1
        group_hits.append((gname, target, n))

    # ---- intro groups: "A <> B" with 3 members = you, introducer, introducee ----
    all_names = {}
    for (raw, wa_id, lid), (_, nm, _, _) in zip(contacts, cleaned):
        for j in (wa_id, lid):
            if j and nm:
                all_names[j] = nm
    links = []
    for pk, gname in groups.items():
        if gname and "<>" in gname and len(members[pk]) <= 3:
            ids = []
            for j, cname in members[pk]:
                ref = jid_to_id.get(j)
                if ref == "!x":
                    continue
                if not ref or ref.startswith("?"):
                    nm = all_names.get(j) or (split_name(cname, known)[0] if cname else None)
                    if not nm or nm.lower() in me_names:
                        continue
                    ref = match_existing(nm) or slug(nm)
                    if ref not in existing and ref not in people:
                        people[ref] = {"id": ref, "name": nm, "contexts": [], "closeness": 3, "source": "WhatsApp intro group"}
                ids.append(ref)
            if len(ids) == 2:
                links.append({"a": ids[0], "b": ids[1], "kind": "intro", "label": f"WhatsApp intro group “{gname}”"})

    out = {"me": graph["me"], "contexts": new_contexts, "people": list(people.values()), "links": links}
    (ROOT / "data/imported.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))

    # ---- review report ----
    lines = ["# Import review", "", f"{len(people)} people imported. Tags below are not in `data/tag-map.json` yet.", "",
             "## Unmapped tags", "", "| Tag | Contacts | Examples |", "|---|---|---|"]
    for t, c in unmapped.most_common():
        lines.append(f"| {t} | {c} | {', '.join(unmapped_examples[t])} |")
    lines += ["", "## Groups mapped", "", "| Group | Context | Members placed |", "|---|---|---|"]
    lines += [f"| {g} | {t} | {n} |" for g, t, n in sorted(group_hits, key=lambda x: x[1])]
    lines += ["", "## Small groups not mapped (3–30 members)", "", "| Group | Members |", "|---|---|"]
    lines += [f"| {g} | {n} |" for g, n in sorted(unmapped_groups, key=lambda x: -x[1])]
    lines += ["", "## Merged into vault people", ""]
    lines += [f"- {a} → {b}" for a, b in sorted(set(merged))]
    lines += ["", "## Possibly the same person as a vault entry (not merged)", ""]
    lines += [f"- {a} ↔ {b}" for a, b in sorted(set(maybe_same))]
    (ROOT / "data/import-review.md").write_text("\n".join(lines) + "\n")

    per_ctx = collections.Counter(c for p in people.values() for c in p["contexts"])
    print(f"{len(people)} people, {len(links)} intro links, {sum(unmapped.values())} unmapped tag uses ({len(unmapped)} distinct)")
    print("per context:", ", ".join(f"{c}×{n}" for c, n in per_ctx.most_common()))


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Cleanup script: walk v<N>/<slug>/ folders, extract the chromestatus feature
ID from each index.html, then build a name map from the chromestatus milestone
listings (the names shown in the listing are what the server uses when it
slugifies). Rename folders to match. Folders without an embedded chromestatus
ID get deleted."""

import json
import os
import re
import shutil
import sys
import unicodedata
import urllib.request

def slugify(s):
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:80]

XSSI = b")]}'"

def get_json(url):
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        body = resp.read()
    if body.startswith(XSSI):
        body = body[len(XSSI):].lstrip()
    return json.loads(body)

ID_RE = re.compile(r"chromestatus\.com/feature/(\d+)")

SEEDS = {
    "gendn": {("v149", "css-gap-decorations"), ("v149", "webmcp")},
    "chrome-platform-showcase": set(),
}

# Build a map: (mstone, feature_id) -> name as shown in that milestone's listing.
def listing_names(milestones):
    out = {}
    for m in milestones:
        try:
            data = get_json(f"https://chromestatus.com/api/v0/features?milestone={m}")
        except Exception as e:
            print(f"  ! could not fetch milestone {m}: {e}", file=sys.stderr)
            continue
        for cat, feats in (data.get("features_by_type") or {}).items():
            for f in feats:
                out[(m, int(f["id"]))] = f["name"]
    return out

def cleanup(project_root, project_name):
    seeds = SEEDS.get(project_name, set())
    summary = {"renamed": [], "kept_unchanged": [], "deleted_no_id": [],
               "skipped_seed": [], "deleted_orphan": [], "deleted_overwritten": []}

    # Discover which milestones to look up (just the v<N>/ folders we see).
    milestones = []
    for entry in sorted(os.listdir(project_root)):
        if re.match(r"^v\d+$", entry) and os.path.isdir(os.path.join(project_root, entry)):
            milestones.append(int(entry[1:]))
    if not milestones:
        return summary
    name_map = listing_names(milestones)

    for entry in sorted(os.listdir(project_root)):
        if not re.match(r"^v\d+$", entry):
            continue
        mstone = int(entry[1:])
        mdir = os.path.join(project_root, entry)
        for slug in sorted(os.listdir(mdir)):
            folder = os.path.join(mdir, slug)
            if not os.path.isdir(folder):
                continue
            index = os.path.join(folder, "index.html")
            if not os.path.isfile(index):
                continue

            key = (entry, slug)
            if key in seeds:
                summary["skipped_seed"].append(f"{entry}/{slug}")
                continue

            try:
                with open(index, "r", encoding="utf-8") as f:
                    html = f.read()
            except Exception as e:
                print(f"  ! could not read {index}: {e}", file=sys.stderr)
                continue

            m = ID_RE.search(html)
            if not m:
                print(f"  - no chromestatus ID in {entry}/{slug}, deleting")
                shutil.rmtree(folder)
                summary["deleted_no_id"].append(f"{entry}/{slug}")
                continue

            fid = int(m.group(1))
            name = name_map.get((mstone, fid))
            if not name:
                # Not in this milestone's listing — feature doesn't actually
                # belong here. Delete; the routine will rebuild for the right
                # milestone if it's still relevant.
                print(f"  - {entry}/{slug}: feature {fid} not listed under v{mstone}, deleting")
                shutil.rmtree(folder)
                summary["deleted_orphan"].append(f"{entry}/{slug} (id {fid})")
                continue

            canonical = slugify(name)

            if canonical == slug:
                summary["kept_unchanged"].append(f"{entry}/{canonical}")
                continue

            target = os.path.join(mdir, canonical)
            if os.path.exists(target):
                print(f"  ! target already exists: {target}; removing duplicate {folder}")
                shutil.rmtree(folder)
                summary["deleted_overwritten"].append(f"{entry}/{slug} -> {entry}/{canonical}")
                continue

            shutil.move(folder, target)
            summary["renamed"].append(f"{entry}: {slug} -> {canonical}")

    return summary

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: fix-slugs.py <project_root> <project_name>")
        sys.exit(1)
    project_root, project_name = sys.argv[1], sys.argv[2]
    os.chdir(project_root)
    s = cleanup(".", project_name)
    print("\n=== summary ===")
    for k, lst in s.items():
        print(f"{k}: {len(lst)}")
        for line in lst[:50]:
            print(f"  {line}")

// CORPUS CITATION LINKS — the unlinked-citation ratchet (gendn-t7h).
//
// AGENTS.md:91 requires every visible source/citation label to link directly to the
// original public artifact; AGENTS.md:103 requires resolving a page's unlinked
// citations when you touch it. Nothing enforced either, so the corpus drifted
// (measured 2026-10-07: 212 unlinked citation spans corpus-wide, all pre-existing).
//
// Coord's non-negotiable constraint: do NOT red the tree on pre-existing labels in
// UNTOUCHED pages before a corpus-wide fix exists. This check is therefore a RATCHET,
// gated to pages changed in the diff vs the merge-base (the repo's existing pattern:
// check-conformance.mjs enforces ok/unsupported only for TOUCHED pages). A changed
// page that RETAINS a pre-existing unlinked label FAILS — that is AGENTS.md:103 made
// mechanical at touch time. `--all` is a report-only mode for the separate
// corpus-wide cleanup item; it never exits non-zero.
//
// Companion assertion (offline, non-flaky, corpus-wide in BOTH modes): every
// chromestatus.com/feature/<id> href must carry a full-length id (>= 15 digits).
// During B1 an id was silently truncated to 12 digits; every derived link would have
// 404'd and validate-artifacts, the pin fixture, check-routes and the page-suite
// rollup all passed. Zero pre-existing truncations measured 2026-10-07 (788 ids), so
// this assertion is safe corpus-wide. A URL-existence check is deliberately NOT done
// here (network, flakiness) — shape is the offline substitute.
//
// Detection is false-positive-shy by design:
//   • <span class="citation">…</span> whose content contains no <a href.
//   • A prose "Source: …" label OUTSIDE citation spans / pre / code blocks whose
//     label run carries a source-like token (domain, chromestatus, MDN, blink, W3C,
//     RFC n, Intent) and no immediate <a href. Plain prose uses of the word
//     "Source:" without a source-like token are not flagged.

const PAGE_RE = /^(v\d+\/[^/]+)\/index\.html$/;
const CS_ID_MIN_LEN = 15;

async function runGit(args, cwd = ".") {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "null",
  });
  const { code, stdout } = await cmd.output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

async function git(args, cwd = ".") {
  const { code, stdout } = await runGit(args, cwd);
  return code === 0 ? stdout : null;
}

/** Unlinked citation labels in one page's HTML. Pure; exported for the fixture. */
export function detectUnlinkedLabels(html) {
  const out = [];
  for (const m of html.matchAll(/<span class="citation"[^>]*>([\s\S]*?)<\/span>/g)) {
    if (!/<a\s+href/i.test(m[1])) {
      out.push({
        kind: "citation-span",
        label: m[1].replace(/\s+/g, " ").trim().slice(0, 100),
      });
    }
  }
  // prose pass: citation spans, pre and code blocks are removed first
  const stripped = html
    .replace(/<span class="citation"[^>]*>[\s\S]*?<\/span>/g, " ")
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<code[\s\S]*?<\/code>/g, " ");
  for (const m of stripped.matchAll(/Source\s*:\s*(<a\s+href|[^<\n]{0,120})/gi)) {
    const run = m[1];
    if (/^<a\s+href/i.test(run)) continue; // linked at the label
    if (
      !/([a-z0-9-]+\.(org|com|dev|net|io|es|xyz)|chromestatus|MDN|blink|W3C|RFC\s*\d|Intent)/i.test(
        run,
      )
    ) continue; // not a source-like label
    out.push({ kind: "prose-source", label: run.replace(/\s+/g, " ").trim().slice(0, 100) });
  }
  return out;
}

/** Truncated chromestatus feature ids in one page's HTML. Pure; exported. */
export function detectCsIdShapes(html) {
  const out = [];
  for (const m of html.matchAll(/chromestatus\.com\/feature\/(\d+)/g)) {
    if (m[1].length < CS_ID_MIN_LEN) out.push({ id: m[1], len: m[1].length });
  }
  return out;
}

/** Page ids (vN/slug) among diff path names. Pure; exported. */
export function changedPageIds(names) {
  const ids = new Set();
  for (const n of names) {
    const m = n.match(PAGE_RE);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

async function baselineRef(root) {
  const mb = await git(["merge-base", "origin/main", "HEAD"], root);
  if (mb?.trim()) return mb.trim();
  if (await git(["rev-parse", "--verify", "origin/main"], root)) return "origin/main";
  if (await git(["rev-parse", "--verify", "HEAD"], root)) return "HEAD";
  return null;
}

/** The ratchet over one tree. Exported so the fixture can drive a scratch repo. */
export async function runRatchet(root) {
  const base = await baselineRef(root);
  if (!base) return { error: "no origin/main or HEAD baseline is available" };
  const diff = await git(["diff", "--name-only", base, "HEAD"], root);
  if (diff === null) return { error: `git diff against ${base} failed` };
  const ids = changedPageIds(diff.split("\n").map((s) => s.trim()).filter(Boolean));
  const failures = [];
  for (const id of ids) {
    let html;
    try {
      html = await Deno.readTextFile(`${root}/${id}/index.html`);
    } catch {
      continue; // page deleted in the diff; nothing to ratchet
    }
    for (const v of detectUnlinkedLabels(html)) {
      failures.push(
        `${id}: unlinked citation label (${v.kind}): "${v.label}" — AGENTS.md:91/103: link it or resolve it when touching the page`,
      );
    }
  }
  return { base, changed: ids, failures };
}

/** Corpus-wide id-shape scan (both modes). */
export async function scanIdShapes(root) {
  const failures = [];
  let scanned = 0;
  for await (const rel of Deno.readDir(root)) {
    if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
    for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
      if (!slug.isDirectory) continue;
      let html;
      try {
        html = await Deno.readTextFile(`${root}/${rel.name}/${slug.name}/index.html`);
      } catch {
        continue;
      }
      scanned++;
      for (const v of detectCsIdShapes(html)) {
        failures.push(
          `${rel.name}/${slug.name}: truncated chromestatus id ${v.id} (${v.len} digits < ${CS_ID_MIN_LEN}) — every derived link would 404`,
        );
      }
    }
  }
  return { scanned, failures };
}

/** Report-only corpus count of unlinked labels (cleanup tracking). Never fails. */
export async function countAll(root) {
  let spans = 0, prose = 0, pages = 0;
  for await (const rel of Deno.readDir(root)) {
    if (!(rel.isDirectory && /^v\d+$/.test(rel.name))) continue;
    for await (const slug of Deno.readDir(`${root}/${rel.name}`)) {
      if (!slug.isDirectory) continue;
      let html;
      try {
        html = await Deno.readTextFile(`${root}/${rel.name}/${slug.name}/index.html`);
      } catch {
        continue;
      }
      pages++;
      for (const v of detectUnlinkedLabels(html)) {
        if (v.kind === "citation-span") spans++;
        else prose++;
      }
    }
  }
  return { pages, spans, prose };
}

if (import.meta.main) {
  const root = ".";
  const all = Deno.args.includes("--all");
  const shapes = await scanIdShapes(root);
  if (all) {
    const c = await countAll(root);
    console.log(
      `citation-links report: ${c.pages} pages scanned; unlinked labels: ${c.spans} citation-span + ${c.prose} prose-source (report-only, cleanup tracked separately); id-shape failures: ${shapes.failures.length} of ${shapes.scanned} pages`,
    );
    for (const f of shapes.failures) console.log("  FAIL", f);
    if (shapes.failures.length) {
      console.log("FAIL — truncated chromestatus ids present");
      Deno.exit(1);
    }
    console.log("PASS — id shapes clean (report mode does not gate unlinked labels)");
    Deno.exit(0);
  }
  const r = await runRatchet(root);
  if (r.error) {
    console.log(`FAIL — citation-links ratchet: ${r.error}`);
    Deno.exit(1);
  }
  const failures = [...r.failures, ...shapes.failures];
  console.log(
    `citation-links ratchet: base ${
      r.base.slice(0, 12)
    }; changed pages ${r.changed.length}; pages scanned for id shape ${shapes.scanned}`,
  );
  for (const f of failures) console.log("  FAIL", f);
  if (failures.length) {
    console.log(
      "FAIL — unlinked citation labels on changed pages, or truncated chromestatus ids (see above).",
    );
    Deno.exit(1);
  }
  console.log("PASS — no unlinked citation labels on changed pages; chromestatus id shapes clean.");
}

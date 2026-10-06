#!/bin/sh
# landing-preflight.sh — the shared four-branch landing preflight (gendn-9tj).
#
# WHY THIS EXISTS: several mergers were each writing the same four-branch
# assert-then-act block, and four copies diverge. This is the one tracked
# implementation, hosted here because the measured traps it encodes were found
# landing this repo.
#
# USAGE
#   scripts/landing-preflight.sh <source-ref> [target-ref] [--remote <name>] [--push] [--out <file>]
#
#   <source-ref>   what to push (usually the merge commit; HEAD is the asserted value)
#   [target-ref]   destination branch owner-side (default: main)
#   --push         ACT: really push after the assertions pass, then readback. Without
#                  it the script only DRY-RUNS (rehearsal mode) and still classifies.
#   --remote       remote name (default: origin)
#   --out          where the dry-run capture is written (default: a temp file, path printed)
#   --probe-glob   probe-ref glob checked by the non-mutation belt
#                  (default: refs/heads/landing-preflight-probe-*)
#
# EXIT CODES (distinct so a caller cannot read "nothing to land" as success)
#   0  WOULD-PUSH / PUSHED+readback agreed (see the line printed for which)
#   2  NO-OP      — "Everything up-to-date": nothing to land
#   3  REFUSED    — output contains [rejected]: fetch + re-merge + RE-GATE the merged tree
#   4  UNKNOWN    — fail closed: no row, >1 row, unparsed/empty read, failed assertion,
#                   or the non-mutation belt tripped
#   5  POSTCONDITION — the real push was attempted but the readback did not confirm it
#   6  PRECONDITION  — cannot resolve HEAD/ref, or the belt was already dirty before starting
#
# MEASURED RULES THIS ENCODES (each was measured, several are counter-intuitive):
#
# 1. REJECTION IS TESTED FIRST, as defence in depth. `[rejected]` is the one token whose
#    PRESENCE must be decisive regardless of what else is present. On this git version a
#    rejected update prints no `a..b` range at all, so the ANCHORED row regex is what actually
#    makes the row test safe — but a loose regex can be satisfied by a refusal line, which
#    carries a sha, so ordering is free insurance against a future git that prints a range on
#    a rejected update. NEVER match a particular surrounding wording: a diverged remote says
#    "(fetch first)", pushing an ancestor says "(non-fast-forward)".
#
# 2. THE UPDATE ROW IS `<remote-old>..<local-new>`. The SECOND value is the sha the push would
#    publish; the FIRST is the remote's CURRENT value (not a claim about your tree at all).
#    Assert the row's NEW value is a PREFIX of `git rev-parse HEAD` at WHATEVER LENGTH THE ROW
#    PRINTED, with a MINIMUM-LENGTH GUARD (a 1-char token must not match trivially). Do not
#    hardcode an abbreviation length — it grows with core.abbrev and repo size, so fixed-length
#    equality FAILS A CORRECT PUSH. The assertion is phrased index-free ("the row's new value"),
#    never "the first value": the broadcast phrasing of this was inverted and a lane
#    implementing it refused a good landing.
#
# 3. REFUSE ON AN EMPTY READ. A lane's check printed "== my HEAD? YES" for BOTH values when the
#    row was empty — the assertion agreed with itself on no input. An unparsed row never passes.
#
# 4. THE POST-CONDITION IS THE READBACK, NOT THE ROW. A dry run and a real push print
#    BYTE-IDENTICAL rows (same md5, measured), so the row proves the push WOULD BE ACCEPTED and
#    cannot prove it OCCURRED. Only `git ls-remote <remote> refs/heads/<target>` returning the
#    pushed sha establishes occurrence — so in --push mode the readback is the post-condition
#    (exit 5 if it disagrees), not a belt.
#
# 5. NON-MUTATION BELT: after every dry run, assert zero probe refs were published. A --dry-run
#    that created a ref would be a silent mutation, and a rehearsal that claims no mutation must
#    be checked. The belt runs BEFORE and AFTER, so a dirty start is a precondition failure.
#
# 6. SEQUENCING: run this AFTER the merge commit exists. Against a worktree still at the old
#    tip, the form that reads the real target reports the false green this exists to prevent.
#
# REHEARSAL: scripts/landing-preflight.test.sh exercises all four branches with the push stubbed
# plus real local-git cases; a branch that has never been exercised is one you rely on without
# evidence. Which branches were real is stated in that script's output.

set -u

REMOTE=origin
TARGET=main
OUT=""
PUSH=0
PROBE_GLOB="refs/heads/landing-preflight-probe-*"
MIN_TOKEN_LEN=7

usage() {
  echo "landing-preflight: usage: $0 <source-ref> [target-ref] [--remote <name>] [--push] [--out <file>] [--probe-glob <glob>]" >&2
}

# A value-taking option supplied as the LAST argument makes $2 unbound under set -u, which kills
# the script with a shell error instead of a usage message — fail-closed but the wrong failure.
# Bounds-check before consuming the value (gendn-04g).
require_value() { # $1 = option name, $2 = remaining argument count
  if [ "$2" -lt 2 ]; then
    echo "landing-preflight: $1 requires a value" >&2
    usage
    exit 6
  fi
}

SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) require_value --remote $#; REMOTE=$2; shift 2 ;;
    --out) require_value --out $#; OUT=$2; shift 2 ;;
    --probe-glob) require_value --probe-glob $#; PROBE_GLOB=$2; shift 2 ;;
    --push) PUSH=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "landing-preflight: unknown option $1" >&2; usage; exit 6 ;;
    *)
      if [ -z "$SRC" ]; then SRC=$1; else TARGET=$1; fi
      shift ;;
  esac
done

if [ -z "$SRC" ]; then
  usage
  exit 6
fi
if [ -z "$OUT" ]; then
  OUT=$(mktemp "${TMPDIR:-/tmp}/landing-preflight.XXXXXX")
fi

head_sha=$(git rev-parse HEAD 2>/dev/null) || {
  echo "landing-preflight: PRECONDITION: cannot resolve HEAD" >&2
  exit 6
}
git rev-parse --verify --quiet "$SRC^{commit}" >/dev/null 2>&1 || {
  echo "landing-preflight: PRECONDITION: cannot resolve source ref '$SRC'" >&2
  exit 6
}

# --- non-mutation belt (before): no probe refs may exist already -----------------
belt_check() {
  probes=$(git ls-remote "$REMOTE" "$PROBE_GLOB" 2>/dev/null)
  if [ -n "$probes" ]; then
    echo "landing-preflight: UNKNOWN: non-mutation belt tripped — probe refs exist on $REMOTE:" >&2
    echo "$probes" >&2
    return 1
  fi
  return 0
}
if ! belt_check; then
  echo "landing-preflight: PRECONDITION: belt dirty before start (pre-existing probe refs)" >&2
  exit 6
fi

# --- the dry run: status captured UNPIPED ---------------------------------------
# /bin/sh here is dash: PIPESTATUS is a hard failure and pipefail is unavailable, so the
# capture must not be piped.
git push --dry-run "$REMOTE" "$SRC:refs/heads/$TARGET" >"$OUT" 2>&1
dry_rc=$?

echo "landing-preflight: dry-run capture ($REMOTE $SRC -> refs/heads/$TARGET, rc=$dry_rc) -> $OUT"

# --- branch 1: REFUSED (tested FIRST, presence of the token is decisive) ---------
if grep -Fq '[rejected]' "$OUT"; then
  echo "landing-preflight: REFUSED (exit 3) — output contains [rejected]."
  echo "landing-preflight: DO NOT PUSH. fetch + re-merge + RE-GATE the MERGED tree."
  sed 's/^/    | /' "$OUT"
  exit 3
fi

# --- branch 2: NO-OP ------------------------------------------------------------
if grep -Eq '^Everything up-to-date$' "$OUT"; then
  echo "landing-preflight: NO-OP (exit 2) — nothing to land."
  exit 2
fi

# --- branch 3: an ANCHORED update row -------------------------------------------
# Anchored at line start and requiring the `a..b` shape: prose that merely mentions the
# branch cannot satisfy it, and a sha-only refusal line cannot either.
row_count=$(grep -Ec '^[[:space:]]*[+!]?[[:space:]]*[0-9a-fA-F]+\.\.[0-9a-fA-F]+[[:space:]]' "$OUT" || true)
if [ "$row_count" = "1" ]; then
  row=$(grep -E '^[[:space:]]*[+!]?[[:space:]]*[0-9a-fA-F]+\.\.[0-9a-fA-F]+[[:space:]]' "$OUT" | head -n 1)
  # the row must be about the ref we are pushing
  case "$row" in
    *"-> $TARGET"*) : ;;
    *"->$TARGET"*) : ;;
    *)
      echo "landing-preflight: UNKNOWN (exit 4) — a row was found but it is not for -> $TARGET:"
      echo "    | $row"
      exit 4 ;;
  esac
  old_token=$(printf '%s\n' "$row" | sed -E 's/^[[:space:]]*[+!]?[[:space:]]*([0-9a-fA-F]+)\.\..*$/\1/')
  new_token=$(printf '%s\n' "$row" | sed -E 's/^[[:space:]]*[+!]?[[:space:]]*[0-9a-fA-F]+\.\.([0-9a-fA-F]+).*$/\1/')

  # empty read can never pass
  if [ -z "$new_token" ] || [ -z "$old_token" ]; then
    echo "landing-preflight: UNKNOWN (exit 4) — empty/unparsed row read (never pass on no input)."
    exit 4
  fi
  # minimum-length guard so a 1-char token cannot match trivially
  if [ "${#new_token}" -lt "$MIN_TOKEN_LEN" ]; then
    echo "landing-preflight: UNKNOWN (exit 4) — row's new token is shorter than the ${MIN_TOKEN_LEN}-char guard ('$new_token')."
    exit 4
  fi
  # the NEW value (the sha the row says it would publish) must be a PREFIX of this HEAD,
  # at whatever length the row printed. Index-free: the row's own syntax defines new/old.
  new_is_prefix=0
  case "$head_sha" in "$new_token"*) new_is_prefix=1 ;; esac
  old_is_prefix=0
  if [ "${#old_token}" -ge "$MIN_TOKEN_LEN" ]; then
    case "$head_sha" in "$old_token"*) old_is_prefix=1 ;; esac
  fi
  if [ "$new_is_prefix" != "1" ] || [ "$old_is_prefix" = "1" ]; then
    echo "landing-preflight: UNKNOWN (exit 4) — row does not assert THIS HEAD."
    echo "    row        : $row"
    echo "    HEAD       : $head_sha"
    echo "    new token  : $new_token (prefix of HEAD: $new_is_prefix)"
    echo "    old token  : $old_token (prefix of HEAD: $old_is_prefix)"
    echo "landing-preflight: refusing — a row whose new value is not this HEAD cannot prove this tree."
    exit 4
  fi

  if ! belt_check; then
    echo "landing-preflight: UNKNOWN (exit 4) — belt tripped after the dry run (dry-run mutated refs?)"
    exit 4
  fi

  if [ "$PUSH" = "0" ]; then
    echo "landing-preflight: WOULD-PUSH (exit 0, dry-run mode) — row asserts HEAD; run with --push to act."
    echo "    | $row"
    exit 0
  fi

  # --- act, in the same block, with no intervening unasserted step --------------
  git push "$REMOTE" "$SRC:refs/heads/$TARGET" >>"$OUT.act" 2>&1
  act_rc=$?
  echo "landing-preflight: act ($REMOTE $SRC -> refs/heads/$TARGET, rc=$act_rc) -> $OUT.act"
  if [ "$act_rc" != "0" ]; then
    echo "landing-preflight: UNKNOWN (exit 4) — the real push exited $act_rc after a passing dry run."
    sed 's/^/    | /' "$OUT.act"
    exit 4
  fi
  # POST-CONDITION: the readback, not the row (byte-identical dry-run/real-push rows)
  remote_now=$(git ls-remote "$REMOTE" "refs/heads/$TARGET" 2>/dev/null | awk 'NR==1{print $1}')
  if [ -z "$remote_now" ]; then
    echo "landing-preflight: POSTCONDITION (exit 5) — readback of refs/heads/$TARGET returned nothing."
    exit 5
  fi
  readback_ok=0
  [ "$remote_now" = "$new_token" ] && readback_ok=1
  case "$remote_now" in "$new_token"*) readback_ok=1 ;; esac
  if [ "$readback_ok" != "1" ]; then
    echo "landing-preflight: POSTCONDITION (exit 5) — readback disagrees: remote has $remote_now, expected $new_token."
    exit 5
  fi
  if ! belt_check; then
    echo "landing-preflight: UNKNOWN (exit 4) — belt tripped after the real push."
    exit 4
  fi
  echo "landing-preflight: PUSHED (exit 0) — readback confirms refs/heads/$TARGET = $remote_now."
  exit 0
fi

# --- branch 4: UNKNOWN (fail closed) --------------------------------------------
if [ "$row_count" = "0" ]; then
  echo "landing-preflight: UNKNOWN (exit 4) — no update row and not up-to-date/rejected. DO NOT PUSH."
else
  echo "landing-preflight: UNKNOWN (exit 4) — $row_count update rows (expected exactly 1). DO NOT PUSH."
fi
if [ ! -s "$OUT" ]; then
  echo "landing-preflight: (the capture is EMPTY — an unparsed row must never pass)"
fi
sed 's/^/    | /' "$OUT"
exit 4

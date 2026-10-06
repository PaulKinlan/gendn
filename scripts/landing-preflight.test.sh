#!/bin/sh
# landing-preflight.test.sh — the rehearsal for scripts/landing-preflight.sh (gendn-9tj).
#
# A branch that has never been exercised is a branch you rely on without evidence. This script
# exercises ALL FOUR branches plus the assertion's edges, and STATES WHICH WERE REAL:
#
#   PART A — stub git on PATH: exercises the PARSER and the branch decisions with the push
#            stubbed (no remote, no mutation). Every case asserts the exit code AND that no
#            real push happened unless the branch says to act.
#   PART B — real git against a LOCAL BARE REPO (no network): exercises real dry-run output
#            shapes — a real update row, a real "Everything up-to-date", a real [rejected]
#            refusal — plus the readback post-condition and the control readback proving the
#            target was NOT mutated by dry runs.
#
# The discriminating test (must REFUSE): a row shaped `<my full HEAD>..<somebody else's sha>` —
# the exact shape that PASSES under the inverted "compare the first value" rule — must fail
# closed. It cannot be produced by a real push (a non-ancestor push prints no row), so it is
# exercised with the stub, which is why the stub half is not optional.
#
# Usage: sh scripts/landing-preflight.test.sh [--repo <path-to-checkout>]

set -u

REPO=$(pwd)
if [ "${1:-}" = "--repo" ]; then REPO=$2; fi
SCRIPT="$REPO/scripts/landing-preflight.sh"
if [ ! -f "$SCRIPT" ]; then
  echo "landing-preflight.test.sh: not found: $SCRIPT" >&2
  exit 1
fi

TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}/landing-preflight-test.XXXXXX")
trap 'rm -rf "$TMPROOT"' EXIT INT TERM

PASS=0
FAIL=0
FAILED_NAMES=""
say() { printf '%s\n' "$*"; }
check() { # name expected_rc actual_rc extra_ok(0/1)
  name=$1; want=$2; got=$3; extra=${4:-1}
  if [ "$got" = "$want" ] && [ "$extra" = "1" ]; then
    PASS=$((PASS + 1)); say "PASS: $name (exit $got)"
  else
    FAIL=$((FAIL + 1)); FAILED_NAMES="$FAILED_NAMES $name"; say "FAIL: $name (want exit $want, got $got; extra_ok=$extra)"
  fi
}

# ---------------------------------------------------------------------------
# PART A — stub git
# ---------------------------------------------------------------------------
say ""
say "=== PART A — STUBBED push (parser + branch decisions; no remote, no mutation) ==="

STUBDIR="$TMPROOT/stub"
mkdir -p "$STUBDIR"
cat >"$STUBDIR/git" <<'STUB'
#!/bin/sh
# Stub git for the landing-preflight rehearsal. Behaviour chosen by env:
#   STUB_HEAD             value for `git rev-parse HEAD`
#   STUB_TARGET           target branch name (default main)
#   STUB_DRY_OUT          text the dry run prints (rows/rejections/etc.)
#   STUB_DRY_RC           dry-run exit status (default 0)
#   STUB_REMOTE_SHA       sha `git ls-remote <remote> refs/heads/<target>` returns (readback)
#   STUB_PROBE_AFTER_N    emit a probe ref only from the Nth probe query onward (0 = never)
#   STUB_PUSH_LOG         file to append real-push invocations to
log="${STUB_PUSH_LOG:-/dev/null}"
target="${STUB_TARGET:-main}"
cmd=$1; shift 2>/dev/null || true
case "$cmd" in
  rev-parse)
    if [ "${1:-}" = "HEAD" ]; then printf '%s\n' "${STUB_HEAD:-}"; fi
    exit 0 ;;
  ls-remote)
    pat=${2:-}
    case "$pat" in
      *probe*)
        if [ -n "${STUB_PROBE_AFTER_N:-}" ] && [ "${STUB_PROBE_AFTER_N}" != "0" ]; then
          cntfile="${STUB_PUSH_LOG:-/dev/null}.probecount"
          n=$(cat "$cntfile" 2>/dev/null || echo 0)
          n=$((n + 1))
          echo "$n" >"$cntfile"
          if [ "$n" -ge "$STUB_PROBE_AFTER_N" ]; then
            printf 'deadbeef refs/heads/landing-preflight-probe-x\n'
          fi
        fi
        exit 0 ;;
      *"refs/heads/$target"*)
        [ -n "${STUB_REMOTE_SHA:-}" ] && printf '%s refs/heads/%s\n' "$STUB_REMOTE_SHA" "$target"
        exit 0 ;;
    esac
    exit 0 ;;
  push)
    if [ "${1:-}" = "--dry-run" ]; then
      [ -n "${STUB_DRY_OUT:-}" ] && printf '%s\n' "$STUB_DRY_OUT"
      exit "${STUB_DRY_RC:-0}"
    fi
    printf 'PUSH %s\n' "$*" >>"$log"
    exit "${STUB_PUSH_RC:-0}" ;;
esac
exit 0
STUB
chmod +x "$STUBDIR/git"

STUB_HEAD_FULL="51514d3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
STUB_HEAD_SHORT="51514d3"
OTHER_FULL="deadbeefbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
OLD_SHORT="5f1c00f"

case_run() { # name expected_rc dry_out push_expected probe_after_n readback_sha mode
  name=$1; want=$2; dry=$3; push_expected=$4; probe_after=${5:-0}; readback=${6:-}; mode=${7:-}
  case_dir="$TMPROOT/case-$name"
  mkdir -p "$case_dir"
  : >"$case_dir/push.log"
  (
    cd "$case_dir" || exit 1
    PATH="$STUBDIR:$PATH" \
      STUB_HEAD="$STUB_HEAD_FULL" STUB_DRY_OUT="$dry" STUB_REMOTE_SHA="$readback" \
      STUB_PROBE_AFTER_N="$probe_after" STUB_PUSH_LOG="$case_dir/push.log" \
      sh "$SCRIPT" HEAD main $mode >"$case_dir/out.txt" 2>&1
    echo $? >"$case_dir/rc.txt"
  )
  got_rc=$(cat "$case_dir/rc.txt")
  pushes=$(wc -l <"$case_dir/push.log" | tr -d ' ')
  extra=1
  if [ "$push_expected" = "no" ] && [ "$pushes" != "0" ]; then extra=0; fi
  if [ "$push_expected" = "yes" ] && [ "$pushes" != "1" ]; then extra=0; fi
  check "$name" "$want" "$got_rc" "$extra"
  say "      pushes recorded: $pushes (expected: $push_expected) | $case_dir/out.txt"
}

case_run "A1 rejected-token-first"            3 " ! [rejected]        HEAD -> main (fetch first)" no
case_run "A2 no-op up-to-date"                2 "Everything up-to-date" no
case_run "A3 update-row would-push (dry)"     0 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main" no
case_run "A4 update-row with --push+readback" 0 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main" yes 0 "$STUB_HEAD_SHORT" --push
case_run "A5 empty read never passes"         4 "" no
case_run "A6 unrelated garbage is UNKNOWN"    4 "warning: something unrelated happened" no
case_run "A7 two rows are ambiguous"          4 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main
aaaaaaaa..$STUB_HEAD_SHORT  HEAD -> main" no
case_run "A8 DISCRIMINATING: <HEAD>..<other> must refuse" 4 "$STUB_HEAD_FULL..$OTHER_FULL  HEAD -> main" no
case_run "A9 min-length guard rejects 3-char token"       4 "$OLD_SHORT..abc  HEAD -> main" no
case_run "A10 row for a different target is UNKNOWN"      4 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> other" no
case_run "A11 postcondition readback disagrees"           5 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main" yes 0 "fffffff" --push
case_run "A12 postcondition readback empty"               5 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main" yes 0 "" --push
case_run "A13 belt trips AFTER the dry run"               4 "$OLD_SHORT..$STUB_HEAD_SHORT  HEAD -> main" no 2

# A14 dedicated: probe refs present from the very first belt query -> precondition exit 6.
(
  cd "$TMPROOT" || exit 1
  : >"$TMPROOT/a14.log"
  PATH="$STUBDIR:$PATH" STUB_HEAD="$STUB_HEAD_FULL" STUB_DRY_OUT="x" STUB_PROBE_AFTER_N=1 \
    STUB_PUSH_LOG="$TMPROOT/a14.log" sh "$SCRIPT" HEAD main >"$TMPROOT/a14.out" 2>&1
  echo $? >"$TMPROOT/a14.rc"
)
check "A14 belt dirty before start is a PRECONDITION" 6 "$(cat "$TMPROOT/a14.rc")" 1

# --- A15/A16: malformed option handling (gendn-04g regression pins) ------------
# A value-taking option supplied as the LAST argument used to make $2 unbound under set -u, so
# the script died with a shell error instead of a usage message. Checked under BOTH shells
# because the failure reproduced in both (dash: 'parameter not set'; bash: 'unbound variable').
for shell in sh bash; do
  for opt in --remote --out --probe-glob; do
    ( cd "$TMPROOT" || exit 1
      PATH="$STUBDIR:$PATH" STUB_HEAD="$STUB_HEAD_FULL" STUB_PUSH_LOG="$TMPROOT/a15.log" \
        "$shell" "$SCRIPT" HEAD main "$opt" >"$TMPROOT/a15.out" 2>&1
      echo $? >"$TMPROOT/a15.rc" )
    rc=$(cat "$TMPROOT/a15.rc")
    extra=1
    grep -q "requires a value" "$TMPROOT/a15.out" || extra=0
    grep -qE "unbound variable|parameter not set" "$TMPROOT/a15.out" && extra=0
    check "A15 $shell: last-arg '$opt' -> usage + exit 6 (no shell error)" 6 "$rc" "$extra"
  done
done
for shell in sh bash; do
  ( cd "$TMPROOT" || exit 1
    PATH="$STUBDIR:$PATH" STUB_HEAD="$STUB_HEAD_FULL" STUB_PUSH_LOG="$TMPROOT/a16.log" \
      "$shell" "$SCRIPT" HEAD main --bogus >"$TMPROOT/a16.out" 2>&1
    echo $? >"$TMPROOT/a16.rc" )
  rc=$(cat "$TMPROOT/a16.rc")
  extra=1
  grep -q "unknown option" "$TMPROOT/a16.out" || extra=0
  grep -q "usage:" "$TMPROOT/a16.out" || extra=0
  check "A16 $shell: unknown option -> usage + exit 6" 6 "$rc" "$extra"
done

# ---------------------------------------------------------------------------
# PART B — real git against a LOCAL BARE REMOTE (no network)
# ---------------------------------------------------------------------------
say ""
say "=== PART B — REAL local git (real dry-run output shapes; target in a temp bare repo) ==="

B="$TMPROOT/real"
mkdir -p "$B"
git init -q --bare "$B/remote.git"
git init -q "$B/work"
(
  cd "$B/work" || exit 1
  git config user.email t@example.com; git config user.name test
  git remote add origin "$B/remote.git"
  echo one >f; git add f; git commit -qm "base A"
  A=$(git rev-parse HEAD)
  git push -q origin HEAD:refs/heads/main
  git checkout -qb fleet/x
  echo two >>f; git commit -qam "B on top of A"
  Bsha=$(git rev-parse HEAD)
  echo "A=$A"; echo "B=$Bsha"
  echo "$A" >"$B/A"; echo "$Bsha" >"$B/B"
)

B_A=$(cat "$B/A"); B_B=$(cat "$B/B")
B_MAIN_BEFORE=$(git -C "$B/remote.git" rev-parse refs/heads/main)

# B1 — real update row (fleet/x is strictly ahead of main, and main is an ancestor of HEAD)
(
  cd "$B/work" || exit 1
  sh "$SCRIPT" fleet/x main --remote origin --out "$B/b1.row" >"$B/b1.out" 2>&1
  echo $? >"$B/b1.rc"
)
b1_row=$(grep -E '^[[:space:]]*[0-9a-f]+\.\.[0-9a-f]+' "$B/b1.row" 2>/dev/null | head -1)
say "      B1 real row: $b1_row"
A7=$(printf '%s' "$B_A" | cut -c1-7)
B7=$(printf '%s' "$B_B" | cut -c1-7)
b1_shape=0
case "$b1_row" in *"${A7}..${B7}"*) b1_shape=1 ;; esac
[ "$b1_shape" = "1" ] || say "      (expected the row to contain ${A7}..${B7})"
check "B1 REAL update row classified WOULD-PUSH (dry, no mutation)" 0 "$(cat "$B/b1.rc")" "$b1_shape"
check "B1 control readback: remote main UNCHANGED by the dry run" 0 \
  "$([ "$(git -C "$B/remote.git" rev-parse refs/heads/main)" = "$B_MAIN_BEFORE" ] && echo 0 || echo 1)" 1

# B2 — --push really pushes, and the readback proves occurrence
(
  cd "$B/work" || exit 1
  sh "$SCRIPT" fleet/x main --remote origin --push --out "$B/b2.row" >"$B/b2.out" 2>&1
  echo $? >"$B/b2.rc"
)
check "B2 REAL --push + readback post-condition" 0 "$(cat "$B/b2.rc")" 1
check "B2 readback: remote main IS B" 0 \
  "$([ "$(git -C "$B/remote.git" rev-parse refs/heads/main)" = "$B_B" ] && echo 0 || echo 1)" 1

# B3 — real NO-OP
(
  cd "$B/work" || exit 1
  sh "$SCRIPT" fleet/x main --remote origin --out "$B/b3.row" >"$B/b3.out" 2>&1
  echo $? >"$B/b3.rc"
)
check "B3 REAL Everything-up-to-date NO-OP" 2 "$(cat "$B/b3.rc")" 1

# B4 — real REFUSED (diverge the remote main, then dry-run a non-ancestor)
(
  cd "$B/work" || exit 1
  git checkout -q main 2>/dev/null || git checkout -qb main
  echo diverge >g; git add g; git commit -qm "C diverging main"
  C=$(git rev-parse HEAD)
  git push -qf origin HEAD:refs/heads/main
  echo "$C" >"$B/C"
)
(
  cd "$B/work" || exit 1
  sh "$SCRIPT" fleet/x main --remote origin --out "$B/b4.row" >"$B/b4.out" 2>&1
  echo $? >"$B/b4.rc"
)
say "      B4 refusal line: $(cat "$B/b4.row" 2>/dev/null | head -1)"
check "B4 REAL [rejected] refusal classified REFUSED" 3 "$(cat "$B/b4.rc")" 1
check "B4 control: fleet/x was NOT pushed by a refusal" 0 \
  "$([ "$(git -C "$B/remote.git" rev-parse refs/heads/main)" = "$(cat "$B/C")" ] && echo 0 || echo 1)" 1

say ""
say "REAL vs STUBBED, stated plainly:"
say "  REAL (local bare remote, real git output): B1 update row, B2 push+readback, B3 up-to-date, B4 [rejected]."
say "  STUBBED (no remote can produce these shapes): A5 empty, A6 garbage, A7 two rows, A8 discriminating,"
say "  A9 min-length, A10 wrong target, A11/A12 readback failures, A13 belt-after, A14 belt-before."
say "  A1-A4 exercise the branch DECISIONS with the push stubbed (A4 exercises the act path)."
say ""
say "=== landing-preflight rehearsal: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" != "0" ]; then say "failed:$FAILED_NAMES"; exit 1; fi
exit 0

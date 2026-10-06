#!/bin/sh
# kill-probe.sh — run a gate command as a KILL PROBE and make its log self-identifying.
#
# WHY THIS EXISTS (gendn-3t2): check-verdict-emission accepts an unsummarised log as the kill probe
# only when the caller declares `--phase behavioural`, because a SIGKILLed probe and a run that
# crashed at the same point are byte-identical in a log — a signal leaves no trace in the output.
# That made the caller's declaration the ONLY evidence, so a truncated run-all log could be
# mis-declared as the probe and pass with "owes 0".
#
# This wrapper is the repo-owned producer of the missing evidence: it runs the probe in its own
# process group, kills that GROUP after a bounded window (exactly what a landing probe does), and
# appends an explicit, greppable line recording how the probe died:
#
#   kill-probe: signal=KILL exit=137
#
# The checker REQUIRES that line for `--phase behavioural`, so a crashed run that never went through
# this wrapper can no longer be mistaken for a probe, whichever phase the caller declares.
#
# USAGE
#   scripts/kill-probe.sh <log-path> [--after <seconds>] -- <command> [args...]
#
#   <log-path>          file to write: the command's own output, then the evidence line
#   --after <seconds>   how long to let the probe run before the kill (default 20)
#   --                  separates this script's options from the command to probe
#
# EXIT
#   0  the probe was killed by a signal and the evidence line was written
#   1  the probe COMPLETED before the kill window elapsed (no signal death) — evidence is still
#      written but records signal=none, and check-verdict-emission will refuse it as a probe
#   2  usage error
#
# The evidence line is always the LAST line of the log, and it is the only line this script adds.

set -u

usage() {
  echo "usage: $0 <log-path> [--after <seconds>] -- <command> [args...]" >&2
  exit 2
}

LOG=""
AFTER=20
while [ $# -gt 0 ]; do
  case "$1" in
    --after)
      [ $# -ge 2 ] || usage
      AFTER=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "kill-probe: unknown option $1" >&2
      usage
      ;;
    *)
      if [ -z "$LOG" ]; then LOG=$1; else echo "kill-probe: unexpected argument $1" >&2; usage; fi
      shift
      ;;
  esac
done

[ -n "$LOG" ] || usage
[ $# -gt 0 ] || usage
case "$AFTER" in
  ''|*[!0-9]*) echo "kill-probe: --after must be a whole number of seconds" >&2; usage ;;
esac

signal_name() { # $1 = signal number
  case "$1" in
    1) echo HUP ;;
    2) echo INT ;;
    3) echo QUIT ;;
    6) echo ABRT ;;
    9) echo KILL ;;
    13) echo PIPE ;;
    14) echo ALRM ;;
    15) echo TERM ;;
    *) echo "SIG$1" ;;
  esac
}

: >"$LOG"
# setsid puts the probe in its own session/process group, so the kill reaches the whole tree — the
# same thing a landing probe does to the runner's process group.
setsid "$@" >>"$LOG" 2>&1 &
pid=$!

(
  sleep "$AFTER"
  kill -KILL -"$pid" 2>/dev/null
) &
killer=$!

wait "$pid"
status=$?
kill "$killer" 2>/dev/null || true
wait "$killer" 2>/dev/null || true

if [ "$status" -gt 128 ]; then
  number=$((status - 128))
  name=$(signal_name "$number")
  printf 'kill-probe: signal=%s exit=%s\n' "$name" "$status" >>"$LOG"
  echo "kill-probe: probe killed by SIG$name after ${AFTER}s (exit $status) — evidence written to $LOG"
  exit 0
fi

printf 'kill-probe: signal=none exit=%s\n' "$status" >>"$LOG"
echo "kill-probe: the probe COMPLETED (exit $status) before the ${AFTER}s kill window — it is not a" >&2
echo "kill-probe: signal death, so check-verdict-emission will refuse this log as the probe." >&2
exit 1

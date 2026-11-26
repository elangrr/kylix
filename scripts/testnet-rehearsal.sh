#!/usr/bin/env bash
# Rehearse Kylix on a live chain (the onyx-1 testnet by default), one step at a
# time, with real keys and real transactions.
#
#   NS=<namespace> scripts/testnet-rehearsal.sh <step> [<step>...]
#   NS=<namespace> scripts/testnet-rehearsal.sh all          every step in order
#   DRY=1 NS=<namespace> scripts/testnet-rehearsal.sh <step>  simulate only, send nothing
#
# Steps: status claim direct refusals mns gnoswap sinopia notify session
# (see scripts/README.md, "Testnet rehearsal").
#
# Each step prints what it does, one line per transaction (gas used, storage
# delta, deposit or refund, total cost) and one PASS/FAIL line per check, with
# the on-chain values it compared. Full gnokey and solver output goes to
# $OUT/<run>/; $OUT/state remembers the last direct ring for the refusals step.
# It exits non-zero if any check failed.
#
# Safety:
#   - Every transaction is signed for $CHAIN_ID, and the script refuses to send
#     unless the node at $RPC reports that chain id.
#   - The password is read from $PWFILE and piped to gnokey; it is never
#     printed, logged or passed as an argument. No mnemonic is ever shown.
#   - Every transaction carries -max-deposit and the minimum fee for its gas
#     limit (gas-wanted / 1000 ugnot).
#   - Expected failures are simulated, not sent (set REAL_FAIL=1 to send them
#     and see the chain reject them in a block, which costs the fee).
#   - It uses only `maketx call` and `maketx session`, never `maketx run`
#     (restricted on onyx-1) or `maketx send`, and never a faucet.
set -uo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)

# --- configuration ------------------------------------------------------------
: "${NS:?set NS to the namespace Kylix is deployed under (nym-kylix000 or a g1... address)}"
RPC=${RPC:-https://rpc.onyx.testnets.gno.land:443}
CHAIN_ID=${CHAIN_ID:-onyx-1}
KEYS=${KEYS:-$HOME/.config/kylix-keys/kb}
PWFILE=${PWFILE:-$HOME/.config/kylix-keys/password}
GNOKEY=${GNOKEY:-gnokey}
case "$NS" in nym-*) _owner=kylix-deployer ;; *) _owner=kylix-stage ;; esac
KEY_OWNER=${KEY_OWNER:-$_owner}       # owns the namespace (deployed the packages)
KEY_SETTLER=${KEY_SETTLER:-$KEY_OWNER} # settles rings; trades in none of them
KEY_ANA=${KEY_ANA:-ana}
KEY_BEN=${KEY_BEN:-ben}
KEY_CLEO=${KEY_CLEO:-cleo}
KEY_SESSION=${KEY_SESSION:-kylix-session}  # created in $KEYS if missing (no backup shown)
DRY=${DRY:-0}
REAL_FAIL=${REAL_FAIL:-0}
GAS=${GAS:-40000000}                    # gas-wanted for ordinary calls
DEP=${DEP:-1500000ugnot}                # -max-deposit for ordinary calls
case "$RPC" in http://* | https://*) RPC_URL=$RPC ;; *) RPC_URL=http://$RPC ;; esac
case "$RPC" in *127.0.0.1* | *localhost*) QDELAY=${QDELAY:-0} ;; *) QDELAY=${QDELAY:-1} ;; esac
OUT=${OUT:-$REPO/.testnet-rehearsal/$CHAIN_ID-$NS}
SOLVER=${SOLVER:-$OUT/kylix-solver}

# Step parameters.
MNS_DOMAIN=${MNS_DOMAIN:-gnoland}
MNS_LABEL=${MNS_LABEL:-kylix-rh-$(printf '%s' "$NS" | tr -cd 'a-z0-9' | tail -c 8)}
MNS_PRICE_OBOL=${MNS_PRICE_OBOL:-120}
GS_IN1=${GS_IN1:-1000000}   # ugnot-wrapped wugnot swapped in the SettleRing ring
GS_IN2=${GS_IN2:-500000}    # ... and in the SettleRingVia ring
GS_OBOL=${GS_OBOL:-10}      # OBOL ben gives ana in each gnoswap ring
GS_FEE=${GS_FEE:-3000}      # fee tier of the only wugnot/GNS pool on onyx-1
GS_SLIP_BPS=${GS_SLIP_BPS:-300} # ben's minimum = live quote minus this
GS_OUT=${GS_OUT:-gno.land/r/gnoswap/gns.GNS} # the token ben wants (the pool's other side)
# GS_MIN1, GS_MIN2: fixed minimums instead of quote-based ones (for a chain
# whose router has no DrySwapRoute, such as the local stand-in).
SESSION_SPEND=${SESSION_SPEND:-2000000ugnot}

# Package paths.
K=gno.land/r/$NS/kylix
D=gno.land/r/$NS/kylixdemo
MNSA=gno.land/r/$NS/adapters/nsnft
SINA=gno.land/r/$NS/adapters/sinopia3
RINGP=gno.land/p/$NS/ring/v0
OBOL=$D.OBOL
DRACHMA=$D.DRACHMA
WUGNOT=gno.land/r/gnoland/wugnot.wugnot
GNS=gno.land/r/gnoswap/gns.GNS
NSL=gno.land/r/nym-mnsrehearsal001/nslogic/v2
NSD=gno.land/r/nym-mnsrehearsal001/nsdata/v2
NSN=gno.land/r/nym-mnsrehearsal001/nsnft/v2
CORE=gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/core
MARKET=gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/market/v1
GNOTIF=gno.land/r/nym-gfanton001/gnotif/v1
REG=gno.land/r/nt/grc20reg/v0

mkdir -p "$OUT"
STATE=$OUT/state
touch "$STATE"
LOGS=$OUT/$(date +%Y%m%d-%H%M%S)-$$
mkdir -p "$LOGS"
NPASS=0 NFAIL=0 NSKIP=0 SEQ=0

# --- output -------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
head1() { printf '\n== %s\n' "$*"; }
pass() { NPASS=$((NPASS + 1)); printf '  PASS  %s\n' "$*"; }
fail() { NFAIL=$((NFAIL + 1)); printf '  FAIL  %s\n' "$*"; }
skip() { NSKIP=$((NSKIP + 1)); printf '  SKIP  %s\n' "$*"; }
# check <0 if it holds, else 1> <description with the values compared>
check() { if [ "$1" = 0 ]; then pass "$2"; else fail "$2"; fi; }
state_get() { sed -n "s/^$1=//p" "$STATE" | tail -1; }
state_set() { grep -v "^$1=" "$STATE" >"$STATE.tmp"; echo "$1=$2" >>"$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }

# --- queries (read-only, retried with backoff on HTTP 429) ----------------------
q() { # q <path> [data] -> the data payload
  local out i
  for i in 1 2 3 4 5 6; do
    out=$("$GNOKEY" query "$1" -data "${2:-}" -remote "$RPC" 2>&1)
    if grep -qiE '\b429\b|too many requests' <<<"$out"; then sleep $((i * i * 2)); continue; fi
    break
  done
  [ "$QDELAY" != 0 ] && sleep "$QDELAY"
  printf '%s\n' "$out" | sed -n '/^data: /,$p' | sed '1s/^data: //'
}
qeval() { q vm/qeval "$1"; }
qint() { qeval "$1" | head -1 | sed -n 's/^(\(-\{0,1\}[0-9][0-9]*\) .*/\1/p'; }
qaddr() { qeval "$1" | grep -o 'g1[a-z0-9]\{38\}' | head -1; }
qstr() { # first ("..." string) of a qeval, unquoted
  qeval "$1" | python3 -I -c '
import sys, json, re
t = sys.stdin.read()
m = re.search(r"^\((\".*?\") string\)", t, re.S | re.M)
print(json.loads(m.group(1)) if m else "", end="")'
}
addr() { "$GNOKEY" list -home "$KEYS" 2>/dev/null | grep " $1 (" | sed 's/.*addr: \([^ ]*\).*/\1/' | head -1; }
pubkey() { "$GNOKEY" list -home "$KEYS" 2>/dev/null | grep " $1 (" | sed 's/.*pub: \([^,]*\),.*/\1/' | head -1; }
ugnot() { local v; v=$(q "bank/balances/$1" | tr -dc '0-9'); echo "${v:-0}"; }
seqno() { q "auth/accounts/$1" | sed -n 's/.*"sequence": "\([0-9]*\)".*/\1/p' | head -1; }
tok() { local v; v=$(qint "$REG.Get(\"$1\").BalanceOf(\"$2\")"); echo "${v:-0}"; }
pkgstatus() { q vm/qpkgmeta_json "$1" | python3 -I -c '
import sys, json
try:
    d = json.loads(sys.stdin.read()); print(d.get("status", "?") + (" (" + d["reason"] + ")" if d.get("reason") else ""))
except Exception:
    print("missing")'
}
chain_id() { curl -s -m 20 "$RPC_URL/status" | python3 -I -c "import sys,json; print(json.load(sys.stdin)['result']['node_info']['network'])" 2>/dev/null; }
next_slot() { qaddr "$K.NextSlot(\"$1\")"; }
next_nonce() { qint "$K.NextSlot(\"$1\")"; }
offer_open() { qeval "$K.GetOffer($1)" | tail -1 | grep -q '^(true bool)'; }

CHAIN_OK=
assert_chain() {
  [ -n "$CHAIN_OK" ] && return 0
  local got
  got=$(chain_id)
  if [ "$got" != "$CHAIN_ID" ]; then
    say "refusing to sign: the node at $RPC reports chain id '${got:-?}', not '$CHAIN_ID'" >&2
    exit 1
  fi
  [ -r "$PWFILE" ] || { say "password file $PWFILE is not readable" >&2; exit 1; }
  CHAIN_OK=1
}

# --- transactions ----------------------------------------------------------------
# tx <label> <key> <pkg> <func> [args...]
#   env: GASW (gas-wanted), DEPW (max deposit), SEND (coins), MASTER (session master address),
#        EXPECT=fail (the call must be refused), SIMONLY=1 (simulate even outside DRY).
# Sets TX_OK (0 ok / 1 failed), TX_RET, TX_ERR, TX_GAS, TX_DELTA, TX_REFUND, TX_FEE, TX_TOTAL, TX_LOG.
tx() {
  local label=$1 key=$2 pkg=$3 fn=$4; shift 4
  assert_chain
  local gasw=${GASW:-$GAS} a=() x
  for x in "$@"; do a+=(-args "$x"); done
  [ -n "${SEND:-}" ] && a+=(-send "$SEND")
  [ -n "${MASTER:-}" ] && a+=(-master "$MASTER")
  local sim=test
  if [ "$DRY" = 1 ] || [ "${SIMONLY:-0}" = 1 ]; then sim=only
  elif [ "${EXPECT:-ok}" = fail ]; then
    if [ "$REAL_FAIL" = 1 ]; then sim=skip; else sim=only; fi
  fi
  SEQ=$((SEQ + 1))
  TX_LOG=$LOGS/$(printf '%03d' "$SEQ")-$label.log
  local signer seq0 out i
  signer=${MASTER:-$(addr "$key")}
  for i in 1 2 3 4; do
    [ "$sim" != only ] && seq0=$(seqno "$signer")
    out=$( (cat "$PWFILE"; echo) | "$GNOKEY" maketx call -pkgpath "$pkg" -func "$fn" "${a[@]}" \
      -gas-fee "$(((gasw + 999) / 1000))ugnot" -gas-wanted "$gasw" -max-deposit "${DEPW:-$DEP}" \
      -broadcast -simulate "$sim" -chainid "$CHAIN_ID" -remote "$RPC" -home "$KEYS" \
      -insecure-password-stdin "$key" 2>&1)
    grep -qiE '\b429\b|too many requests' <<<"$out" || break
    if [ "$sim" != only ] && [ "$(seqno "$signer")" != "$seq0" ]; then
      out="$out
rate-limited, but the account sequence moved: the transaction may have landed; check it before re-running"
      break
    fi
    sleep $((i * i * 3))
  done
  { echo "# $key $pkg.$fn $* (simulate=$sim)"; echo "$out"; } >"$TX_LOG"
  [ "$QDELAY" != 0 ] && sleep "$QDELAY"
  if grep -q '^OK!' <<<"$out"; then TX_OK=0; else TX_OK=1; fi
  TX_RET=$(grep -m1 '^(.* [A-Za-z0-9_.]*)$' <<<"$out")
  TX_ERR=$(sed -n '/--= Error =--/{n;s/^Data: //p;q}' <<<"$out" | cut -c1-200)
  if [ -z "$TX_ERR" ] && [ "$TX_OK" = 1 ]; then TX_ERR=$(grep -m1 -iE 'error|panic|refus' <<<"$out" | cut -c1-200); fi
  TX_GAS=$(sed -n 's/^GAS USED: *//p' <<<"$out" | head -1)
  TX_DELTA=$(sed -n 's/^STORAGE DELTA: *\(-\{0,1\}[0-9]*\).*/\1/p' <<<"$out" | head -1)
  TX_FEE=$(sed -n 's/^STORAGE FEE: *\([0-9]*\).*/\1/p' <<<"$out" | head -1)
  TX_REFUND=$(sed -n 's/^STORAGE REFUND: *\([0-9]*\).*/\1/p' <<<"$out" | head -1)
  TX_TOTAL=$(sed -n 's/^TOTAL TX COST: *\(-\{0,1\}[0-9]*\).*/\1/p' <<<"$out" | head -1)
  local st=ok cost="" how=sim total
  [ "$TX_OK" = 1 ] && st=REFUSED
  [ "$sim" != only ] && grep -q '^TX HASH: *[A-Za-z0-9+/=]' <<<"$out" && how=sent
  [ -n "$TX_FEE" ] && cost="deposit ${TX_FEE}"
  [ -n "$TX_REFUND" ] && cost="refund ${TX_REFUND}"
  # TOTAL TX COST is fee + deposit - refund; without storage gnokey omits it.
  total=${TX_TOTAL:-$(((gasw + 999) / 1000))}ugnot
  [ "$how" = sim ] && [ "$TX_OK" = 1 ] && total="0 (not sent)"
  printf '  tx    %-26s %-7s %-4s gas=%-9s storage=%sB %s total=%s %s\n' "$label" "$st" "$how" \
    "${TX_GAS:-?}" "${TX_DELTA:-0}" "$cost" "$total" "$([ "$TX_OK" = 0 ] && echo "$TX_RET" || echo "-- ${TX_ERR}")"
  return 0
}
# tx_ok: tx that must succeed; FAIL and return 1 if it did not.
tx_ok() { tx "$@"; if [ "$TX_OK" != 0 ]; then fail "$1 was refused: $TX_ERR (log $TX_LOG)"; return 1; fi; }
# tx_refused <expected text> <tx args...>: tx that must be refused, with that text in the error.
tx_refused() {
  local want=$1; shift
  EXPECT=fail tx "$@"
  if [ "$TX_OK" = 0 ]; then fail "$1 was accepted but must be refused (log $TX_LOG)"; return 1; fi
  if grep -qF -- "$want" "$TX_LOG"; then pass "$1 refused: $TX_ERR"
  else fail "$1 refused, but not with \"$want\": $TX_ERR (log $TX_LOG)"; fi
}
ret_int() { sed -n 's/^(\([0-9][0-9]*\) .*/\1/p' <<<"$TX_RET"; }

# approve_tok <label> <key> <SYM|wugnot> <amount> -> sets SLOT, the address of the owner's next offer
approve_tok() {
  local label=$1 key=$2 sym=$3 amt=$4 who
  who=$(addr "$key")
  SLOT=$(next_slot "$who")
  case "$sym" in
  wugnot) tx_ok "$label" "$key" gno.land/r/gnoland/wugnot Approve "$SLOT" "$amt" ;;
  *) tx_ok "$label" "$key" "$D" Approve "$sym" "$SLOT" "$amt" ;;
  esac
}
# post <label> <key> <giveKind> <giveKey> <giveID> <giveAmt> <wantKind> <wantKey> <wantID> <wantMin> -> OFFER
post() {
  local label=$1 key=$2; shift 2
  OFFER=
  tx "$label" "$key" "$K" PostIntent "$@" 0
  if [ "$TX_OK" != 0 ]; then
    if [ "$DRY" = 1 ] && grep -q 'approve first, then post' "$TX_LOG"; then
      say "  DRY: PostIntent needs its approval on chain, which DRY only simulated; the rest of this step needs real transactions"
    else
      fail "$label was refused: $TX_ERR (log $TX_LOG)"
    fi
    return 1
  fi
  OFFER=$(ret_int)
  [ -n "$OFFER" ] || { fail "$label: no offer id in the result (log $TX_LOG)"; return 1; }
}

# --- the solver -------------------------------------------------------------------
ensure_solver() {
  [ -x "$SOLVER" ] && [ "$SOLVER" -nt "$REPO/solver/cmd/kylix-solver/main.go" ] && return 0
  say "  building the solver into $SOLVER"
  (cd "$REPO/solver" && go build -o "$SOLVER" ./cmd/kylix-solver) || { say "solver build failed" >&2; exit 1; }
}
# export_ring <ids>: the Kylix book (ExportGraphJSONPage) reduced to these offers.
export_ring() {
  local after=0 n=0 tmp
  tmp=$(mktemp -d "$OUT/export.XXXX")
  while [ $n -lt 40 ]; do
    qstr "$K.ExportGraphJSONPage($after, 500)" >"$tmp/$n.json"
    after=$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["next"] if d.get("hasMore") else "")' "$tmp/$n.json" 2>/dev/null)
    n=$((n + 1))
    [ -n "$after" ] || break
  done
  python3 -I - "$1" "$tmp" "$n" <<'PY'
import json, sys
ids = {int(x) for x in sys.argv[1].split(",")}
pages = [json.load(open("%s/%d.json" % (sys.argv[2], i))) for i in range(int(sys.argv[3]))]
d = pages[0]
d["offers"] = [o for p in pages for o in p.get("offers", []) if int(o["id"]) in ids]
d["hasMore"] = False
if len(d["offers"]) != len(ids):
    sys.exit(1)
print(json.dumps(d))
PY
  local rc=$?
  rm -rf "$tmp"
  return $rc
}
# settle <label> <settler key> <ids> [force func: SettleRing|SettleRingVia]
# Runs the solver, takes the command it prints for exactly this ring (same
# offers), simulates it and then sends it. Sets SETTLE_NET (the
# settler's balance change), plus the TX_* of the send.
settle() {
  local label=$1 key=$2 ids=$3 force=${4:-} sj line="" fn idsarg fee gasw maxdep pass
  ensure_solver
  # Pass 1: the whole book, as a settler would run it. Pass 2, if another ring
  # took one of these offers (the solver picks disjoint rings, oldest first):
  # the same solver on a book holding only this ring's offers, still with live
  # deliverability checks and GnoSwap quotes.
  for pass in ${SOLVER_PASSES:-book ring}; do
    sj=$LOGS/$(printf '%03d' $((SEQ + 1)))-$label-solver-$pass.json
    if [ $pass = book ]; then
      "$SOLVER" --rpc "$RPC_URL" --realm "$K" --chain-id "$CHAIN_ID" --json --print-simulate \
        --key "$key" >"$sj" 2>"$sj.err"
    else
      export_ring "$ids" >"$sj.graph" || { say "  could not export offers $ids"; break; }
      "$SOLVER" --graph "$sj.graph" --rpc "$RPC_URL" --realm "$K" --chain-id "$CHAIN_ID" --json --print-simulate \
        --bridge=true --check-deliverable=true --key "$key" >"$sj" 2>"$sj.err"
    fi
    line=$(python3 -I - "$sj" "$ids" <<'PY'
import json, shlex, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
want = sorted(int(x) for x in sys.argv[2].split(","))
for r in d.get("selected") or []:
    if sorted(r["ids"]) != want:
        continue
    a = shlex.split(r["gnokeyCommand"])
    def flag(f):
        return a[a.index(f) + 1] if f in a else ""
    args = [a[i + 1] for i, x in enumerate(a) if x == "-args"]
    fee = args[1] if len(args) > 1 else ""
    print(r["func"], r["idsArg"], fee or "-", flag("-gas-wanted"), flag("-gas-fee"), flag("-max-deposit"))
    print("SIM", r.get("simulateCommand", ""))
    print("CMD", r["gnokeyCommand"])
    break
PY
)
    [ -n "$line" ] && break
    [ $pass = book ] && say "  the solver, on the whole book, did not select exactly offers $ids (another ring may hold one of them; see $sj); asking it about these offers only"
  done
  if [ -n "$line" ]; then
    read -r fn idsarg fee gasw _ maxdep <<<"$(head -1 <<<"$line")"
    say "  the solver prints ($pass):"
    sed -n 's/^SIM /    /p;s/^CMD /    /p' <<<"$line"
  else
    say "  the solver did not select offers $ids (see $sj and .err); using its sizing formula"
    idsarg=$ids fn=${force:-SettleRing} fee=${GS_FEE}
    local n tokens=0 items=0 mns=0 bridged=0
    n=$(tr ',' '\n' <<<"$ids" | wc -l)
    tokens=${SETTLE_TOKENS:-$n}; items=${SETTLE_ITEMS:-0}; mns=${SETTLE_MNS:-0}; bridged=${SETTLE_BRIDGED:-0}
    gasw=$((25000000 + 5000000 * tokens + 14000000 * mns + 8000000 * (items - mns) + 50000000 * bridged))
    maxdep=$((250000 * tokens + 100000 * items + 250000 * bridged))ugnot
  fi
  if [ -n "$force" ] && [ "$force" != "$fn" ]; then
    say "  this run calls $force instead of the solver's $fn, with the same gas and deposit cap"
    fn=$force
  fi
  local fargs=("$idsarg")
  [ "$fn" = SettleRingVia ] && fargs+=("${fee/-/$GS_FEE}")
  # Simulate first, always.
  GASW=$gasw DEPW=$maxdep SIMONLY=1 tx "$label-simulate" "$key" "$K" "$fn" "${fargs[@]}"
  SETTLE_NET=
  if [ "$TX_OK" != 0 ]; then fail "$label: simulation refused: $TX_ERR (log $TX_LOG)"; return 1; fi
  [ "$DRY" = 1 ] && return 0
  local who b0 b1
  who=$(addr "$key"); b0=$(ugnot "$who")
  GASW=$gasw DEPW=$maxdep tx "$label" "$key" "$K" "$fn" "${fargs[@]}"
  if [ "$TX_OK" != 0 ]; then fail "$label: refused: $TX_ERR (log $TX_LOG)"; return 1; fi
  b1=$(ugnot "$who")
  SETTLE_NET=$((b1 - b0))
}
# settler_story: the settler's balance moved by exactly -TOTAL TX COST, and the
# storage the ring freed paid for the fee (README, "Whoever settles a ring ...").
settler_story() {
  check "$([ "$SETTLE_NET" = "$((-TX_TOTAL))" ] && echo 0 || echo 1)" \
    "settler balance changed by $SETTLE_NET ugnot = -(TOTAL TX COST $TX_TOTAL): fee minus storage refund ${TX_REFUND:-0} (storage ${TX_DELTA}B)"
  check "$([ "${SETTLE_NET:-0}" -gt 0 ] && echo 0 || echo 1)" \
    "settler ends ahead: refund ${TX_REFUND:-0} covers the fee (net $SETTLE_NET ugnot; the README says honest rings measured +0.06 to +1.3 GNOT)"
}

# relic holders: prints "<relic id> <owner>" for every relic.
relic_owners() {
  local supply i expr out
  supply=$(qstr "$D.Render(\"\")" | sed -n 's/^| Kylix Relics (items) | [^|]* | \([0-9]*\) |$/\1/p')
  supply=${supply:-0}
  i=1
  while [ "$i" -le "$supply" ]; do
    expr= ; local j=$i ids=()
    while [ "$j" -le "$supply" ] && [ "$j" -lt $((i + 25)) ]; do
      expr="$expr${expr:++\",\"+}string(OwnerOfRelic(\"relic-$j\"))"; ids+=("relic-$j"); j=$((j + 1))
    done
    out=$(qstr "$D.$expr")
    paste -d' ' <(printf '%s\n' "${ids[@]}") <(tr ',' '\n' <<<"$out")
    i=$j
  done
}
relic_of() { relic_owners | awk -v a="$1" '$2 == a {print $1; exit}'; }

# ================================================================================
step_status() {
  head1 "status: are the packages live, and what do the keys hold? ($CHAIN_ID, $RPC)"
  local p st allok=0
  for p in "$RINGP" "$K" "$D" "$SINA" "$MNSA"; do
    st=$(pkgstatus "$p")
    say "  $p: $st"
    [ "$st" = live ] || allok=1
  done
  check "$allok" "all five packages live (vm/qpkgmeta_json status \"live\")"
  local k a
  for k in "$KEY_OWNER" "$KEY_SETTLER" "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do
    a=$(addr "$k")
    if [ -z "$a" ]; then fail "key $k not found in $KEYS"; continue; fi
    if [ "$allok" = 0 ]; then
      say "  $k $a: $(ugnot "$a") ugnot, OBOL $(tok "$OBOL" "$a"), DRACHMA $(tok "$DRACHMA" "$a"), wugnot $(tok "$WUGNOT" "$a"), GNS $(tok "$GNS" "$a")"
    else
      say "  $k $a: $(ugnot "$a") ugnot"
    fi
  done
  [ "$allok" = 0 ] && say "  open offers: $(qint "$K.OpenOffers()")"
}

step_claim() {
  head1 "claim: $KEY_ANA, $KEY_BEN and $KEY_CLEO take demo tokens and a relic from $D"
  local k a o0 o1 r
  for k in "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do
    a=$(addr "$k"); o0=$(tok "$OBOL" "$a")
    tx "claim-$k" "$k" "$D" Claim
    if [ "$TX_OK" = 0 ]; then
      [ "$DRY" = 1 ] && { say "  DRY: $k's claim simulated"; continue; }
      o1=$(tok "$OBOL" "$a"); r=$(sed -n 's/^("\(relic-[0-9]*\)" string)$/\1/p' <<<"$TX_RET")
      check "$([ "$((o1 - o0))" = 1000 ] && [ "$(qaddr "$D.OwnerOfRelic(\"$r\")")" = "$a" ] && echo 0 || echo 1)" \
        "$k got 1000 OBOL ($o0 -> $o1) and owns $r"
    elif grep -q 'already claimed' "$TX_LOG"; then
      # Cooldown: fine if the account already holds what the steps need.
      local dr
      dr=$(tok "$DRACHMA" "$a")
      check "$([ "$o0" -ge 200 ] && [ "$dr" -ge 100 ] && echo 0 || echo 1)" \
        "$k claimed earlier ($TX_ERR); holds OBOL $o0, DRACHMA $dr"
    else
      fail "$k claim refused: $TX_ERR (log $TX_LOG)"
    fi
  done
  say "  relics held: $(relic_owners | while read -r id o; do for k in "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do [ "$o" = "$(addr "$k")" ] && printf '%s=%s ' "$id" "$k"; done; done)"
}

step_direct() {
  head1 "direct: a ring of three direct offers (100 OBOL -> relic -> 50 DRACHMA), settled by $KEY_SETTLER"
  # Roles as in the README: A gives 100 OBOL for >= 50 DRACHMA, B gives a relic
  # for >= 100 OBOL, C gives 50 DRACHMA for that relic. B is whoever holds a relic.
  local owners kA kB kC relic k
  owners=$(relic_owners)
  for k in "$KEY_BEN" "$KEY_ANA" "$KEY_CLEO"; do
    relic=$(awk -v a="$(addr "$k")" '$2 == a {print $1; exit}' <<<"$owners")
    [ -n "$relic" ] && { kB=$k; break; }
  done
  [ -n "${kB:-}" ] || { fail "none of $KEY_ANA, $KEY_BEN, $KEY_CLEO holds a relic: run the claim step"; return; }
  for k in "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do
    [ "$k" = "$kB" ] && continue
    if [ -z "${kA:-}" ]; then kA=$k; else kC=$k; fi
  done
  local A B C
  A=$(addr "$kA") B=$(addr "$kB") C=$(addr "$kC")
  say "  A=$kA gives 100 OBOL, wants >= 50 DRACHMA; B=$kB gives $relic, wants >= 100 OBOL; C=$kC gives 50 DRACHMA, wants $relic"
  local aO0 aD0 bO0 cD0
  aO0=$(tok "$OBOL" "$A") aD0=$(tok "$DRACHMA" "$A") bO0=$(tok "$OBOL" "$B") cD0=$(tok "$DRACHMA" "$C")
  [ "$aO0" -ge 100 ] && [ "$cD0" -ge 50 ] || { fail "A needs 100 OBOL (has $aO0), C 50 DRACHMA (has $cD0): run claim"; return; }
  local sA sB sC oA oB oC
  approve_tok approve-A "$kA" OBOL 100 || return; sA=$SLOT
  post post-A "$kA" fungible "$OBOL" "" 100 fungible "$DRACHMA" "" 50 || return; oA=$OFFER
  sB=$(next_slot "$B")
  tx_ok approve-B "$kB" "$D" ApproveRelic "$sB" "$relic" || return
  post post-B "$kB" item "$D" "$relic" 0 fungible "$OBOL" "" 100 || return; oB=$OFFER
  approve_tok approve-C "$kC" DRACHMA 50 || return; sC=$SLOT
  post post-C "$kC" fungible "$DRACHMA" "" 50 item "$D" "$relic" 0 || return; oC=$OFFER
  [ "$DRY" = 1 ] && { say "  DRY: the offers were only simulated, so there is no ring to settle"; return; }
  state_set DIRECT_IDS "$oA,$oB,$oC"; state_set DIRECT_SLOT_A "$sA"
  say "  ring: $K:ring/$oA,$oB,$oC"
  SETTLE_TOKENS=2 SETTLE_ITEMS=1 settle settle-direct "$KEY_SETTLER" "$oA,$oB,$oC" || return
  local aO1 aD1 bO1 cD1 own
  aO1=$(tok "$OBOL" "$A") aD1=$(tok "$DRACHMA" "$A") bO1=$(tok "$OBOL" "$B") cD1=$(tok "$DRACHMA" "$C")
  own=$(qaddr "$D.OwnerOfRelic(\"$relic\")")
  check "$([ $((aO0 - aO1)) = 100 ] && [ $((aD1 - aD0)) = 50 ] && echo 0 || echo 1)" "A: OBOL $aO0 -> $aO1 (-100), DRACHMA $aD0 -> $aD1 (+50)"
  check "$([ $((bO1 - bO0)) = 100 ] && echo 0 || echo 1)" "B: OBOL $bO0 -> $bO1 (+100)"
  check "$([ $((cD0 - cD1)) = 50 ] && [ "$own" = "$C" ] && echo 0 || echo 1)" "C: DRACHMA $cD0 -> $cD1 (-50), $relic owner now $own (C=$C)"
  local open=0 i
  for i in $oA $oB $oC; do offer_open "$i" && open=1; done
  check "$open" "offers $oA,$oB,$oC are closed (GetOffer answers not open)"
  local alA alC apB
  alA=$(qint "$D.Allowance(\"OBOL\", \"$A\", \"$sA\")") alC=$(qint "$D.Allowance(\"DRACHMA\", \"$C\", \"$sC\")")
  apB=$(qeval "$D.RelicApproved(\"$relic\", \"$sB\")" | head -1)
  check "$([ "$alA" = 0 ] && [ "$alC" = 0 ] && [ "$apB" = "(false bool)" ] && echo 0 || echo 1)" \
    "approvals used up: A's allowance $alA, C's allowance $alC, B's relic approval $apB"
  settler_story
}

step_refusals() {
  head1 "refusals: what the chain must refuse"
  local A B C x y
  A=$(addr "$KEY_ANA") B=$(addr "$KEY_BEN") C=$(addr "$KEY_CLEO")
  local aO0 bD0
  aO0=$(tok "$OBOL" "$A") bD0=$(tok "$DRACHMA" "$B")
  say "  1. a ring that does not close: $KEY_ANA gives 10 OBOL for >= 10 DRACHMA, $KEY_BEN gives 10 DRACHMA but wants >= 20 OBOL"
  x='' y=''
  if approve_tok refuse-approve-ana "$KEY_ANA" OBOL 10 &&
    post refuse-post-ana "$KEY_ANA" fungible "$OBOL" "" 10 fungible "$DRACHMA" "" 10 && x=$OFFER &&
    approve_tok refuse-approve-ben "$KEY_BEN" DRACHMA 10 &&
    post refuse-post-ben "$KEY_BEN" fungible "$DRACHMA" "" 10 fungible "$OBOL" "" 20 && y=$OFFER; then
    GASW=60000000 DEPW=600000ugnot tx_refused "at least" refuse-settle-open-ring "$KEY_SETTLER" "$K" SettleRing "$x,$y"
    say "  2. cancel by someone who does not own the offer"
    tx_refused "only the owner" refuse-cancel-nonowner "$KEY_CLEO" "$K" CancelIntent "$x"
  else
    [ "$DRY" = 1 ] || return
    skip "1 and 2 need the two offers on chain"
  fi
  say "  3. a spent approval cannot serve again"
  local ids sa
  ids=$(state_get DIRECT_IDS) sa=$(state_get DIRECT_SLOT_A)
  if [ -n "$ids" ]; then
    GASW=60000000 DEPW=600000ugnot tx_refused "not open" refuse-settle-again "$KEY_SETTLER" "$K" SettleRing "$ids"
    [ -n "$sa" ] && say "     the settled offer's slot $sa has OBOL allowance $(qint "$D.Allowance(\"OBOL\", \"$A\", \"$sa\")") left"
  else
    skip "re-settling the direct ring: run the direct step first"
  fi
  say "     posting another 100 OBOL offer without approving its new slot $(next_slot "$A")"
  tx_refused "approve" refuse-post-unapproved "$KEY_ANA" "$K" PostIntent fungible "$OBOL" "" 100 fungible "$DRACHMA" "" 50 0
  say "  4. a blanket approval (ApproveAllRelics) is not accepted"
  local holder hk k relic
  for k in "$KEY_CLEO" "$KEY_ANA" "$KEY_BEN"; do
    relic=$(relic_of "$(addr "$k")"); [ -n "$relic" ] && { hk=$k; break; }
  done
  if [ -z "${hk:-}" ]; then
    skip "blanket approval: none of the keys holds a relic"
  else
    holder=$(addr "$hk")
    local sz
    sz=$(next_slot "$holder")
    tx_ok refuse-approveall "$hk" "$D" ApproveAllRelics "$sz" true &&
      if [ "$DRY" = 1 ]; then say "  DRY: the blanket approval was only simulated"
      else
        tx_refused "approve" refuse-post-blanket "$hk" "$K" PostIntent item "$D" "$relic" 0 fungible "$OBOL" "" 1 0
        tx_ok refuse-revoke-approveall "$hk" "$D" ApproveAllRelics "$sz" false
      fi
  fi
  [ -n "$x" ] && [ -n "$y" ] && [ "$DRY" != 1 ] || return
  say "  clean-up: cancel the two open offers (their deposits come back to the owners; the slot"
  say "  allowances stay, unusable, since a slot's nonce is never reused; approving 0 freed no storage on gnodev)"
  tx_ok refuse-cancel-ana "$KEY_ANA" "$K" CancelIntent "$x"
  tx_ok refuse-cancel-ben "$KEY_BEN" "$K" CancelIntent "$y"
  local aO1 bD1
  aO1=$(tok "$OBOL" "$A") bD1=$(tok "$DRACHMA" "$B")
  check "$([ "$aO0" = "$aO1" ] && [ "$bD0" = "$bD1" ] && ! offer_open "$x" && ! offer_open "$y" && echo 0 || echo 1)" \
    "nothing moved: $KEY_ANA OBOL $aO0 -> $aO1, $KEY_BEN DRACHMA $bD0 -> $bD1; offers $x,$y closed"
}

step_mns() {
  local tid="$MNS_LABEL*$MNS_DOMAIN"
  head1 "mns: $KEY_BEN registers $tid, sells it to $KEY_CLEO for $MNS_PRICE_OBOL OBOL through $MNSA"
  local B C owner price
  B=$(addr "$KEY_BEN") C=$(addr "$KEY_CLEO")
  owner=$(qaddr "$NSN.OwnerOf(\"$tid\")")
  if [ "$owner" = "$C" ]; then
    pass "$tid is already owned by $KEY_CLEO (an earlier run sold it); set MNS_LABEL to run the sale again"
    return
  fi
  if [ -z "$owner" ]; then
    price=$(qint "$NSL.NamePrice(\"$MNS_DOMAIN\", \"$MNS_LABEL\")")
    [ -n "$price" ] || { fail "no price for $tid from $NSL.NamePrice"; return; }
    say "  registering $tid: NamePrice $price ugnot, lease $(($(qint "$NSD.GetTermLength()") / 86400)) days"
    GASW=100000000 DEPW=3000000ugnot SEND=${price}ugnot tx_ok mns-register "$KEY_BEN" "$NSL" RegisterName "$MNS_LABEL" "$MNS_DOMAIN" || return
    [ "$DRY" = 1 ] && { say "  DRY: the name was only simulated, so it cannot be listed"; return; }
    owner=$(qaddr "$NSN.OwnerOf(\"$tid\")")
  fi
  [ "$owner" = "$B" ] || { fail "$tid is owned by ${owner:-nobody}, not $KEY_BEN"; return; }
  local why
  why=$(qstr "$MNSA.Unmovable(\"$tid\")")
  check "$([ -z "$why" ] && echo 0 || echo 1)" "adapter accepts $tid (Unmovable: \"${why}\")"
  [ -z "$why" ] || return
  local nonce spender bO0 cO0
  bO0=$(tok "$OBOL" "$B") cO0=$(tok "$OBOL" "$C")
  nonce=$(next_nonce "$B")
  spender=$(qaddr "$K.ApproveTarget(\"$B\", $nonce, \"$MNSA\")")
  tx_ok mns-approve "$KEY_BEN" "$NSN" Approve "$spender" "$tid" || return
  post mns-post-seller "$KEY_BEN" item "$MNSA" "$tid" 0 fungible "$OBOL" "" "$MNS_PRICE_OBOL" || return; local m=$OFFER
  approve_tok mns-approve-buyer "$KEY_CLEO" OBOL "$MNS_PRICE_OBOL" || return
  post mns-post-buyer "$KEY_CLEO" fungible "$OBOL" "" "$MNS_PRICE_OBOL" item "$MNSA" "$tid" 0 || return; local p=$OFFER
  [ "$DRY" = 1 ] && return
  SETTLE_TOKENS=1 SETTLE_ITEMS=1 SETTLE_MNS=1 settle settle-mns "$KEY_SETTLER" "$m,$p" || return
  local own bO1 cO1 ap
  own=$(qaddr "$NSN.OwnerOf(\"$tid\")") bO1=$(tok "$OBOL" "$B") cO1=$(tok "$OBOL" "$C")
  ap=$(qaddr "$NSN.GetApproved(\"$tid\")")
  check "$([ "$own" = "$C" ] && echo 0 || echo 1)" "$tid owner is now $own ($KEY_CLEO=$C)"
  check "$([ $((bO1 - bO0)) = "$MNS_PRICE_OBOL" ] && [ $((cO0 - cO1)) = "$MNS_PRICE_OBOL" ] && echo 0 || echo 1)" \
    "OBOL: $KEY_BEN $bO0 -> $bO1, $KEY_CLEO $cO0 -> $cO1"
  check "$([ -z "$ap" ] && echo 0 || echo 1)" "the single-name approval was cleared by the move (GetApproved \"$ap\")"
  settler_story
}

step_gnoswap() {
  head1 "gnoswap: $KEY_ANA gives wugnot for >= $GS_OBOL OBOL; $KEY_BEN gives $GS_OBOL OBOL for >= N of $GS_OUT; Kylix swaps the wugnot on GnoSwap"
  local pool
  pool=$(qstr "gno.land/r/gnoswap/pool.GetPoolPath(\"$WUGNOT\", \"$GS_OUT\", $GS_FEE)")
  if ! qeval "gno.land/r/gnoswap/pool.ExistsPoolPath(\"$pool\")" | grep -q '(true bool)'; then
    skip "no GnoSwap pool $pool on this chain"; return
  fi
  say "  pool $pool balances: $(qeval "gno.land/r/gnoswap/pool.GetBalances(\"$pool\")" | head -2 | tr '\n' ' ')"
  local A B q1 q2 m1 m2
  A=$(addr "$KEY_ANA") B=$(addr "$KEY_BEN")
  local route="$WUGNOT:$GS_OUT:$GS_FEE"
  quote() { qeval "gno.land/r/gnoswap/router.DrySwapRoute(\"$WUGNOT\",\"$GS_OUT\",\"$1\",\"EXACT_IN\",\"$route\",\"100\",\"1\")" | sed -n '2s/^("\([0-9]*\)" string)$/\1/p'; }
  if [ -n "${GS_MIN1:-}" ] && [ -n "${GS_MIN2:-}" ]; then
    q1=- q2=- m1=$GS_MIN1 m2=$GS_MIN2
    say "  minimums set by GS_MIN1/GS_MIN2: $m1, $m2 (no quote taken)"
  else
    q1=$(quote "$GS_IN1"); q2=$(quote "$GS_IN2")
    [ -n "$q1" ] && [ -n "$q2" ] || { fail "DrySwapRoute gave no quote for $route"; return; }
    m1=$((q1 * (10000 - GS_SLIP_BPS) / 10000)) m2=$((q2 * (10000 - GS_SLIP_BPS) / 10000))
    say "  quotes (net of the LP and router fees): $GS_IN1 wugnot -> $q1, $GS_IN2 -> $q2; minimums ($GS_SLIP_BPS bps under): $m1, $m2"
  fi
  local have need
  have=$(tok "$WUGNOT" "$A"); need=$((GS_IN1 + GS_IN2))
  if [ "$have" -lt "$need" ]; then
    local wrap=$((need - have)); [ "$wrap" -lt 1000 ] && wrap=1000
    say "  wrapping $wrap ugnot into wugnot for $KEY_ANA (holds $have)"
    SEND=${wrap}ugnot tx_ok gs-wrap "$KEY_ANA" gno.land/r/gnoland/wugnot Deposit || return
  fi
  local n in min fn
  for n in 1 2; do
    if [ $n = 1 ]; then in=$GS_IN1 min=$m1 fn=SettleRing; else in=$GS_IN2 min=$m2 fn=SettleRingVia; fi
    say "  ring $n ($fn): $KEY_ANA gives $in wugnot, $KEY_BEN wants >= $min of $GS_OUT"
    local aW0 aO0 bO0 bG0 x y
    aW0=$(tok "$WUGNOT" "$A") aO0=$(tok "$OBOL" "$A") bO0=$(tok "$OBOL" "$B") bG0=$(tok "$GS_OUT" "$B")
    approve_tok "gs$n-approve-ana" "$KEY_ANA" wugnot "$in" || return
    post "gs$n-post-ana" "$KEY_ANA" fungible "$WUGNOT" "" "$in" fungible "$OBOL" "" "$GS_OBOL" || return; x=$OFFER
    approve_tok "gs$n-approve-ben" "$KEY_BEN" OBOL "$GS_OBOL" || return
    post "gs$n-post-ben" "$KEY_BEN" fungible "$OBOL" "" "$GS_OBOL" fungible "$GS_OUT" "" "$min" || return; y=$OFFER
    [ "$DRY" = 1 ] && continue
    SETTLE_TOKENS=2 SETTLE_BRIDGED=1 settle "settle-gs$n" "$KEY_SETTLER" "$x,$y" "$fn" || return
    local aW1 aO1 bO1 bG1 sw sg
    aW1=$(tok "$WUGNOT" "$A") aO1=$(tok "$OBOL" "$A") bO1=$(tok "$OBOL" "$B") bG1=$(tok "$GS_OUT" "$B")
    check "$([ $((aW0 - aW1)) = "$in" ] && [ $((aO1 - aO0)) = "$GS_OBOL" ] && echo 0 || echo 1)" \
      "$KEY_ANA: wugnot $aW0 -> $aW1 (-$in), OBOL $aO0 -> $aO1 (+$GS_OBOL)"
    check "$([ $((bG1 - bG0)) -ge "$min" ] && [ $((bO0 - bO1)) = "$GS_OBOL" ] && echo 0 || echo 1)" \
      "$KEY_BEN: $GS_OUT $bG0 -> $bG1 (+$((bG1 - bG0)), minimum $min, quote $( [ $n = 1 ] && echo "$q1" || echo "$q2")), OBOL $bO0 -> $bO1"
    local SA
    SA=$(qaddr "$K.SettleAddress()")
    sw=$(tok "$WUGNOT" "$SA") sg=$(tok "$GS_OUT" "$SA")
    check "$([ "$sw" = 0 ] && [ "$sg" = 0 ] && echo 0 || echo 1)" "Kylix's settle address $SA holds nothing after the swap (wugnot $sw, out token $sg)"
    say "  settler: balance change $SETTLE_NET ugnot (TOTAL TX COST $TX_TOTAL, storage ${TX_DELTA}B; GnoSwap's own writes are charged here)"
  done
}

step_sinopia() {
  head1 "sinopia: sell a Final Sinopia3 artwork through $SINA"
  local cj ej
  cj=$(qstr "$CORE.Collections(0, 100)") ej=$(qstr "$CORE.Engines(0, 100)")
  [ -n "$cj" ] || { skip "cannot read $CORE.Collections"; return; }
  # Accepted by the adapter: Final, engine not living, and either the genesis
  # engine (reviewed by Kylix) or an engine the Sinopia3 admin marked reviewed.
  local acc
  acc=$(python3 -I -c '
import json, sys
cols, engs = json.loads(sys.argv[1]), json.loads(sys.argv[2] or "[]")
e = {x["id"]: x for x in engs}
ok = "gno.land/r/g1jz6j9hj6rdf5ltl2kcrpa4jwtdh3w30z0yul06/sinopia3/engines/genesis"
for c in cols:
    en = e.get(c["engine"], {})
    if c["state"] == "final" and not en.get("living") and (c["engine"] == ok or en.get("status") == "reviewed"):
        print(c["cid"], c["minted"] + c.get("reserved", 0))' "$cj" "$ej")
  say "  collections the adapter accepts (Final, reviewed non-living engine): $(awk '{printf "%s ", $1}' <<<"$acc")"
  if [ -z "$acc" ]; then skip "no Sinopia3 collection on this chain is Final with an accepted engine"; return; fi
  local k a cid n bal tid found='' seller
  for k in "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do
    a=$(addr "$k")
    while read -r cid n; do
      [ -n "$cid" ] || continue
      bal=$(qint "$CORE.BalanceOf(\"$cid\", \"$a\")")
      [ "${bal:-0}" -gt 0 ] || continue
      for tid in $(seq 1 "$n"); do
        [ "$(qaddr "$CORE.OwnerOf(\"$cid\", \"$tid\")")" = "$a" ] && { found=$cid/$tid; seller=$k; break 3; }
      done
    done <<<"$acc"
  done
  if [ -z "$found" ]; then
    local lst=""
    while read -r cid n; do [ -n "$cid" ] && lst="$lst $cid:$(qstr "$MARKET.ListingsByCollection(\"$cid\", 0, 50)" | grep -o '"tid"' | wc -l)"; done <<<"$acc"
    skip "none of $KEY_ANA, $KEY_BEN, $KEY_CLEO holds an accepted artwork. Minting is closed on every Final collection, and market/v1 listings per accepted collection:${lst}. Ask a holder to transfer or list one (then buy it with $MARKET.Buy), and re-run."
    return
  fi
  local S2 buyer
  if [ "$seller" = "$KEY_CLEO" ]; then buyer=$KEY_ANA; else buyer=$KEY_CLEO; fi
  S2=$(addr "$seller")
  local B2 nonce spender cid2=${found%/*} tid2=${found#*/}
  B2=$(addr "$buyer")
  say "  $seller owns $found; selling it to $buyer for 50 OBOL"
  nonce=$(next_nonce "$S2")
  spender=$(qaddr "$K.ApproveTarget(\"$S2\", $nonce, \"$SINA\")")
  tx_ok sin-approve "$seller" "$CORE" Approve "$cid2" "$tid2" "$spender" || return
  post sin-post-seller "$seller" item "$SINA" "$found" 0 fungible "$OBOL" "" 50 || return; local m=$OFFER
  approve_tok sin-approve-buyer "$buyer" OBOL 50 || return
  post sin-post-buyer "$buyer" fungible "$OBOL" "" 50 item "$SINA" "$found" 0 || return; local p=$OFFER
  [ "$DRY" = 1 ] && return
  SETTLE_TOKENS=1 SETTLE_ITEMS=1 settle settle-sinopia "$KEY_SETTLER" "$m,$p" || return
  local own
  own=$(qaddr "$CORE.OwnerOf(\"$cid2\", \"$tid2\")")
  check "$([ "$own" = "$B2" ] && echo 0 || echo 1)" "$found owner is now $own ($buyer=$B2)"
  settler_story
}

step_notify() {
  head1 "notify: EnableNotifications refused for a non-owner, accepted for the namespace owner; then a settlement"
  local active
  active=$(qstr "$GNOTIF.Active(\"$K\")")
  say "  gnotif triggers for $K before: \"${active}\""
  # Opening the handle and storing the trigger costs about 16.2 KB in gnotif
  # (1.62 GNOT, measured on gnodev), so these two calls get a 3 GNOT cap.
  if [ -n "$active" ]; then
    skip "notifications are already enabled, so gnotif answers \"already holds a handle\" before it checks the caller: the non-owner refusal shows only on the first run"
  elif qeval "gno.land/r/sys/names.IsEnabled()" | grep -q '(true bool)'; then
    DEPW=3000000ugnot tx_refused "not authorized for namespace" notify-nonowner "$KEY_ANA" "$K" EnableNotifications
  else
    skip "r/sys/names is disabled on this chain, so every key may act for every namespace: the non-owner refusal can only be seen where it is enabled (onyx-1)"
  fi
  local O
  O=$(addr "$KEY_OWNER")
  if ! qeval "gno.land/r/sys/names.IsAuthorizedAddressForNamespace(\"$O\", \"$NS\")" | grep -q '(true bool)'; then
    fail "$KEY_OWNER ($O) is not authorized for namespace $NS in r/sys/names, so gnotif would refuse it too; set KEY_OWNER"
  elif [ -n "$active" ]; then
    pass "notifications already enabled (trigger ids $active); the owner's call would be refused as \"already holds a handle\""
  else
    DEPW=3000000ugnot tx_ok notify-owner "$KEY_OWNER" "$K" EnableNotifications
    if [ "$DRY" != 1 ]; then
      active=$(qstr "$GNOTIF.Active(\"$K\")")
      check "$([ -n "$active" ] && echo 0 || echo 1)" "gnotif lists trigger(s) $active for $K"
    fi
  fi
  say "  a settlement that emits OfferSettled for both owners: $KEY_ANA 5 OBOL <-> $KEY_BEN 5 DRACHMA"
  approve_tok notify-approve-ana "$KEY_ANA" OBOL 5 || return
  post notify-post-ana "$KEY_ANA" fungible "$OBOL" "" 5 fungible "$DRACHMA" "" 5 || return; local x=$OFFER
  approve_tok notify-approve-ben "$KEY_BEN" DRACHMA 5 || return
  post notify-post-ben "$KEY_BEN" fungible "$DRACHMA" "" 5 fungible "$OBOL" "" 5 || return; local y=$OFFER
  [ "$DRY" = 1 ] && return
  settle settle-notify "$KEY_SETTLER" "$x,$y" || return
  local n hash
  n=$(grep -o '"type":"OfferSettled"' "$TX_LOG" | wc -l)
  hash=$(sed -n 's/^TX HASH: *//p' "$TX_LOG" | head -1)
  check "$([ "$n" = 2 ] && echo 0 || echo 1)" "the settle tx emitted $n OfferSettled events (tx $hash)"
  say "  What gnotif records on chain is the trigger, not each delivery: gnotif servers watch"
  say "  OfferSettled events of $K and notify an owner who turned trigger $(qstr "$GNOTIF.Active(\"$K\")") on."
  say "  See it: $GNOTIF:target/$K  (gnoweb: https://onyx.testnets.gno.land/r/nym-gfanton001/gnotif/v1:target/$K)"
  say "  The events, from the indexer:"
  say "    curl -s https://indexer.onyx.testnets.gno.land/graphql/query -H 'content-type: application/json' \\"
  say "      --data '{\"query\":\"{ getTransactions(where: {hash: {eq: \\\"$hash\\\"}}) { block_height response { events { ... on GnoEvent { type pkg_path attrs { key value } } } } } }\"}'"
}

step_session() {
  head1 "session: a session key of $KEY_ANA posts and settles, and is refused on cancel"
  local A SA pub n=1 base=$KEY_SESSION
  A=$(addr "$KEY_ANA")
  # A session key's address must not already be an account. A key that has a
  # live session of ana's is reused; one whose address is an account (it was
  # ever funded, or gnodev funded its keybase at genesis) is skipped for a
  # fresh name: kylix-session, kylix-session-2, ...
  while :; do
    SA=$(addr "$KEY_SESSION")
    [ -z "$SA" ] && break
    grep -q "$SA" <<<"$(q "auth/accounts/$A/session/$SA")" && break
    q "auth/accounts/$SA" | grep -q '"address": "g1' || break
    say "  $KEY_SESSION's address $SA is already an account, so it cannot be a session key"
    n=$((n + 1)); KEY_SESSION=$base-$n
    [ $n -le 9 ] || { fail "no usable session key name ($base-2 .. $base-9 all taken)"; return; }
  done
  if [ -z "$(addr "$KEY_SESSION")" ]; then
    say "  creating key $KEY_SESSION in $KEYS (no mnemonic is shown or kept outside the keybase)"
    (cat "$PWFILE"; echo; cat "$PWFILE"; echo) | "$GNOKEY" add -home "$KEYS" -insecure-password-stdin -quiet -nobackup "$KEY_SESSION" >/dev/null 2>&1 ||
      { fail "could not create key $KEY_SESSION"; return; }
  fi
  SA=$(addr "$KEY_SESSION") pub=$(pubkey "$KEY_SESSION")
  local sess
  sess=$(q "auth/accounts/$A/session/$SA")
  if grep -q "$SA" <<<"$sess"; then
    say "  session $SA of $KEY_ANA already exists"
  else
    say "  creating session $SA for $KEY_ANA: calls to $K and $D only, spend limit $SESSION_SPEND, 24h"
    assert_chain
    SEQ=$((SEQ + 1)); TX_LOG=$LOGS/$(printf '%03d' "$SEQ")-session-create.log
    local sim=test; [ "$DRY" = 1 ] && sim=only
    (cat "$PWFILE"; echo) | "$GNOKEY" maketx session create -pubkey "$pub" \
      -allow-paths "vm/exec:$K" -allow-paths "vm/exec:$D" -expires-at 24h -spend-limit "$SESSION_SPEND" \
      -gas-fee 10000ugnot -gas-wanted 10000000 -broadcast -simulate "$sim" -chainid "$CHAIN_ID" -remote "$RPC" \
      -home "$KEYS" -insecure-password-stdin "$KEY_ANA" >"$TX_LOG" 2>&1
    if grep -q '^OK!' "$TX_LOG"; then say "  tx    session-create             ok      gas=$(sed -n "s/^GAS USED: *//p" "$TX_LOG")"
    else fail "session create refused: $(sed -n '/--= Error =--/{n;p;q}' "$TX_LOG") (log $TX_LOG)"; return; fi
    [ "$DRY" = 1 ] && { say "  DRY: the session was only simulated, so it cannot sign"; return; }
  fi
  local B aO0 aD0
  B=$(addr "$KEY_BEN")
  aO0=$(tok "$OBOL" "$A") aD0=$(tok "$DRACHMA" "$A")
  local slot x y z
  slot=$(next_slot "$A")
  MASTER=$A tx_ok sess-approve "$KEY_SESSION" "$D" Approve OBOL "$slot" 7 || return
  MASTER=$A post sess-post "$KEY_SESSION" fungible "$OBOL" "" 7 fungible "$DRACHMA" "" 7 || return; x=$OFFER
  if [ "$DRY" != 1 ]; then
    local own via
    own=$(qeval "$K.GetOffer($x)" | grep -o 'g1[a-z0-9]\{38\}' | head -1)
    via=$(qeval "$K.GetOffer($x)" | head -1 | grep -o '([a-z]* bool)} [^ ]*Offer)$' | grep -o 'true\|false')
    check "$([ "$own" = "$A" ] && [ "$via" = true ] && echo 0 || echo 1)" "offer $x belongs to $KEY_ANA ($own) and is marked posted through a session ($via)"
  fi
  approve_tok sess-approve-ben "$KEY_BEN" DRACHMA 7 || return
  post sess-post-ben "$KEY_BEN" fungible "$DRACHMA" "" 7 fungible "$OBOL" "" 7 || return; y=$OFFER
  [ "$DRY" = 1 ] && return
  # The session settles the ring it is part of.
  local GW=35000000
  GASW=$GW DEPW=500000ugnot MASTER=$A tx_ok sess-settle "$KEY_SESSION" "$K" SettleRing "$x,$y" || return
  local aO1 aD1
  aO1=$(tok "$OBOL" "$A") aD1=$(tok "$DRACHMA" "$A")
  check "$([ $((aO0 - aO1)) = 7 ] && [ $((aD1 - aD0)) = 7 ] && echo 0 || echo 1)" "the session settled: $KEY_ANA OBOL $aO0 -> $aO1, DRACHMA $aD0 -> $aD1"
  slot=$(next_slot "$A")
  MASTER=$A tx_ok sess-approve-2 "$KEY_SESSION" "$D" Approve OBOL "$slot" 3 || return
  MASTER=$A post sess-post-2 "$KEY_SESSION" fungible "$OBOL" "" 3 fungible "$DRACHMA" "" 3 || return; z=$OFFER
  MASTER=$A tx_refused "session key cannot cancel" sess-cancel "$KEY_SESSION" "$K" CancelIntent "$z"
  tx_ok sess-cancel-by-account "$KEY_ANA" "$K" CancelIntent "$z" &&
    check "$(offer_open "$z" && echo 1 || echo 0)" "$KEY_ANA's own key cancelled offer $z"
}

step_seed() {
  head1 "seed: leave a ring of three open offers on the page (the README story), unsettled"
  # Same roles as the direct step, but nothing is settled: the home page then
  # shows a ring that is ready, for a person or the solver to settle.
  local owners kA kB kC relic k
  owners=$(relic_owners)
  for k in "$KEY_BEN" "$KEY_ANA" "$KEY_CLEO"; do
    relic=$(awk -v a="$(addr "$k")" '$2 == a {print $1; exit}' <<<"$owners")
    [ -n "$relic" ] && { kB=$k; break; }
  done
  [ -n "${kB:-}" ] || { fail "none of $KEY_ANA, $KEY_BEN, $KEY_CLEO holds a relic: run the claim step"; return; }
  for k in "$KEY_ANA" "$KEY_BEN" "$KEY_CLEO"; do
    [ "$k" = "$kB" ] && continue
    if [ -z "${kA:-}" ]; then kA=$k; else kC=$k; fi
  done
  local B sB oA oB oC
  B=$(addr "$kB")
  say "  A=$kA gives 100 OBOL, wants >= 50 DRACHMA; B=$kB gives $relic, wants >= 100 OBOL; C=$kC gives 50 DRACHMA, wants $relic"
  approve_tok seed-approve-A "$kA" OBOL 100 || return
  post seed-post-A "$kA" fungible "$OBOL" "" 100 fungible "$DRACHMA" "" 50 || return; oA=$OFFER
  sB=$(next_slot "$B")
  tx_ok seed-approve-B "$kB" "$D" ApproveRelic "$sB" "$relic" || return
  post seed-post-B "$kB" item "$D" "$relic" 0 fungible "$OBOL" "" 100 || return; oB=$OFFER
  approve_tok seed-approve-C "$kC" DRACHMA 50 || return
  post seed-post-C "$kC" fungible "$DRACHMA" "" 50 item "$D" "$relic" 0 || return; oC=$OFFER
  [ "$DRY" = 1 ] && return
  check "$(offer_open "$oA" && offer_open "$oB" && offer_open "$oC" && echo 0 || echo 1)" "offers $oA,$oB,$oC are open; ring page: $K:ring/$oA,$oB,$oC"
}

# ================================================================================
STEPS="status claim direct refusals mns gnoswap sinopia notify session seed"
[ $# -gt 0 ] || { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ "$1" = all ] && set -- ${STEPS% seed}
for s in "$@"; do
  case " $STEPS " in *" $s "*) ;; *) say "unknown step '$s' (steps: $STEPS, or all)" >&2; exit 2 ;; esac
done
say "Kylix rehearsal on $CHAIN_ID via $RPC, namespace $NS$([ "$DRY" = 1 ] && echo ', DRY (simulate only)'). Logs: $LOGS"
for s in "$@"; do "step_$s"; done
printf '\n%d passed, %d failed, %d skipped. Logs: %s\n' "$NPASS" "$NFAIL" "$NSKIP" "$LOGS"
[ "$NFAIL" = 0 ]

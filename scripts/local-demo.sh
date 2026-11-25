#!/usr/bin/env bash
# Local Kylix demo: start an in-memory gnodev chain on this machine, deploy
# Kylix, and seed a small scenario with throwaway accounts.
#
#   GNOROOT=/path/to/gno-v1.8.0 scripts/local-demo.sh          start (or restart) and seed
#   scripts/local-demo.sh stop                                stop the node
#   scripts/local-demo.sh status                              is it running?
#
# Safety:
#   - It never contacts a network. Dependencies that are not in this repo or in
#     $GNOROOT/examples (gnotif, Sinopia3, MNS) are copied from the module cache
#     that `make deps` fills; gnodev runs without -remote.
#   - Every transaction is signed for chain id "dev" and sent to this script's
#     own port, after checking that the node there reports chain id "dev". A
#     public node rejects a transaction signed for another chain id.
#   - Keys are throwaway keys generated into .local-demo/keys (gitignored),
#     with a fixed local-only password. Never use them anywhere else.
#   - Running it again stops the old node and starts a fresh chain; the keys are
#     reused.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
DEMO=$REPO/.local-demo
KEYS=$DEMO/keys
RPC_PORT=${RPC_PORT:-51657}
WEB_PORT=${WEB_PORT:-51888}
RPC=127.0.0.1:$RPC_PORT
GNODEV=${GNODEV:-gnodev}
GNOKEY=${GNOKEY:-gnokey}
PW=local-demo-only
K=gno.land/r/nym-kylix000/kylix
D=gno.land/r/nym-kylix000/kylixdemo
OBOL=$D.OBOL
DRACHMA=$D.DRACHMA

stop_node() {
  if [ -f "$DEMO/gnodev.pid" ]; then
    local pid
    pid=$(cat "$DEMO/gnodev.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      echo "stopped node (pid $pid)"
    fi
    rm -f "$DEMO/gnodev.pid"
  fi
}

case "${1:-start}" in
stop) stop_node; exit 0 ;;
status)
  if [ -f "$DEMO/gnodev.pid" ] && kill -0 "$(cat "$DEMO/gnodev.pid")" 2>/dev/null; then
    echo "running: http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylix (rpc $RPC)"
  else
    echo "not running"
  fi
  exit 0 ;;
start) ;;
*) echo "usage: $0 [start|stop|status]" >&2; exit 2 ;;
esac

: "${GNOROOT:?set GNOROOT to a gno v1.8.0 checkout (the version the testnet runs)}"
command -v "$GNODEV" >/dev/null || { echo "gnodev not found (set GNODEV)" >&2; exit 1; }
command -v "$GNOKEY" >/dev/null || { echo "gnokey not found (set GNOKEY)" >&2; exit 1; }
mkdir -p "$DEMO" "$KEYS"
stop_node

for p in $RPC_PORT $WEB_PORT; do
  if (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null; then
    echo "port $p is in use; set RPC_PORT / WEB_PORT to free ports" >&2
    exit 1
  fi
done

# --- throwaway accounts ------------------------------------------------------
ACCOUNTS="deployer ana ben cleo dora eli"
for a in $ACCOUNTS; do
  if ! "$GNOKEY" list -home "$KEYS" 2>/dev/null | grep -q " $a ("; then
    printf '%s\n%s\n' "$PW" "$PW" | "$GNOKEY" add -home "$KEYS" -insecure-password-stdin -quiet -nobackup "$a" >/dev/null 2>&1
  fi
done
addr() { "$GNOKEY" list -home "$KEYS" | grep " $1 (" | sed 's/.*addr: \([^ ]*\).*/\1/'; }

# --- third-party dependencies from the `make deps` cache ------------------------
# Packages Kylix's realms import that are neither in this repo nor in
# $GNOROOT/examples, with their own imports, copied into .local-demo/deps.
CACHE=${GNOHOME:-$REPO/.gnohome}/pkg/mod
[ -d "$CACHE/gno.land" ] || { echo "no module cache at $CACHE: run 'make deps GNOROOT=...' first" >&2; exit 1; }
rm -rf "$DEMO/deps"
python3 -I - "$REPO" "$GNOROOT/examples" "$CACHE" "$DEMO/deps" <<'PY'
import os, re, shutil, sys
repo, examples, cache, out = sys.argv[1:]
roots = ["p/ring", "r/kylix", "r/kylixdemo", "r/adapters/nsnft", "r/adapters/sinopia3",
         "r/mocks/gnoswap/pool", "r/mocks/gnoswap/router"]
# Also deployed, though nothing in the demo imports it: MNS's logic realm,
# through which the demo registers a name the way a user does.
extra = ["gno.land/r/nym-mnsrehearsal001/nslogic/v2"]
block = re.compile(r'^import\s*\((.*?)^\)', re.S | re.M)
single = re.compile(r'^import\s+(?:\w+\s+)?"([^"]+)"', re.M)
path = re.compile(r'"(gno\.land/[^"]+)"')
def imports(d):
    s = set()
    for f in os.listdir(d):
        if f.endswith(".gno") and not f.endswith("_test.gno") and not f.endswith("_filetest.gno"):
            src = open(os.path.join(d, f)).read()
            for b in block.findall(src):
                s |= set(path.findall(b))
            s |= {p for p in single.findall(src) if p.startswith("gno.land/")}
    return s
local = {}
for dp, dirs, files in os.walk(repo):
    dirs[:] = [d for d in dirs if not d.startswith(".")]  # skip .gnohome, .local-demo, .git
    if "gnomod.toml" in files:
        m = re.search(r'module\s*=\s*"([^"]+)"', open(os.path.join(dp, "gnomod.toml")).read())
        if m: local[m.group(1)] = dp
todo = [i for r in roots for i in imports(os.path.join(repo, r))] + extra
seen, copied = set(), []
while todo:
    p = todo.pop()
    if p in seen: continue
    seen.add(p)
    if p in local or os.path.isdir(os.path.join(examples, p)):
        d = local.get(p) or os.path.join(examples, p)
        if p not in local: todo += list(imports(d))
        continue
    src = os.path.join(cache, p)
    if not os.path.isdir(src):
        sys.exit("missing dependency %s: run 'make deps' first" % p)
    shutil.copytree(src, os.path.join(out, p), ignore=shutil.ignore_patterns("*_test.gno", "*_filetest.gno"))
    copied.append(p)
    todo += list(imports(src))
print("dependencies from the module cache:", ", ".join(sorted(copied)))
PY

# --- start the node ---------------------------------------------------------
# gnodev loads every module of the workspace it starts in, and the repo's
# workspace includes the test mocks (hostile and legacy collections), which
# would then show up on the collections page. So the node starts in a
# workspace of its own holding a copy of only what the demo deploys.
WS=$DEMO/ws
MODULES="p/ring r/kylix r/kylixdemo r/adapters/nsnft r/adapters/sinopia3 r/mocks/gnoswap/pool r/mocks/gnoswap/router"
rm -rf "$WS"; mkdir -p "$WS"
{
  echo 'gno = "0.9"'
  echo 'modules = ['
  for m in $MODULES; do
    mkdir -p "$WS/$m"
    cp -R "$REPO/$m/." "$WS/$m/"
    echo "  \"./$m\","
  done
  echo ']'
} >"$WS/gnowork.toml"
cd "$WS"
GNOROOT=$GNOROOT GNOHOME=${GNOHOME:-$REPO/.gnohome} setsid nohup "$GNODEV" local \
  -root "$GNOROOT" -home "$KEYS" -chain-id dev \
  -node-rpc-listener "$RPC" -web-listener "127.0.0.1:$WEB_PORT" \
  -deploy-key "$(addr deployer)" -no-watch -extra-root "$DEMO/deps" \
  >"$DEMO/gnodev.log" 2>&1 &
echo $! >"$DEMO/gnodev.pid"

chain_id() { curl -s "http://$RPC/status" | python3 -I -c "import sys,json; print(json.load(sys.stdin)['result']['node_info']['network'])" 2>/dev/null; }
for _ in $(seq 1 120); do
  [ "$(chain_id)" = dev ] && break
  kill -0 "$(cat "$DEMO/gnodev.pid")" 2>/dev/null || { echo "gnodev exited; see $DEMO/gnodev.log" >&2; exit 1; }
  sleep 1
done
[ "$(chain_id)" = dev ] || { echo "node did not come up; see $DEMO/gnodev.log" >&2; stop_node; exit 1; }

# --- seed ---------------------------------------------------------------------
LOG=$DEMO/seed.log
: >"$LOG"
call() { # call <key> <pkgpath> <func> [args...]   (SEND=<coins> attaches coins)
  [ "$(chain_id)" = dev ] || { echo "refusing: node at $RPC is not chain dev" >&2; exit 1; }
  local key=$1 pkg=$2 fn=$3; shift 3
  local a=()
  for x in "$@"; do a+=(-args "$x"); done
  [ -n "${SEND:-}" ] && a+=(-send "$SEND")
  local out
  if ! out=$(echo "$PW" | "$GNOKEY" maketx call -pkgpath "$pkg" -func "$fn" "${a[@]}" \
      -gas-fee 1000000ugnot -gas-wanted 100000000 -max-deposit 5000000ugnot \
      -broadcast -chainid dev -remote "$RPC" -home "$KEYS" -insecure-password-stdin "$key" 2>&1); then
    echo "$out" >>"$LOG"; echo "FAILED: $key $fn $*  (see $LOG)" >&2; exit 1
  fi
  echo "== $key $fn $*" >>"$LOG"; echo "$out" >>"$LOG"
  echo "$out" | sed -n 's/^(\(.*\) [a-z0-9]*)$/\1/p' | head -1
}
slot() { "$GNOKEY" query vm/qeval -data "$K.NextSlot(\"$(addr "$1")\")" -remote "$RPC" | grep -o 'g1[a-z0-9]*' | tail -1; }
give_tok() { # give_tok <who> <SYMBOL> <amount> <wantKind> <wantKey> <wantID> <wantMin>  -> offer id
  local who=$1 sym=$2 amt=$3; shift 3
  call "$who" $D Approve "$sym" "$(slot "$who")" "$amt" >/dev/null
  call "$who" $K PostIntent fungible "$D.$sym" "" "$amt" "$@" 0
}
give_relic() { # give_relic <who> <relic id> <wantKind> <wantKey> <wantID> <wantMin>  -> offer id
  local who=$1 id=$2; shift 2
  call "$who" $D ApproveRelic "$(slot "$who")" "$id" >/dev/null
  call "$who" $K PostIntent item $D "$id" 0 "$@" 0
}

for a in ana ben cleo eli; do call $a $D Claim >/dev/null; done  # ana relic-1, ben relic-2, cleo relic-3, eli relic-4

# Ready 3-offer ring (the example on the About page).
A=$(give_tok ana OBOL 100 fungible "$DRACHMA" "" 50)
B=$(give_relic ben relic-2 fungible "$OBOL" "" 100)
C=$(give_tok cleo DRACHMA 50 item $D relic-2 0)
# A 2-offer ring that dora, who owns nothing in it, settles at once.
E=$(give_tok eli DRACHMA 40 fungible "$OBOL" "" 40)
F=$(give_tok ben OBOL 40 fungible "$DRACHMA" "" 40)
call dora $K SettleRing "$E,$F" >/dev/null
# An offer waiting for a match.
W=$(give_relic eli relic-4 fungible "$OBOL" "" 200)

# A real MNS name, registered the way a user does: the registry's admin (the
# deployer here) trusts the logic realm, as on the testnet; cleo pays nslogic
# for "cleo*gnoland", approves the adapter's address for her next offer and
# lists the name for at least 150 OBOL.
NSD=gno.land/r/nym-mnsrehearsal001/nsdata/v2
NSL=gno.land/r/nym-mnsrehearsal001/nslogic/v2
NSN=gno.land/r/nym-mnsrehearsal001/nsnft/v2
MNS=gno.land/r/nym-kylix000/adapters/nsnft
qeval() { "$GNOKEY" query vm/qeval -data "$1" -remote "$RPC" | sed -n 's/^data: //p'; }
# pkgaddr <pkgpath>: a realm's address, bech32("g", sha256("pkgPath:"+path)[:20]).
pkgaddr() { python3 -I - "$1" <<'PY'
import hashlib, sys
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def polymod(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5):
            c ^= g[i] if (b >> i) & 1 else 0
    return c
def to5(data):
    acc = bits = 0; out = []
    for x in data:
        acc = (acc << 8) | x; bits += 8
        while bits >= 5:
            bits -= 5; out.append((acc >> bits) & 31)
    if bits: out.append((acc << (5 - bits)) & 31)
    return out
d = to5(hashlib.sha256(("pkgPath:" + sys.argv[1]).encode()).digest()[:20])
p = polymod([3, 0, 7] + d + [0] * 6) ^ 1
print("g1" + "".join(CH[x] for x in d + [(p >> 5 * (5 - i)) & 31 for i in range(6)]))
PY
}
call deployer $NSD ProposeTrustedLogicGrant "$(pkgaddr $NSL)" >/dev/null
call deployer $NSD ExecutePending grantLogic >/dev/null
# sell_name <who> <label> <min OBOL>: who registers <label>*gnoland, paying
# nslogic, approves the adapter's address for this one name (an approval for
# all names is not accepted) and lists it.  -> offer id
sell_name() {
  local who=$1 label=$2 min=$3 price nonce
  price=$(qeval "$NSL.NamePrice(\"gnoland\", \"$label\")" | grep -o '[0-9]*' | head -1)
  SEND=${price}ugnot call "$who" $NSL RegisterName "$label" gnoland >/dev/null
  nonce=$(qeval "$K.NextSlot(\"$(addr "$who")\")" | head -1 | grep -o '[0-9]*' | head -1)
  call "$who" $NSN Approve "$(qeval "$K.ApproveTarget(\"$(addr "$who")\", $nonce, \"$MNS\")" | grep -o 'g1[a-z0-9]*')" "$label*gnoland" >/dev/null
  call "$who" $K PostIntent item $MNS "$label*gnoland" 0 fungible "$OBOL" "" "$min" 0
}
# One name is sold at once, so the adapter's whole path runs on every demo:
# ben sells ben*gnoland, dora buys it with exactly 120 OBOL, eli settles.
echo "== MNS sale: ben*gnoland to dora, settled by eli" >>"$LOG"
M=$(sell_name ben ben 120)
call dora $D Claim >/dev/null
P=$(give_tok dora OBOL 120 item $MNS "ben*gnoland" 0)
call eli $K SettleRing "$M,$P" >/dev/null
[ "$(qeval "$NSN.OwnerOf(\"ben*gnoland\")" | grep -o 'g1[a-z0-9]*')" = "$(addr dora)" ] ||
  { echo "MNS sale did not move the name; see $LOG" >&2; exit 1; }
echo "== MNS sale settled: ben*gnoland now owned by dora" >>"$LOG"
# And one name stays for sale.
N=$(sell_name cleo cleo 150)

cat <<EOF

Kylix local demo is running (chain id dev, rpc $RPC).

  Home:              http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylix
  Ring ready:        http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylix:ring/$A,$B,$C
  Waiting offer:     http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylix:offer/$W
  MNS name for sale: http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylix:offer/$N
  Demo faucet:       http://127.0.0.1:$WEB_PORT/r/nym-kylix000/kylixdemo

Offers $E,$F were posted by eli and ben and settled by dora; offers $M,$P sold the MNS name
ben*gnoland to dora and were settled by eli (see the seed log). Settle the ready ring yourself
(the fee is the minimum at the base gas price; the storage refund leaves the settler ahead):

  $GNOKEY maketx call -pkgpath $K -func SettleRing -args $A,$B,$C \\
    -gas-fee 43000ugnot -gas-wanted 43000000 -max-deposit 500000ugnot \\
    -broadcast -chainid dev -remote $RPC -home $KEYS dora      (password: $PW)

Accounts (keys in $KEYS): $(for a in $ACCOUNTS; do printf '%s=%s ' "$a" "$(addr "$a")"; done)
Node log: $DEMO/gnodev.log   Seed log: $LOG   Stop: scripts/local-demo.sh stop
EOF

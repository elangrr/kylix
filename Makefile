# Usage:
#   make check GNOROOT=/path/to/gno-v1.8.0-checkout     fmt, lint, unit and filetests
#   make integration GNOROOT=...                          adapters against real collections
#   make demo GNOROOT=...                                 local in-memory chain with a seeded demo
#   make demo-stop GNOROOT=...                            stop it (see scripts/README.md)
#
# GNOROOT must point at the gno version the testnet runs (v1.8.0).
#
# Dependencies that are not in this workspace (p/nt packages, grc20reg and
# the third-party collections the adapters drive) are downloaded from the
# testnet into .gnohome, a gitignored module cache, by `make deps`. Without
# it, `gno` would fetch them from rpc.gno.land, a different network whose
# copies differ from the testnet's.

GNO       ?= gno
TESTNET   ?= https://rpc.onyx.testnets.gno.land:443
GNOHOME   ?= $(CURDIR)/.gnohome
PYTHON    ?= python3

CORE      := ./p/ring ./r/kylix ./r/kylixdemo ./r/mocks/hostile ./r/mocks/legacy721 \
             ./r/mocks/legacyadapter ./r/mocks/storagebomb ./r/mocks/gnoswap/pool ./r/mocks/gnoswap/router \
             ./r/mocks/sinopiaengine/living ./r/mocks/sinopiaengine/plain
ADAPTERS  := ./r/adapters/nsnft ./r/adapters/sinopia3 ./r/adapters/adaptertest

ifndef GNOROOT
$(error set GNOROOT to a gno v1.8.0 checkout)
endif
export GNOROOT GNOHOME

.PHONY: check test integration lint fmt fmt-check deps filetests demo demo-stop

check: fmt-check lint test

deps:
	$(GNO) mod download -remote-overrides gno.land=$(TESTNET)

test: deps
	$(GNO) test -v $(CORE)

integration: deps
	$(GNO) test -v $(ADAPTERS)

lint: deps
	$(GNO) lint $(CORE) $(ADAPTERS)

fmt:
	$(GNO) fmt -w $(CORE) $(ADAPTERS)

fmt-check: deps
	$(GNO) fmt -diff $(CORE) $(ADAPTERS)

# Regenerate r/kylix/filetests from tools/gen_filetests.py.
filetests:
	$(PYTHON) tools/gen_filetests.py

# Local demo on an in-memory gnodev chain. It never touches a network: it
# uses the module cache, so run `make deps` once first (that only reads
# package source from the testnet).
demo:
	scripts/local-demo.sh start

demo-stop:
	scripts/local-demo.sh stop

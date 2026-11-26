// Everything the app needs to know about the chain and the deployed packages,
// in one place. Gas limits and deposit caps come from transactions measured on
// onyx-1 (README "What it costs", scripts/testnet-rehearsal.sh) and from the
// solver (solver/cmd/kylix-solver/main.go: ringGasWanted, ringMaxDeposit).

export const CHAIN_ID = 'onyx-1';
export const CHAIN_NAME = 'Gno.land Onyx testnet';

// JSON-RPC over POST. Both answer browsers with access-control-allow-origin: *.
export const RPC_URL = 'https://rpc.onyx.testnets.gno.land';
// The URL Adena ships for onyx-1 (with :443), used only when asking Adena to
// add the network.
export const WALLET_RPC_URL = 'https://rpc.onyx.testnets.gno.land:443';
export const INDEXER_URL = 'https://indexer.onyx.testnets.gno.land/graphql/query';
export const GNOWEB_URL = 'https://onyx.testnets.gno.land';

export const NAMESPACE = 'nym-kylix000';

export const PATHS = {
  kylix: `gno.land/r/${NAMESPACE}/kylix`,
  kylixdemo: `gno.land/r/${NAMESPACE}/kylixdemo`,
  ring: `gno.land/p/${NAMESPACE}/ring/v0`,
  adapterMns: `gno.land/r/${NAMESPACE}/adapters/nsnft`,
  adapterSinopia3: `gno.land/r/${NAMESPACE}/adapters/sinopia3`,
  grc20reg: 'gno.land/r/nt/grc20reg/v0',
  wugnot: 'gno.land/r/gnoland/wugnot',
  gns: 'gno.land/r/gnoswap/gns',
} as const;

// Token keys as r/nt/grc20reg knows them: <realm path>.<symbol>. Anyone can
// register a token with any symbol, so the app must show the full key where
// someone decides.
export const TOKENS = {
  OBOL: `${PATHS.kylixdemo}.OBOL`,
  DRACHMA: `${PATHS.kylixdemo}.DRACHMA`,
  WUGNOT: `${PATHS.wugnot}.wugnot`,
  GNS: `${PATHS.gns}.GNS`,
} as const;

// The demo collection's key is the kylixdemo realm path.
export const RELICS_COLLECTION = PATHS.kylixdemo;

// Gas limits that worked on onyx-1, with headroom over what was used.
export const GAS = {
  approve: 10_000_000, // 6 to 7M used
  post: 35_000_000, // 20 to 30M used
  cancel: 15_000_000, // 11M used
  prune: 15_000_000, // 10.4M used locally
  claim: 20_000_000, // 12 to 15M used
  // Settle, as the solver sizes it: base + per offer + GnoSwap hop.
  settleBase: 25_000_000,
  settlePerTokenOffer: 5_000_000,
  settlePerItemOffer: 25_000_000,
  settleBridge: 150_000_000,
} as const;

// The fee is flat: at least gas wanted / 1,000 ugnot.
export const GAS_PER_UGNOT = 1_000;

// Storage costs 100 ugnot per byte, charged to the signer. Every message
// carries a cap (max_deposit, in ugnot). Without one the chain falls back to
// its default of 100 GNOT.
export const UGNOT_PER_BYTE = 100;
export const DEPOSIT = {
  approve: 500_000n, // measured up to 0.214 GNOT
  post: 1_500_000n, // 0.06 to 0.10 GNOT; 0.5 to 1.0 for an account's first offer
  cancel: 500_000n, // frees storage; the cap only guards a surprise
  prune: 500_000n,
  claim: 1_500_000n, // measured 1.02 GNOT
  // Settle, as the solver's --max-deposit auto computes it.
  settlePerTokenHop: 250_000n,
  settlePerItemHop: 100_000n,
  settleBridgeExtra: 250_000n,
} as const;

// GnoSwap fee tiers SettleRingVia accepts.
export const GNOSWAP_FEE_TIERS = [100, 500, 3000, 10000] as const;

// Realm limits (r/kylix).
export const LIMITS = {
  exportPageMax: 500,
  deliverableBatch: 50,
  ringMinLegs: 2,
  ringMaxLegs: 6,
  blocksPerDay: 17_280,
  defaultExpiryBlocks: 7 * 17_280,
  maxExpiryBlocks: 30 * 17_280,
  maxItemIdLength: 64,
} as const;

// kylixdemo faucet.
export const FAUCET = {
  claimTokens: 1000,
  cooldownBlocks: 720,
} as const;

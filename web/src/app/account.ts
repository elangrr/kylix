// What the connected account holds: GNOT, the known tokens, its demo relics,
// and when it may claim from the demo faucet again.

import type { FaucetStatus, KylixClient } from '../lib/kylix.ts'
import { PATHS } from '../lib/config.ts'
import { KNOWN_TOKENS } from './assets.ts'
import { chain } from './market.ts'

export interface AccountData {
  address: string
  /** In ugnot. */
  gnot: bigint
  /** Known tokens; null when no token is registered under the key. */
  tokens: Map<string, bigint | null>
  /** Items the account holds and can offer, as { key, id }. */
  items: Array<{ key: string; id: string }>
  faucet: FaucetStatus
}

export async function loadAccount(address: string, client: KylixClient = chain()): Promise<AccountData> {
  const [gnot, tokens, relics, faucet] = await Promise.all([
    client.gnotBalance(address),
    client.tokenBalances(KNOWN_TOKENS.map((t) => t.key), address),
    client.relicsOf(address),
    client.faucetStatus(address),
  ])
  const items = relics.map((id) => ({ key: PATHS.kylixdemo, id }))
  return { address, gnot, tokens, items, faucet }
}

export function itemValue(i: { key: string; id: string }): string {
  return `${i.key}#${i.id}`
}

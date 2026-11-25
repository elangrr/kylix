// PKGPATH: gno.land/r/nym-kylix000/kylix/filetests/notify_events
package notify_events

// Verifies that SettleRing keeps RingSettled unchanged and emits one
// OfferSettled event per owner with recipient, offer id, ring, gave, and
// exact received amount (both direct and GnoSwap-bridged rings).

import (
	"chain"
	"strconv"
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/r/gnoswap/pool"
	"gno.land/r/nym-kylix000/kylix"
	"gno.land/r/nym-kylix000/kylixdemo"
)

var (
	u1      = testutils.TestAddress("u1")
	u2      = testutils.TestAddress("u2")
	u3      = testutils.TestAddress("u3")
	u4      = testutils.TestAddress("u4")
	settler = testutils.TestAddress("settler")
	ringIDs string
)

func claim(cur realm, who address) {
	testing.SetRealm(testing.NewUserRealm(who))
	kylixdemo.Claim(cross(cur))
}

func init(cur realm) {
	for _, u := range []address{u1, u2, u3, u4} {
		claim(cur, u)
	}
	// Pool OBOL/DRACHMA at fee 3000, 1:1, 1000 DRACHMA liquidity.
	pool.MockCreatePool(cross(cur), kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA"), 3000, 1, 1)
	testing.SetRealm(testing.NewUserRealm(u4))
	kylixdemo.Approve(cross(cur), "DRACHMA", chain.PackageAddress("gno.land/r/gnoswap/pool"), 1000)
	pool.MockFund(cross(cur), kylixdemo.TokenKey("OBOL"), kylixdemo.TokenKey("DRACHMA"), 3000, kylixdemo.TokenKey("DRACHMA"), 1000)

	// u1: 1000 OBOL -> u2 (bridged to DRACHMA, gets 996)
	_, s1 := kylix.NextSlot(u1)
	testing.SetRealm(testing.NewUserRealm(u1))
	kylixdemo.Approve(cross(cur), "OBOL", s1, 1000)
	a := kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey("OBOL"), "", 1000, "fungible", kylixdemo.TokenKey("DRACHMA"), "", 50, 0)

	// u2: relic-2 -> u3
	_, s2 := kylix.NextSlot(u2)
	testing.SetRealm(testing.NewUserRealm(u2))
	kylixdemo.ApproveRelic(cross(cur), s2, "relic-2")
	b := kylix.PostIntent(cross(cur), "item", kylixdemo.CollectionKey(), "relic-2", 0, "fungible", kylixdemo.TokenKey("DRACHMA"), "", 990, 0)

	// u3: 50 DRACHMA -> u1
	_, s3 := kylix.NextSlot(u3)
	testing.SetRealm(testing.NewUserRealm(u3))
	kylixdemo.Approve(cross(cur), "DRACHMA", s3, 50)
	c := kylix.PostIntent(cross(cur), "fungible", kylixdemo.TokenKey("DRACHMA"), "", 50, "item", kylixdemo.CollectionKey(), "relic-2", 0, 0)

	ringIDs = strconv.FormatUint(a, 10) + "," + strconv.FormatUint(b, 10) + "," + strconv.FormatUint(c, 10)
}

func main(cur realm) {
	testing.SetRealm(testing.NewUserRealm(settler))
	kylix.SettleRing(cross(cur), ringIDs)
	println("settled", ringIDs)
}

// Output:
// settled 1,2,3

// Events:
// [
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-1"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "Claimed",
//     "attrs": [
//       {
//         "key": "to",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "relic",
//         "value": "relic-1"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylixdemo"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-2"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "Claimed",
//     "attrs": [
//       {
//         "key": "to",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "relic",
//         "value": "relic-2"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylixdemo"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-3"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "Claimed",
//     "attrs": [
//       {
//         "key": "to",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "relic",
//         "value": "relic-3"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylixdemo"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "from",
//         "value": ""
//       },
//       {
//         "key": "to",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-4"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "Claimed",
//     "attrs": [
//       {
//         "key": "to",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "relic",
//         "value": "relic-4"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylixdemo"
//   },
//   {
//     "type": "Approval",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "spender",
//         "value": "g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": "g1w5697h6lta047h6lta047h6lta047h6lfnx389"
//       },
//       {
//         "key": "to",
//         "value": "g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Approval",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "spender",
//         "value": "g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "IntentPosted",
//     "attrs": [
//       {
//         "key": "id",
//         "value": "1"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "slot",
//         "value": "g1mu8fjvjfk5yv2gf0yf6naqrrunzz8cd2hcr98f"
//       },
//       {
//         "key": "give",
//         "value": "1000 gno.land/r/nym-kylix000/kylixdemo.OBOL"
//       },
//       {
//         "key": "want",
//         "value": "50 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       },
//       {
//         "key": "expiry",
//         "value": "121083"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "Approval",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "to",
//         "value": "g155s6a2zs37jtpr77fj39vhh2u648akluhm55ru"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-2"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "IntentPosted",
//     "attrs": [
//       {
//         "key": "id",
//         "value": "2"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "slot",
//         "value": "g155s6a2zs37jtpr77fj39vhh2u648akluhm55ru"
//       },
//       {
//         "key": "give",
//         "value": "gno.land/r/nym-kylix000/kylixdemo#relic-2"
//       },
//       {
//         "key": "want",
//         "value": "990 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       },
//       {
//         "key": "expiry",
//         "value": "121083"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "Approval",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "spender",
//         "value": "g1392xhqu05fkza095n7txr0eemjj8lwplfxvaqa"
//       },
//       {
//         "key": "value",
//         "value": "50"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "IntentPosted",
//     "attrs": [
//       {
//         "key": "id",
//         "value": "3"
//       },
//       {
//         "key": "owner",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "slot",
//         "value": "g1392xhqu05fkza095n7txr0eemjj8lwplfxvaqa"
//       },
//       {
//         "key": "give",
//         "value": "50 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       },
//       {
//         "key": "want",
//         "value": "gno.land/r/nym-kylix000/kylixdemo#relic-2"
//       },
//       {
//         "key": "expiry",
//         "value": "121083"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "to",
//         "value": "g14aptc3xpjahxy0f02ygq3qql9qgh5u6t3efjv4"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Approval",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "owner",
//         "value": "g14aptc3xpjahxy0f02ygq3qql9qgh5u6t3efjv4"
//       },
//       {
//         "key": "spender",
//         "value": "g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.OBOL.0000001"
//       },
//       {
//         "key": "from",
//         "value": "g14aptc3xpjahxy0f02ygq3qql9qgh5u6t3efjv4"
//       },
//       {
//         "key": "to",
//         "value": "g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v"
//       },
//       {
//         "key": "value",
//         "value": "1000"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": "g1dexaf6aqkkyr9yfy9d5up69lsn7ra80af34g5v"
//       },
//       {
//         "key": "to",
//         "value": "g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp"
//       },
//       {
//         "key": "value",
//         "value": "997"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": "g1vc883gshu5z7ytk5cdynhc8c2dh67pdp4cszkp"
//       },
//       {
//         "key": "to",
//         "value": "g14aptc3xpjahxy0f02ygq3qql9qgh5u6t3efjv4"
//       },
//       {
//         "key": "value",
//         "value": "996"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": "g14aptc3xpjahxy0f02ygq3qql9qgh5u6t3efjv4"
//       },
//       {
//         "key": "to",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "value",
//         "value": "996"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.RELIC.0000001"
//       },
//       {
//         "key": "from",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "to",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "tokenId",
//         "value": "relic-2"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc721/v0"
//   },
//   {
//     "type": "Transfer",
//     "attrs": [
//       {
//         "key": "token",
//         "value": "gno.land/r/nym-kylix000/kylixdemo.DRACHMA.0000002"
//       },
//       {
//         "key": "from",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "to",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "value",
//         "value": "50"
//       }
//     ],
//     "pkg_path": "gno.land/p/nt/grc20/v0"
//   },
//   {
//     "type": "RingSettled",
//     "attrs": [
//       {
//         "key": "ids",
//         "value": "1,2,3"
//       },
//       {
//         "key": "legs",
//         "value": "3"
//       },
//       {
//         "key": "settler",
//         "value": "g1wdjhgarvv4e97h6lta047h6lta047h6lva5znj"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "OfferSettled",
//     "attrs": [
//       {
//         "key": "owner",
//         "value": "g1w5c47h6lta047h6lta047h6lta047h6ly5kscr"
//       },
//       {
//         "key": "id",
//         "value": "1"
//       },
//       {
//         "key": "ring",
//         "value": "1,2,3"
//       },
//       {
//         "key": "gave",
//         "value": "1000 gno.land/r/nym-kylix000/kylixdemo.OBOL"
//       },
//       {
//         "key": "received",
//         "value": "50 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "OfferSettled",
//     "attrs": [
//       {
//         "key": "owner",
//         "value": "g1w5e97h6lta047h6lta047h6lta047h6lkdczk9"
//       },
//       {
//         "key": "id",
//         "value": "2"
//       },
//       {
//         "key": "ring",
//         "value": "1,2,3"
//       },
//       {
//         "key": "gave",
//         "value": "gno.land/r/nym-kylix000/kylixdemo#relic-2"
//       },
//       {
//         "key": "received",
//         "value": "996 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   },
//   {
//     "type": "OfferSettled",
//     "attrs": [
//       {
//         "key": "owner",
//         "value": "g1w5e47h6lta047h6lta047h6lta047h6lk7uxhr"
//       },
//       {
//         "key": "id",
//         "value": "3"
//       },
//       {
//         "key": "ring",
//         "value": "1,2,3"
//       },
//       {
//         "key": "gave",
//         "value": "50 gno.land/r/nym-kylix000/kylixdemo.DRACHMA"
//       },
//       {
//         "key": "received",
//         "value": "gno.land/r/nym-kylix000/kylixdemo#relic-2"
//       }
//     ],
//     "pkg_path": "gno.land/r/nym-kylix000/kylix"
//   }
// ]

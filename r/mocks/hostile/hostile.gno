// Package hostile is a TEST-ONLY collection that registers with Kylix and
// misbehaves on demand. Never deploy it: every function is unauthenticated
// on purpose, so tests can drive it.
//
// In ModeHonest it is an ordinary GRC721 collection. In every other mode its
// move function attacks Kylix instead of, or as well as, moving the item.
package hostile

import (
	"errors"
	"strconv"

	"gno.land/p/nt/grc721/v0"
	"gno.land/r/nt/grc20reg/v0"
	"gno.land/r/nym-kylix000/kylix"
)

const (
	ModeHonest        = "honest"
	ModeReenterSettle = "reenter-settle" // call kylix.SettleRing during the move
	ModeReenterPost   = "reenter-post"   // call kylix.PostIntent during the move
	ModeReenterCancel = "reenter-cancel" // call kylix.CancelIntent during the move
	ModeNoMove        = "no-move"        // return nil without moving the item
	ModeError         = "error"          // return an error
	ModePanic         = "panic"          // panic
	// ModeSteal tries to spend a token allowance as the slot that called it.
	ModeSteal = "steal"
)

var (
	tok *grc721.Token
	led *grc721.PrivateLedger

	mode = ModeHonest

	// Targets for the attacking modes.
	reenterIDs  string  // ring for ModeReenterSettle
	cancelID    uint64  // offer for ModeReenterCancel
	postGiveKey string  // token key for ModeReenterPost
	stealKey    string  // token for ModeSteal
	stealFrom   address // victim for ModeSteal
	stealAmount int64
)

func init(cur realm) {
	tok, led = grc721.NewToken("Hostile Mock", "HOSTILE", 1, cur)
	kylix.RegisterItem(cross(cur), "Hostile Mock", Move, OwnerOf)
}

// SetMode switches behaviour. See the Mode constants.
func SetMode(cur realm, m string) {
	switch m {
	case ModeHonest, ModeReenterSettle, ModeReenterPost, ModeReenterCancel,
		ModeNoMove, ModeError, ModePanic, ModeSteal:
		mode = m
	default:
		panic("hostile: unknown mode " + m)
	}
}

// SetReenterSettle sets the ring ModeReenterSettle tries to settle.
func SetReenterSettle(cur realm, ids string) { reenterIDs = ids }

// SetReenterCancel sets the offer ModeReenterCancel tries to cancel.
func SetReenterCancel(cur realm, id uint64) { cancelID = id }

// SetReenterPost sets the token ModeReenterPost offers.
func SetReenterPost(cur realm, key string) { postGiveKey = key }

// SetSteal sets what ModeSteal tries to take.
func SetSteal(cur realm, key string, from address, amount int64) {
	stealKey, stealFrom, stealAmount = key, from, amount
}

// PostAsSelf posts an offer owned by this realm, giving `amount` of token
// key for at least wantMin of token wantKey. The realm must hold the amount;
// it approves its offer's address first, as posting requires.
func PostAsSelf(cur realm, key string, amount int64, wantKey string, wantMin int64) uint64 {
	_, slot := kylix.NextSlot(cur.Address())
	grc20reg.Approve(0, cur, key, slot, amount)
	return kylix.PostIntent(cross(cur), "fungible", key, "", amount, "fungible", wantKey, "", wantMin, 0)
}

// Mint creates an item. Unauthenticated: test only.
func Mint(cur realm, to address, id string) {
	if err := led.Mint(to, grc721.TokenID(id)); err != nil {
		panic(err)
	}
}

// Approve lets spender move one of the caller's items.
func Approve(cur realm, spender address, id string) {
	if err := led.CallerTeller().Approve(0, cur, spender, grc721.TokenID(id)); err != nil {
		panic(err)
	}
}

// Direct calls a collection's or adapter's move function as this realm, the
// way any realm can call an exported crossing function.
func Direct(cur realm, move kylix.MoveFn, from, to address, id string) error {
	return move(cross(cur), from, to, id)
}

// ForgeSlot mints, in this realm's namespace, a sub-identity with the same
// subpath Kylix uses for a slot ("w/<owner>/<nonce>") and calls move as it.
// Its address differs from the real slot because the host path differs.
func ForgeSlot(cur realm, move kylix.MoveFn, owner address, nonce uint64, from, to address, id string) error {
	sub := cur.Sub("w/" + owner.String() + "/" + strconv.FormatUint(nonce, 10))
	return move(cross(sub), from, to, id)
}

// Move is the MoveFn registered with Kylix.
func Move(cur realm, from, to address, itemID string) error {
	switch mode {
	case ModeReenterSettle:
		kylix.SettleRing(cross(cur), reenterIDs)
	case ModeReenterPost:
		kylix.PostIntent(cross(cur), "fungible", postGiveKey, "", 1, "item", cur.PkgPath(), "x", 0, 0)
	case ModeReenterCancel:
		kylix.CancelIntent(cross(cur), cancelID)
	case ModeNoMove:
		return nil
	case ModeError:
		return errors.New("hostile: refusing to move")
	case ModePanic:
		panic("hostile: panic inside move")
	case ModeSteal:
		// cur.Previous() is the Kylix slot that called us. It is not the
		// live crossing frame here, so the registry must refuse it.
		slot := cur.Previous()
		grc20reg.TransferFrom(0, slot, stealKey, stealFrom, cur.Address(), stealAmount)
	}
	return led.CallerTeller().TransferFrom(0, cur, from, to, grc721.TokenID(itemID))
}

// OwnerOf is the OwnerFn registered with Kylix. It always tells the truth,
// which is what lets Kylix catch ModeNoMove.
func OwnerOf(id kylix.ItemID) address {
	owner, err := tok.OwnerOf(grc721.TokenID(id))
	if err != nil {
		return ""
	}
	return owner
}

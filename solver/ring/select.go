package ring

import "sort"

// SelectRings picks a non-overlapping subset of candidate rings to settle.
//
// Selection rule (greedy, deterministic, no optimisation solver):
//  1. Longer rings first (6 legs down to 2) so multi-party rings that cannot
//     clear bilaterally settle more offers per transaction.
//  2. Direct rings before bridged rings of the same length (lower gas, no
//     GnoSwap fee or slippage exposure).
//  3. Oldest offers first: compare each ring's offer IDs sorted ascending,
//     lexicographically (smallest offer ID wins; ties break on the next ID).
//  4. Canonical ring-order tie-break (lexicographic by ring IDs) so the order
//     is total even if two rings ever shared the same ID set.
//
// After sorting, rings are taken greedily: a ring is selected if none of its
// offers were already claimed by an earlier selected ring.
func SelectRings(candidates []Ring) []Ring {
	if len(candidates) == 0 {
		return nil
	}

	type ranked struct {
		ring      Ring
		sortedIDs []uint64
	}
	items := make([]ranked, len(candidates))
	for i, r := range candidates {
		sorted := make([]uint64, len(r.IDs))
		copy(sorted, r.IDs)
		sort.Slice(sorted, func(a, b int) bool { return sorted[a] < sorted[b] })
		items[i] = ranked{ring: r, sortedIDs: sorted}
	}

	sort.Slice(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if len(a.ring.IDs) != len(b.ring.IDs) {
			return len(a.ring.IDs) > len(b.ring.IDs)
		}
		if a.ring.IsBridged() != b.ring.IsBridged() {
			return !a.ring.IsBridged()
		}
		if cmp := compareIDSeq(a.sortedIDs, b.sortedIDs); cmp != 0 {
			return cmp < 0
		}
		return compareIDSeq(a.ring.IDs, b.ring.IDs) < 0
	})

	used := make(map[uint64]struct{})
	selected := make([]Ring, 0, len(items))
	for _, it := range items {
		overlap := false
		for _, id := range it.ring.IDs {
			if _, ok := used[id]; ok {
				overlap = true
				break
			}
		}
		if overlap {
			continue
		}
		for _, id := range it.ring.IDs {
			used[id] = struct{}{}
		}
		selected = append(selected, it.ring)
	}
	return selected
}

package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"time"

	"kylix/solver/ring"
)

const (
	// MaxDeliverableBatch is the maximum number of offer IDs accepted in a
	// single Kylix Deliverable(ids) read-only query.
	MaxDeliverableBatch = 50

	deliverableRetryDelay = 250 * time.Millisecond
)

// DeliverableStatus is one offer's result from Kylix's Deliverable(ids) query.
type DeliverableStatus struct {
	ID          uint64 `json:"id"`
	Deliverable bool   `json:"deliverable"`
	Reason      string `json:"reason,omitempty"`
}

// DeliverableResult holds the outcome of checking a set of offers via
// Deliverable(ids). Offers in Unknown could not be verified (for example,
// because another settlement was in flight and the retry still failed, or a
// collection panicked); callers should treat them as undeliverable (fail closed).
// Warnings contains fixed short summaries safe to surface to an agent;
// VerboseWarnings includes the underlying RPC/VM error details for human debugging.
type DeliverableResult struct {
	Statuses        map[uint64]DeliverableStatus
	Unknown         []uint64
	Warnings        []string
	VerboseWarnings []string
}

// ParseDeliverableJSON decodes what Kylix's read-only Deliverable(ids) query
// returns: {"height":N,"offers":[{"id":7,"deliverable":true,"reason":""},...]}.
// A bare array of the same items is accepted too. Kept in one small function
// so a wire-format change only touches this decoder.
func ParseDeliverableJSON(raw []byte) ([]DeliverableStatus, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var items []DeliverableStatus
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, fmt.Errorf("parse Deliverable json: %w", err)
		}
		return items, nil
	}
	var wrapped struct {
		Offers []DeliverableStatus `json:"offers"`
	}
	if err := json.Unmarshal(trimmed, &wrapped); err != nil {
		return nil, fmt.Errorf("parse Deliverable json: %w", err)
	}
	return wrapped.Offers, nil
}

// CheckDeliverable queries Kylix's read-only Deliverable(ids) endpoint in
// batches of at most MaxDeliverableBatch (50) unique offer IDs.
//
// Because Deliverable can fail while another settlement transaction is in
// progress, any batch error is retried once. If the retry also fails, the
// batch's IDs are recorded in Unknown (with a fixed safe summary in Warnings
// and raw error details in VerboseWarnings) so the caller can fail closed and
// drop affected rings without aborting the entire run.
func CheckDeliverable(ctx context.Context, client *Client, realmPath string, ids []uint64) DeliverableResult {
	res := DeliverableResult{
		Statuses: make(map[uint64]DeliverableStatus, len(ids)),
	}
	unique := uniqueSortedIDs(ids)
	if len(unique) == 0 {
		return res
	}
	if client == nil {
		res.Unknown = append(res.Unknown, unique...)
		msg := "deliverability check skipped: nil rpc client"
		res.Warnings = append(res.Warnings, msg)
		res.VerboseWarnings = append(res.VerboseWarnings, msg)
		return res
	}
	if realmPath == "" {
		realmPath = DefaultRealmPath
	}

	sleepFn := client.Sleep
	if sleepFn == nil {
		sleepFn = sleepWithContext
	}

	for start := 0; start < len(unique); start += MaxDeliverableBatch {
		end := start + MaxDeliverableBatch
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[start:end]

		items, err := queryDeliverableBatch(ctx, client, realmPath, chunk)
		if err != nil {
			// Treat failure as unknown and retry once.
			if sleepErr := sleepFn(ctx, deliverableRetryDelay); sleepErr == nil {
				items, err = queryDeliverableBatch(ctx, client, realmPath, chunk)
			}
		}
		if err != nil {
			res.Unknown = append(res.Unknown, chunk...)
			var safeWarn string
			if len(chunk) == 1 {
				safeWarn = fmt.Sprintf("Deliverable check failed for offer #%d (marked undeliverable)", chunk[0])
			} else {
				safeWarn = fmt.Sprintf("Deliverable check failed for offers [%s] (marked undeliverable)", ring.FormatOfferIDs(chunk))
			}
			res.Warnings = append(res.Warnings, safeWarn)
			res.VerboseWarnings = append(res.VerboseWarnings, fmt.Sprintf(
				"Deliverable(%s) failed after retry (marked undeliverable): %v",
				ring.FormatOfferIDs(chunk), err,
			))
			continue
		}

		seenInBatch := make(map[uint64]bool, len(items))
		for _, st := range items {
			res.Statuses[st.ID] = st
			seenInBatch[st.ID] = true
		}
		for _, id := range chunk {
			if !seenInBatch[id] {
				res.Unknown = append(res.Unknown, id)
				msg := fmt.Sprintf("Deliverable response omitted offer #%d (marked undeliverable)", id)
				res.Warnings = append(res.Warnings, msg)
				res.VerboseWarnings = append(res.VerboseWarnings, msg)
			}
		}
	}
	return res
}

func queryDeliverableBatch(ctx context.Context, client *Client, realmPath string, ids []uint64) ([]DeliverableStatus, error) {
	idsArg := ring.FormatOfferIDs(ids)
	expr := fmt.Sprintf("Deliverable(%s)", strconv.Quote(idsArg))
	raw, err := client.QueryEval(ctx, realmPath, expr)
	if err != nil {
		return nil, err
	}
	lines := ParseEvalLines(raw)
	if len(lines) != 1 {
		return nil, fmt.Errorf("expected 1 return value from %s, got %d", expr, len(lines))
	}
	jsonStr, err := ParseEvalString(lines[0])
	if err != nil {
		return nil, fmt.Errorf("decode %s string: %w", expr, err)
	}
	return ParseDeliverableJSON([]byte(jsonStr))
}

func uniqueSortedIDs(ids []uint64) []uint64 {
	if len(ids) == 0 {
		return nil
	}
	seen := make(map[uint64]struct{}, len(ids))
	out := make([]uint64, 0, len(ids))
	for _, id := range ids {
		if id == 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

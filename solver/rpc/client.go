// Package rpc provides read-only Gno.land ABCI vm/qeval queries for the
// Kylix solver, with rate-limit backoff and GnoSwap DrySwapRoute quoting.
package rpc

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// DefaultOnyxRPC is the public onyx-1 testnet RPC endpoint.
	DefaultOnyxRPC = "https://rpc.onyx.testnets.gno.land:443"

	defaultTimeout     = 30 * time.Second
	defaultMaxRetries  = 5
	defaultBaseBackoff = 500 * time.Millisecond
	defaultMaxBackoff  = 15 * time.Second
)

// Client sends read-only ABCI queries to a Gno.land Tendermint/TM2 RPC node.
// It retries HTTP 429 and transient 5xx responses with exponential backoff.
type Client struct {
	RPCURL      string
	HTTPClient  *http.Client
	MaxRetries  int
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
	// Sleep waits for d or returns early if ctx is canceled. Nil uses time.NewTimer.
	Sleep func(ctx context.Context, d time.Duration) error

	calls atomic.Int64
}

// NewClient constructs a read-only RPC client with sensible defaults for onyx-1.
func NewClient(rpcURL string) *Client {
	if rpcURL == "" {
		rpcURL = DefaultOnyxRPC
	}
	return &Client{
		RPCURL:      strings.TrimRight(rpcURL, "/"),
		HTTPClient:  &http.Client{Timeout: defaultTimeout},
		MaxRetries:  defaultMaxRetries,
		BaseBackoff: defaultBaseBackoff,
		MaxBackoff:  defaultMaxBackoff,
	}
}

// Calls returns the total number of HTTP requests attempted by this client.
func (c *Client) Calls() int {
	return int(c.calls.Load())
}

// QueryEval evaluates expr inside pkgPath via vm/qeval (read-only).
func (c *Client) QueryEval(ctx context.Context, pkgPath, expr string) (string, error) {
	data, err := c.ABCIQuery(ctx, "vm/qeval", pkgPath+"."+expr)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ABCIQuery executes a read-only /abci_query request and returns the base64-decoded
// response Data bytes.
func (c *Client) ABCIQuery(ctx context.Context, path, data string) ([]byte, error) {
	baseURL := strings.TrimRight(c.RPCURL, "/")
	if baseURL == "" {
		baseURL = DefaultOnyxRPC
	}
	qURL := fmt.Sprintf("%s/abci_query?path=%s&data=0x%s",
		baseURL,
		url.QueryEscape(`"`+path+`"`),
		hex.EncodeToString([]byte(data)),
	)

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	maxRetries := c.MaxRetries
	if maxRetries <= 0 {
		maxRetries = defaultMaxRetries
	}
	baseBackoff := c.BaseBackoff
	if baseBackoff <= 0 {
		baseBackoff = defaultBaseBackoff
	}
	maxBackoff := c.MaxBackoff
	if maxBackoff <= 0 {
		maxBackoff = defaultMaxBackoff
	}
	sleepFn := c.Sleep
	if sleepFn == nil {
		sleepFn = sleepWithContext
	}

	var lastErr error
	for attempt := 0; attempt <= maxRetries; attempt++ {
		c.calls.Add(1)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, qURL, nil)
		if err != nil {
			return nil, fmt.Errorf("build abci_query request: %w", err)
		}
		req.Header.Set("Accept", "application/json")

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("abci_query http error: %w", err)
			if attempt == maxRetries || ctx.Err() != nil {
				return nil, lastErr
			}
			if err := sleepFn(ctx, backoffDelay(baseBackoff, maxBackoff, attempt, "")); err != nil {
				return nil, err
			}
			continue
		}

		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests ||
			resp.StatusCode == http.StatusBadGateway ||
			resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusGatewayTimeout {
			lastErr = fmt.Errorf("rpc HTTP %d (%s)", resp.StatusCode, strings.TrimSpace(string(body)))
			if attempt == maxRetries {
				return nil, lastErr
			}
			delay := backoffDelay(baseBackoff, maxBackoff, attempt, resp.Header.Get("Retry-After"))
			if err := sleepFn(ctx, delay); err != nil {
				return nil, err
			}
			continue
		}

		if readErr != nil {
			return nil, fmt.Errorf("read abci_query body: %w", readErr)
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("rpc HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}

		return decodeABCIResponse(body)
	}
	return nil, lastErr
}

type abciEnvelope struct {
	Error  *rpcError `json:"error"`
	Result *struct {
		Response *abciResponse `json:"response"`
	} `json:"result"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data"`
}

type abciResponse struct {
	ResponseBase *abciResponseBase `json:"ResponseBase"`
	// Fallback for flat TM2/Tendermint responses without ResponseBase nesting.
	Error json.RawMessage `json:"Error"`
	Data  string          `json:"Data"`
	Log   string          `json:"Log"`
}

type abciResponseBase struct {
	Error json.RawMessage `json:"Error"`
	Data  string          `json:"Data"`
	Log   string          `json:"Log"`
}

func decodeABCIResponse(body []byte) ([]byte, error) {
	var env abciEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("decode abci_query json: %w", err)
	}
	if env.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s (%s)", env.Error.Code, env.Error.Message, env.Error.Data)
	}
	if env.Result == nil || env.Result.Response == nil {
		return nil, errors.New("abci_query response missing result.response")
	}

	var errRaw json.RawMessage
	var dataB64, logMsg string
	if env.Result.Response.ResponseBase != nil {
		rb := env.Result.Response.ResponseBase
		errRaw = rb.Error
		dataB64 = rb.Data
		logMsg = rb.Log
	} else {
		errRaw = env.Result.Response.Error
		dataB64 = env.Result.Response.Data
		logMsg = env.Result.Response.Log
	}

	if len(errRaw) > 0 && string(errRaw) != "null" {
		msg := strings.TrimSpace(string(errRaw))
		if logMsg != "" {
			return nil, fmt.Errorf("abci error: %s (log: %s)", msg, firstLine(logMsg))
		}
		return nil, fmt.Errorf("abci error: %s", msg)
	}

	if dataB64 == "" {
		return nil, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("decode base64 abci data: %w", err)
	}
	return decoded, nil
}

func backoffDelay(base, maxDelay time.Duration, attempt int, retryAfter string) time.Duration {
	if retryAfter != "" {
		if secs, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && secs > 0 {
			d := time.Duration(secs) * time.Second
			if d > maxDelay {
				return maxDelay
			}
			return d
		}
	}
	d := base
	for i := 0; i < attempt; i++ {
		d *= 2
		if d >= maxDelay {
			return maxDelay
		}
	}
	return d
}

func sleepWithContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.IndexByte(s, '\n'); idx >= 0 {
		return s[:idx]
	}
	return s
}

// ParseEvalLines splits a vm/qeval multi-value response into its individual
// typed-value lines. Because Gno quotes strings with strconv.Quote, embedded
// newlines are escaped as \n and never split a single result value.
func ParseEvalLines(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, "\n")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ParseEvalString extracts a Go string from a vm/qeval value formatted as
// ("..." string).
func ParseEvalString(val string) (string, error) {
	s := strings.TrimSpace(val)
	if !strings.HasPrefix(s, "(") || !strings.HasSuffix(s, " string)") {
		return "", fmt.Errorf("unexpected vm/qeval string format: %q", truncateForErr(s))
	}
	quoted := strings.TrimSpace(s[1 : len(s)-len(" string)")])
	unquoted, err := strconv.Unquote(quoted)
	if err != nil {
		return "", fmt.Errorf("unquote vm/qeval string: %w", err)
	}
	return unquoted, nil
}

// ParseEvalBool extracts a bool from a vm/qeval value formatted as
// (true bool) or (false bool).
func ParseEvalBool(val string) (bool, error) {
	switch strings.TrimSpace(val) {
	case "(true bool)":
		return true, nil
	case "(false bool)":
		return false, nil
	default:
		return false, fmt.Errorf("unexpected vm/qeval bool format: %q", truncateForErr(val))
	}
}

func truncateForErr(s string) string {
	if len(s) > 120 {
		return s[:120] + "..."
	}
	return s
}

// ChainID asks the node for its chain id (one GET to /status, no retries).
func (c *Client) ChainID(ctx context.Context) (string, error) {
	baseURL := strings.TrimRight(c.RPCURL, "/")
	if baseURL == "" {
		baseURL = DefaultOnyxRPC
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/status", nil)
	if err != nil {
		return "", err
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultTimeout}
	}
	c.calls.Add(1)
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status query: http %d", resp.StatusCode)
	}
	var out struct {
		Result struct {
			NodeInfo struct {
				Network string `json:"network"`
			} `json:"node_info"`
		} `json:"result"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return "", fmt.Errorf("decode status: %w", err)
	}
	if out.Result.NodeInfo.Network == "" {
		return "", fmt.Errorf("status reply has no chain id")
	}
	return out.Result.NodeInfo.Network, nil
}

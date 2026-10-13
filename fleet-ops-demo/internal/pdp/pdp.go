// Package pdp makes the app's checks through the Permit Go SDK (permitClient.Check and
// permitClient.BulkCheck), the way an application makes them.
//
// The SDK returns booleans. To show why each decision came out the way it did, the app also sends the
// same checks to the PDP's /allowed or /allowed/bulk endpoint, whose debug output carries the reasons,
// and reads the PDP's loaded data and policy through its embedded OPA.
package pdp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/permitio/permit-golang/pkg/enforcement"
	"github.com/permitio/permit-golang/pkg/permit"

	"fleetops/internal/permitapi"
	"fleetops/internal/settings"
	"fleetops/policy"
)

// NotCaughtUpError is returned by the waits when the PDP's data did not show a change in time. Any
// other error from them means the PDP or its OPA couldn't be read, so nothing is known either way.
type NotCaughtUpError struct {
	Detail string // what the data still shows, or lacks: "its data still has asset:x after 15s"
}

func (e *NotCaughtUpError) Error() string { return "the PDP has not caught up: " + e.Detail }

type Resource struct {
	Type   string `json:"type"`
	Key    string `json:"key"`
	Tenant string `json:"tenant"`
}

// ID is "type:key".
func (r Resource) ID() string { return r.Type + ":" + r.Key }

type Check struct {
	User     string   `json:"user"`
	Action   string   `json:"action"`
	Resource Resource `json:"resource"`
}

// NewCheck builds a check. The acting organization travels as the resource's tenant. Attributes come
// from Permit's stored data, never from the request.
func NewCheck(user, action, resource, actingOrg string) Check {
	typ, key, _ := strings.Cut(resource, ":")
	return Check{User: user, Action: action, Resource: Resource{Type: typ, Key: key, Tenant: actingOrg}}
}

// Request is the check as the SDK takes it.
func (c Check) Request() enforcement.CheckRequest {
	return enforcement.CheckRequest{
		User:     enforcement.UserBuilder(c.User).Build(),
		Action:   enforcement.Action(c.Action),
		Resource: enforcement.ResourceBuilder(c.Resource.Type).WithKey(c.Resource.Key).WithTenant(c.Resource.Tenant).Build(),
	}
}

// Code is the SDK call for this check, as the log shows it: gofmt layout, one argument per line, so
// it reads well in the narrow log panel.
func Code(c Check) string {
	return fmt.Sprintf("permitClient.Check(\n  enforcement.UserBuilder(%q).Build(),\n  %q,\n  enforcement.ResourceBuilder(%q).\n    WithKey(%q).WithTenant(%q).Build())",
		c.User, c.Action, c.Resource.Type, c.Resource.Key, c.Resource.Tenant)
}

// BulkCode is the SDK call for a bulk of checks, as the log shows it.
func BulkCode(n int) string {
	return fmt.Sprintf("permitClient.BulkCheck(requests...) // %d checks", n)
}

// Client checks through the SDK and fetches the PDP's reasons and loaded data over HTTP.
type Client struct {
	Permit   *permit.Client
	settings settings.Settings
	http     *http.Client
}

func New(s settings.Settings, p *permit.Client) *Client {
	return &Client{Permit: p, settings: s, http: &http.Client{Timeout: 10 * time.Second}}
}

func (p *Client) Check(c Check) (bool, error) {
	r := c.Request()
	return p.Permit.Check(r.User, r.Action, r.Resource)
}

func (p *Client) BulkCheck(checks []Check) ([]bool, error) {
	if len(checks) == 0 {
		return []bool{}, nil
	}
	requests := make([]enforcement.CheckRequest, len(checks))
	for n, c := range checks {
		requests[n] = c.Request()
	}
	return p.Permit.BulkCheck(requests...)
}

// Debug is the PDP's explanation of a check: the debug block of its /allowed response. It is nil,
// with no error, when the PDP answers without one (PDP_DEBUG off).
func (p *Client) Debug(c Check) (map[string]any, error) {
	var res struct {
		Debug map[string]any `json:"debug"`
	}
	if err := p.post("/allowed", c.Request(), &res); err != nil {
		return nil, err
	}
	return res.Debug, nil
}

// DebugMany is the same for a bulk of checks: the debug block of each item in /allowed/bulk.
func (p *Client) DebugMany(checks []Check) ([]map[string]any, error) {
	requests := make([]enforcement.CheckRequest, len(checks))
	for n, c := range checks {
		requests[n] = c.Request()
	}
	var res struct {
		Allow []struct {
			Debug map[string]any `json:"debug"`
		} `json:"allow"`
	}
	if err := p.post("/allowed/bulk", requests, &res); err != nil {
		return nil, err
	}
	if len(res.Allow) != len(checks) {
		return nil, fmt.Errorf("POST /allowed/bulk: %d answers for %d checks", len(res.Allow), len(checks))
	}
	out := make([]map[string]any, len(checks))
	for n, item := range res.Allow {
		out[n] = item.Debug
	}
	return out, nil
}

func (p *Client) post(path string, body, into any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encoding the body of POST %s: %w", path, err)
	}
	req, err := http.NewRequest(http.MethodPost, p.settings.PDPURL+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return p.do(req, into)
}

func (p *Client) get(url string, into any) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	return p.do(req, into)
}

// do sends the request with the API key. A non-200 answer is a *permitapi.HTTPError.
func (p *Client) do(req *http.Request, into any) error {
	req.Header.Set("Authorization", "Bearer "+p.settings.APIKey)
	res, err := p.http.Do(req)
	if err != nil {
		return err // *url.Error: names the method and URL, never the header
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return &permitapi.HTTPError{Method: req.Method, Path: req.URL.Path, StatusCode: res.StatusCode, Status: res.Status}
	}
	if into == nil {
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		return fmt.Errorf("decoding the answer to %s %s: %w", req.Method, req.URL.Path, err)
	}
	return nil
}

// OPAData is a value from the PDP's loaded data, e.g. "resource_instances/asset:acme-dal-01". It is
// nil, with no error, when the data has nothing there (OPA answers 200 without a result); an error
// means the data couldn't be read, so nothing is known about it.
func (p *Client) OPAData(path string) (any, error) {
	var res struct {
		Result any `json:"result"`
	}
	if err := p.get(p.settings.OPAURL+"/v1/data/"+path, &res); err != nil {
		return nil, fmt.Errorf("reading the PDP's data: %w", err)
	}
	return res.Result, nil
}

// RebuildRelationshipCache rebuilds the PDP's relationship cache from its loaded data, by evaluating
// the policy's own cache-rebuild rule. On pdp-v2 0.9.16 a schema change leaves that cache, which
// /user-permissions and AuthZEN search use, missing relationships until it is rebuilt.
func (p *Client) RebuildRelationshipCache() error {
	req, err := http.NewRequest(http.MethodPost, p.settings.OPAURL+"/v1/data/permit/rebac/cache_rebuild", strings.NewReader(`{"input":{}}`))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	var res struct {
		Result bool `json:"result"`
	}
	if err := p.do(req, &res); err != nil {
		return err
	}
	if !res.Result {
		return fmt.Errorf("cache_rebuild returned false")
	}
	return nil
}

// RefetchData makes the PDP fetch all its data from Permit again, replacing what it has.
func (p *Client) RefetchData() error {
	req, err := http.NewRequest(http.MethodPost, p.settings.PDPURL+"/data-updater/trigger", nil)
	if err != nil {
		return err
	}
	return p.do(req, nil)
}

// HasParent reports whether the PDP's loaded data links object ("type:key") to parent ("type:key").
func (p *Client) HasParent(object, parent string) (bool, error) {
	typ, key, _ := strings.Cut(parent, ":")
	data, err := p.OPAData("relationships/" + object)
	if err != nil {
		return false, err
	}
	rel, _ := data.(map[string]any)
	parents, _ := rel["relation:parent"].(map[string]any)
	keys, _ := parents[typ].([]any)
	for _, k := range keys {
		if k == key {
			return true, nil
		}
	}
	return false, nil
}

// Settle waits until the PDP has the given parent links (object -> parent). Deleting an instance and
// creating it again with the same key makes Permit remove the old links asynchronously; when that
// reaches the PDP after the new link, the PDP loses the link. If the links don't show up within a
// few seconds, a full data refetch from Permit repairs it. Returns nil once all links are there, a
// *NotCaughtUpError that names the missing ones, or the error that stopped it reading.
func (p *Client) Settle(links map[string]string) error {
	var missing []string
	for _, wait := range []time.Duration{4 * time.Second, 20 * time.Second} {
		for deadline := time.Now().Add(wait); ; time.Sleep(200 * time.Millisecond) {
			var err error
			if missing, err = p.Missing(links); err != nil || len(missing) == 0 {
				return err
			}
			if time.Now().After(deadline) {
				break
			}
		}
		if err := p.RefetchData(); err != nil {
			return fmt.Errorf("refetching the PDP's data: %w", err)
		}
	}
	missing, err := p.Missing(links)
	if err != nil || len(missing) == 0 {
		return err
	}
	return &NotCaughtUpError{Detail: fmt.Sprintf("its data has no parent link for %s after a refetch", strings.Join(missing, ", "))}
}

// Keep holds parent links (object -> parent) in the PDP's data. Once they are all there it watches
// them for `stable`; whenever some go missing (a deletion of the old links that reached the PDP late),
// it has the PDP refetch its data from Permit and watches again, for at most `limit`. Returns how many
// refetches it took, and nil when the links stayed, a *NotCaughtUpError when they did not, or the
// error that stopped it reading.
func (p *Client) Keep(links map[string]string, stable, limit time.Duration) (int, error) {
	var complete, refetched time.Time
	var missing []string
	var refetchErr error
	refetches := 0
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		var err error
		if missing, err = p.Missing(links); err != nil {
			return refetches, err
		}
		if len(missing) == 0 {
			if complete.IsZero() {
				complete = time.Now()
			}
			if time.Since(complete) >= stable {
				return refetches, nil
			}
			continue
		}
		complete = time.Time{}
		if time.Since(refetched) > 10*time.Second {
			if refetchErr = p.RefetchData(); refetchErr == nil {
				refetches++
			}
			refetched = time.Now()
		}
	}
	detail := fmt.Sprintf("its parent links did not stay for %s within %s", stable, limit)
	if len(missing) > 0 {
		detail = fmt.Sprintf("its data has no parent link for %s at the end of %s", strings.Join(missing, ", "), limit)
	}
	if refetchErr != nil {
		detail += fmt.Sprintf(" (the last data refetch failed: %v)", refetchErr)
	}
	return refetches, &NotCaughtUpError{Detail: detail}
}

// WaitUnlinked waits until the PDP's data has no relationships for the instances. Returns nil when
// they are gone within the timeout, a *NotCaughtUpError when they are not, or the error that stopped
// it reading.
func (p *Client) WaitUnlinked(ids []string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		linked := ""
		for _, id := range ids {
			data, err := p.OPAData("relationships/" + id)
			if err != nil {
				return err
			}
			if rel, _ := data.(map[string]any); len(rel) > 0 {
				linked = id
				break
			}
		}
		if linked == "" {
			return nil
		}
		if time.Now().After(deadline) {
			return &NotCaughtUpError{Detail: fmt.Sprintf("its data still links %s after %s", linked, timeout)}
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// Missing lists the parent links (object -> parent) the PDP's data doesn't have.
func (p *Client) Missing(links map[string]string) ([]string, error) {
	var out []string
	for object, parent := range links {
		tenant, err := p.instanceTenant(object)
		if err != nil {
			return nil, err
		}
		linked := false
		if tenant != "" {
			if linked, err = p.HasParent(object, parent); err != nil {
				return nil, err
			}
		}
		if !linked {
			out = append(out, object)
		}
	}
	slices.Sort(out)
	return out, nil
}

// Restart restarts the PDP container (docker compose, in the demo folder) and waits until it is
// healthy. A restarted PDP loads all its data and policy from Permit afresh.
func (p *Client) Restart() error {
	cmd := exec.Command("docker", "compose", "--env-file", ".env", "restart", "pdp")
	cmd.Dir = p.settings.DemoDir
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker compose restart pdp: %v\n%s", err, out)
	}
	for range 40 {
		time.Sleep(time.Second)
		if p.get(p.settings.PDPURL+"/healthy", nil) == nil {
			return nil
		}
	}
	return fmt.Errorf("the PDP isn't healthy 40 s after a restart")
}

// instanceTenant is the organization the PDP's data gives an instance; "" when the PDP doesn't have it.
// After a deletion the PDP keeps a stub without a tenant ({"attributes": {}}).
func (p *Client) instanceTenant(id string) (string, error) {
	data, err := p.OPAData("resource_instances/" + id)
	if err != nil {
		return "", err
	}
	inst, _ := data.(map[string]any)
	tenant, _ := inst["tenant"].(string)
	return tenant, nil
}

// WaitGone waits until the PDP's data no longer has the instances or their relationships, so a
// deletion can't reach the PDP after an instance created again with the same key. Returns nil when
// they are gone within the timeout, a *NotCaughtUpError when they are not, or the error that stopped
// it reading.
func (p *Client) WaitGone(ids []string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		present := ""
		for _, id := range ids {
			tenant, err := p.instanceTenant(id)
			if err != nil {
				return err
			}
			data, err := p.OPAData("relationships/" + id)
			if err != nil {
				return err
			}
			if rel, _ := data.(map[string]any); tenant != "" || len(rel) > 0 {
				present = id
				break
			}
		}
		if present == "" {
			return nil
		}
		if time.Now().After(deadline) {
			return &NotCaughtUpError{Detail: fmt.Sprintf("its data still has %s after %s", present, timeout)}
		}
		time.Sleep(200 * time.Millisecond)
	}
}

type Status struct {
	PDP bool `json:"pdp"`
	// ActingOrgRule: the custom rules (tenant isolation and the fleet rules) are loaded and every
	// allow in root.rego requires them.
	ActingOrgRule bool `json:"actingOrgRule"`
	// RulesUnknown says why the loaded policy couldn't be read (OPA unreachable, say), so
	// ActingOrgRule is false for lack of an answer, not because the rules are missing. "" when read.
	RulesUnknown string `json:"rulesUnknown,omitempty"`
}

// loadedModule is the source of a policy module the PDP's OPA has loaded, "" when it has none by
// that name (OPA answers 404).
func (p *Client) loadedModule(id string) (string, error) {
	var res struct {
		Result struct {
			Raw string `json:"raw"`
		} `json:"result"`
	}
	if err := p.get(p.settings.OPAURL+"/v1/policies/"+id, &res); err != nil {
		if permitapi.Status(err) == http.StatusNotFound {
			return "", nil
		}
		return "", fmt.Errorf("reading the PDP's policy %s: %w", id, err)
	}
	return res.Result.Raw, nil
}

// CustomPolicyVersion is the version stamped in the custom rules the PDP has loaded, "" when none.
func (p *Client) CustomPolicyVersion() (string, error) {
	raw, err := p.loadedModule("custom/root.rego")
	if err != nil {
		return "", err
	}
	return policy.Version(raw), nil
}

// Status: is the PDP up, and are the custom rules from the GitOps repo loaded and wired into root?
func (p *Client) Status() Status {
	var s Status
	s.PDP = p.get(p.settings.PDPURL+"/healthy", nil) == nil
	// Every PDP has Permit's root.rego loaded: without it, this is not the PDP's OPA.
	root, err := p.loadedModule("root.rego")
	if err == nil && root == "" {
		err = fmt.Errorf("the OPA at %s has no root.rego loaded; is OPA_URL the PDP's OPA?", p.settings.OPAURL)
	}
	if err != nil {
		s.RulesUnknown = err.Error()
		return s
	}
	custom, err := p.loadedModule("custom/root.rego")
	if err != nil {
		s.RulesUnknown = err.Error()
		return s
	}
	s.ActingOrgRule = strings.Contains(custom, "acting_org_ok") && strings.Contains(custom, "fleet_rules_ok") && policy.RequiredByRoot(root)
	return s
}

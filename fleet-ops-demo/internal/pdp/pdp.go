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
	"regexp"
	"strings"
	"time"

	"github.com/permitio/permit-golang/pkg/enforcement"
	"github.com/permitio/permit-golang/pkg/permit"

	"fleetops/internal/settings"
)

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

// Debug is the PDP's explanation of a check: the debug block of its /allowed response.
func (p *Client) Debug(c Check) map[string]any {
	var res struct {
		Debug map[string]any `json:"debug"`
	}
	if err := p.post("/allowed", c.Request(), &res); err != nil {
		return nil
	}
	return res.Debug
}

// DebugMany is the same for a bulk of checks: the debug block of each item in /allowed/bulk.
func (p *Client) DebugMany(checks []Check) []map[string]any {
	out := make([]map[string]any, len(checks))
	requests := make([]enforcement.CheckRequest, len(checks))
	for n, c := range checks {
		requests[n] = c.Request()
	}
	var res struct {
		Allow []struct {
			Debug map[string]any `json:"debug"`
		} `json:"allow"`
	}
	if err := p.post("/allowed/bulk", requests, &res); err != nil || len(res.Allow) != len(checks) {
		return out
	}
	for n, item := range res.Allow {
		out[n] = item.Debug
	}
	return out
}

func (p *Client) post(path string, body, into any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
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

func (p *Client) do(req *http.Request, into any) error {
	req.Header.Set("Authorization", "Bearer "+p.settings.APIKey)
	res, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s %s: %s", req.Method, req.URL.Path, res.Status)
	}
	if into == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(into)
}

// OPAData is a value from the PDP's loaded data, e.g. "resource_instances/asset:acme-dal-01" (nil if
// absent).
func (p *Client) OPAData(path string) any {
	var res struct {
		Result any `json:"result"`
	}
	if err := p.get(p.settings.OPAURL+"/v1/data/"+path, &res); err != nil {
		return nil
	}
	return res.Result
}

// RebuildRelationshipCache rebuilds the PDP's relationship cache from its loaded data, by evaluating
// the policy's own cache-rebuild rule. On pdp-v2 0.9.16 a schema change leaves that cache, which
// /user-permissions and AuthZEN search use, missing relationships until it is rebuilt.
func (p *Client) RebuildRelationshipCache() error {
	data, _ := json.Marshal(map[string]any{"input": map[string]any{}})
	req, err := http.NewRequest(http.MethodPost, p.settings.OPAURL+"/v1/data/permit/rebac/cache_rebuild", bytes.NewReader(data))
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
func (p *Client) HasParent(object, parent string) bool {
	typ, key, _ := strings.Cut(parent, ":")
	rel, _ := p.OPAData("relationships/" + object).(map[string]any)
	parents, _ := rel["relation:parent"].(map[string]any)
	keys, _ := parents[typ].([]any)
	for _, k := range keys {
		if k == key {
			return true
		}
	}
	return false
}

// Settle waits until the PDP has the given parent links (object -> parent). Deleting an instance and
// creating it again with the same key makes Permit remove the old links asynchronously; when that
// reaches the PDP after the new link, the PDP loses the link. If the links don't show up within a
// few seconds, a full data refetch from Permit repairs it. Reports whether all links are there.
func (p *Client) Settle(links map[string]string) bool {
	have := func() bool {
		for object, parent := range links {
			if p.instanceTenant(object) == "" || !p.HasParent(object, parent) {
				return false
			}
		}
		return true
	}
	for _, wait := range []time.Duration{4 * time.Second, 20 * time.Second} {
		deadline := time.Now().Add(wait)
		for time.Now().Before(deadline) {
			if have() {
				return true
			}
			time.Sleep(200 * time.Millisecond)
		}
		if err := p.RefetchData(); err != nil {
			return false
		}
	}
	return have()
}

// Keep holds parent links (object -> parent) in the PDP's data. Once they are all there it watches
// them for `stable`; whenever some go missing (a deletion of the old links that reached the PDP late),
// it has the PDP refetch its data from Permit and watches again, for at most `limit`. Reports whether
// the links stayed, and how many refetches it took.
func (p *Client) Keep(links map[string]string, stable, limit time.Duration) (bool, int) {
	var complete, refetched time.Time
	refetches := 0
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if len(p.Missing(links)) == 0 {
			if complete.IsZero() {
				complete = time.Now()
			}
			if time.Since(complete) >= stable {
				return true, refetches
			}
			continue
		}
		complete = time.Time{}
		if time.Since(refetched) > 10*time.Second {
			if p.RefetchData() == nil {
				refetches++
			}
			refetched = time.Now()
		}
	}
	return false, refetches
}

// WaitUnlinked waits until the PDP's data has no parent links for the instances. Reports whether they
// are gone within the timeout.
func (p *Client) WaitUnlinked(ids []string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		linked := false
		for _, id := range ids {
			if rel, _ := p.OPAData("relationships/" + id).(map[string]any); len(rel) > 0 {
				linked = true
				break
			}
		}
		if !linked {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// Missing lists the parent links (object -> parent) the PDP's data doesn't have.
func (p *Client) Missing(links map[string]string) []string {
	var out []string
	for object, parent := range links {
		if p.instanceTenant(object) == "" || !p.HasParent(object, parent) {
			out = append(out, object)
		}
	}
	return out
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
func (p *Client) instanceTenant(id string) string {
	inst, _ := p.OPAData("resource_instances/" + id).(map[string]any)
	tenant, _ := inst["tenant"].(string)
	return tenant
}

// WaitGone waits until the PDP's data no longer has the instances or their relationships, so a
// deletion can't reach the PDP after an instance created again with the same key. Reports whether
// they are gone within the timeout.
func (p *Client) WaitGone(ids []string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		gone := true
		for _, id := range ids {
			rel, _ := p.OPAData("relationships/" + id).(map[string]any)
			if p.instanceTenant(id) != "" || len(rel) > 0 {
				gone = false
				break
			}
		}
		if gone {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

type Status struct {
	PDP bool `json:"pdp"`
	// ActingOrgRule: the custom rules (tenant isolation and the fleet rules) are loaded and every
	// allow in root.rego requires them.
	ActingOrgRule bool `json:"actingOrgRule"`
}

var (
	rootRequiresRule = regexp.MustCompile(`allow\s*\{[^}]*custom\.acting_org_ok[^}]*custom\.fleet_rules_ok`)
	regoComment      = regexp.MustCompile(`(?m)#.*$`)
)

// rootRequiresRules reports whether every allow rule in root.rego requires the custom rules. Comments
// are ignored, so rules that are commented out count as off.
func rootRequiresRules(root string) bool {
	root = regoComment.ReplaceAllString(root, "")
	rules := strings.Count(root, "\nallow {")
	return rules > 0 && len(rootRequiresRule.FindAllString(root, -1)) == rules
}

var policyVersion = regexp.MustCompile(`(?m)^policy_version := "([^"]*)"`)

// CustomPolicyVersion is the version stamped in the custom rules the PDP has loaded, "" when none.
func (p *Client) CustomPolicyVersion() string {
	var res struct {
		Result struct {
			Raw string `json:"raw"`
		} `json:"result"`
	}
	if err := p.get(p.settings.OPAURL+"/v1/policies/custom/root.rego", &res); err != nil {
		return ""
	}
	if m := policyVersion.FindStringSubmatch(res.Result.Raw); m != nil {
		return m[1]
	}
	return ""
}

// Status: is the PDP up, and are the custom rules from the GitOps repo loaded and wired into root?
func (p *Client) Status() Status {
	var s Status
	s.PDP = p.get(p.settings.PDPURL+"/healthy", nil) == nil
	policy := func(module string) string {
		var res struct {
			Result struct {
				Raw string `json:"raw"`
			} `json:"result"`
		}
		if err := p.get(p.settings.OPAURL+"/v1/policies/"+module, &res); err != nil {
			return ""
		}
		return res.Result.Raw
	}
	custom, root := policy("custom/root.rego"), policy("root.rego")
	s.ActingOrgRule = strings.Contains(custom, "acting_org_ok") && strings.Contains(custom, "fleet_rules_ok") && rootRequiresRules(root)
	return s
}

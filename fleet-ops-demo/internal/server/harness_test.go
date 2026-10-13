package server

import (
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
	"fleetops/internal/settings"
)

// fake is one server playing the PDP (/allowed, /allowed/bulk, /healthy), its OPA (/v1/...) and the
// Permit API (/v2/...), so the app's handlers run end to end without Permit.
type fake struct {
	mu sync.Mutex
	// decide answers a check; nil allows everything.
	decide func(user, action, resource, tenant string) bool
	// opa answers an OPA read (path and status, body); nil answers 200 with no result.
	opa func(path string) (int, string)
	// users is Permit's copy of people's attributes, served on GET .../users/{key}.
	users map[string]map[string]any
	// writes lists the API calls that change something: "METHOD path body".
	writes []string
}

type checkBody struct {
	User     struct{ Key string }
	Action   string
	Resource struct{ Type, Key, Tenant string }
}

func (f *fake) allow(c checkBody) bool {
	f.mu.Lock()
	decide := f.decide
	f.mu.Unlock()
	return decide == nil || decide(c.User.Key, c.Action, c.Resource.Type+":"+c.Resource.Key, c.Resource.Tenant)
}

func answer(allow bool) string {
	b, _ := json.Marshal(map[string]any{"allow": allow, "debug": map[string]any{"rbac": map[string]any{"allow": allow}}})
	return string(b)
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/allowed":
		var c checkBody
		_ = json.Unmarshal(body, &c)
		_, _ = io.WriteString(w, answer(f.allow(c)))
	case r.URL.Path == "/allowed/bulk":
		var checks []checkBody
		_ = json.Unmarshal(body, &checks)
		items := make([]string, len(checks))
		for n, c := range checks {
			items[n] = answer(f.allow(c))
		}
		_, _ = io.WriteString(w, `{"allow":[`+strings.Join(items, ",")+`]}`)
	case r.URL.Path == "/healthy":
		_, _ = io.WriteString(w, `{}`)
	case strings.HasPrefix(r.URL.Path, "/v1/"):
		status, out := 200, `{}`
		if f.opa != nil {
			status, out = f.opa(r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, out)
	case r.URL.Path == "/v2/api-key/scope":
		_, _ = io.WriteString(w, `{"organization_id":"o","project_id":"p","environment_id":"e"}`)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v2/facts/p/e/users/"):
		key := strings.TrimPrefix(r.URL.Path, "/v2/facts/p/e/users/")
		f.mu.Lock()
		attrs, ok := f.users[key]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{}`)
			return
		}
		out, _ := json.Marshal(map[string]any{"key": key, "id": "id-" + key, "attributes": attrs})
		_, _ = w.Write(out)
	default:
		if r.Method != http.MethodGet {
			f.mu.Lock()
			f.writes = append(f.writes, r.Method+" "+r.URL.Path+" "+string(body))
			f.mu.Unlock()
		}
		// Enough for every SDK read model to decode; RoleAssignmentRead checks its required fields.
		_, _ = io.WriteString(w, `{"id":"1","key":"k","user":"u","role":"r","tenant":"t","user_id":"1","role_id":"1","tenant_id":"1",`+
			`"organization_id":"o","project_id":"p","environment_id":"e","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}`)
	}
}

func (f *fake) written() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.writes...)
}

// newTestApp is the app with the seed loaded, as `make reset` leaves Permit, talking to f.
func newTestApp(t *testing.T, f *fake) (*App, http.Handler) {
	t.Helper()
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	s := settings.Settings{APIKey: "permit_key_test", APIURL: srv.URL, PDPURL: srv.URL, OPAURL: srv.URL}
	a := New(pdp.New(s, settings.Client(s)))
	for _, tenant := range model.Tenants {
		a.tenants[tenant.Key] = true
	}
	for _, seeded := range model.Instances {
		i := seeded
		i.Attributes = maps.Clone(seeded.Attributes)
		if i.Attributes == nil {
			i.Attributes = map[string]any{}
		}
		a.instances[i.ID()] = &i
	}
	a.assignments = append(a.assignments, model.RoleAssignments...)
	for _, u := range model.Users {
		certs := make([]any, len(u.Certifications))
		for n, c := range u.Certifications {
			certs[n] = c
		}
		a.userAttrs[u.Key] = map[string]any{"home_tenant": u.HomeTenant, "certifications": certs}
	}
	for team, keys := range model.TeamMembers {
		a.members[team] = append([]string(nil), keys...)
	}
	return a, a.Handler(fstest.MapFS{}, "p", "e")
}

// shortWaits makes the post-write waits short for the test.
func shortWaits(t *testing.T) {
	t.Helper()
	decision, data := decisionWait, dataWait
	decisionWait, dataWait = 300*time.Millisecond, 300*time.Millisecond
	t.Cleanup(func() { decisionWait, dataWait = decision, data })
}

// post sends an action the way the page does and decodes the answer.
func post(t *testing.T, h http.Handler, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "http://localhost:3000"+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("POST %s: %d %q is not JSON", path, rec.Code, rec.Body.String())
	}
	return rec.Code, out
}

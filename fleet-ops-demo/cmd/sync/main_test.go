package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"fleetops/internal/permitapi"
)

// fakeAPI answers like Permit's API for an environment key of project "fleet" (id p-1),
// environment "demo" (id e-1).
func fakeAPI(t *testing.T, scope string, handle func(w http.ResponseWriter, r *http.Request) bool) rest {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer permit_key_test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if handle != nil && handle(w, r) {
			return
		}
		switch r.URL.Path {
		case "/v2/api-key/scope":
			_, _ = w.Write([]byte(scope))
		case "/v2/projects/p-1":
			_, _ = w.Write([]byte(`{"id":"p-1","key":"fleet","name":"Fleet"}`))
		case "/v2/projects/p-1/envs/e-1":
			_, _ = w.Write([]byte(`{"id":"e-1","key":"demo","name":"Demo"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return rest{url: srv.URL, key: "permit_key_test"}
}

const envScope = `{"organization_id":"o-1","project_id":"p-1","environment_id":"e-1"}`

func TestScopeOf(t *testing.T) {
	scope, err := scopeOf(fakeAPI(t, envScope, nil))
	if err != nil {
		t.Fatal(err)
	}
	want := keyScope{ProjectID: "p-1", ProjectKey: "fleet", EnvID: "e-1", EnvKey: "demo", EnvName: "Demo"}
	if scope != want {
		t.Fatalf("got %+v, want %+v", scope, want)
	}
	if _, err := scopeOf(fakeAPI(t, `{"organization_id":"o-1","project_id":"p-1"}`, nil)); err == nil {
		t.Fatal("a project key passed as an environment's key")
	}
}

// setup and reset delete what the seed doesn't have: they stop when .env names another project or
// environment than the key's.
func TestScopeCheck(t *testing.T) {
	scope := keyScope{ProjectID: "p-1", ProjectKey: "fleet", EnvID: "e-1", EnvKey: "demo", EnvName: "Demo"}
	for name, tc := range map[string]struct {
		project, env string
		ok           bool
	}{
		"keys match":            {"fleet", "demo", true},
		"IDs match":             {"p-1", "e-1", true},
		"not set":               {"", "", true},
		"another environment":   {"fleet", "production", false},
		"another project":       {"customer", "demo", false},
		"only the env, another": {"", "production", false},
	} {
		t.Run(name, func(t *testing.T) {
			if err := scope.check(tc.project, tc.env); (err == nil) != tc.ok {
				t.Fatalf("got %v, want ok=%v", err, tc.ok)
			}
		})
	}
}

// listRaw reads the key's own environment, every page, and its errors carry the status, so
// call's retries and allowed statuses apply to them.
func TestListRaw(t *testing.T) {
	scope := keyScope{ProjectID: "p-1", EnvID: "e-1"}
	t.Run("every page, in the key's environment", func(t *testing.T) {
		api := fakeAPI(t, envScope, func(w http.ResponseWriter, r *http.Request) bool {
			if r.URL.Path != "/v2/facts/p-1/e-1/set_rules" {
				return false
			}
			n := 100
			if r.URL.Query().Get("page") == "2" {
				n = 3
			}
			rules := make([]rule, n)
			for i := range rules {
				rules[i] = rule{UserSet: fmt.Sprintf("u%d", i)}
			}
			_ = json.NewEncoder(w).Encode(rules)
			return true
		})
		got, err := listRaw[rule](api, scope, "facts", "set_rules")
		if err != nil || len(got) != 103 {
			t.Fatalf("got %d rules, %v; want 103", len(got), err)
		}
	})
	t.Run("a failure carries its status", func(t *testing.T) {
		api := fakeAPI(t, envScope, nil)
		_, err := listRaw[rule](api, scope, "facts", "set_rules")
		if permitapi.Status(err) != http.StatusNotFound || !strings.Contains(err.Error(), "listing set_rules") {
			t.Fatalf("got %v, want a 404 that says what was listed", err)
		}
	})
}

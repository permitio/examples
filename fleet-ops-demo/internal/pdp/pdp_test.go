package pdp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"fleetops/internal/permitapi"
	"fleetops/internal/settings"
	"fleetops/policy"
)

// fakeOPA answers OPA and PDP paths from a table: path -> status and body. Unknown paths get 404.
func fakeOPA(t *testing.T, answer func(path string) (int, string)) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status, body := answer(r.URL.Path)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return New(settings.Settings{APIKey: "permit_key_test", PDPURL: srv.URL, OPAURL: srv.URL}, nil)
}

// unreachable is a client whose PDP and OPA refuse connections.
func unreachable(t *testing.T) *Client {
	t.Helper()
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	return New(settings.Settings{APIKey: "permit_key_test", PDPURL: url, OPAURL: url}, nil)
}

func TestOPAData(t *testing.T) {
	p := fakeOPA(t, func(path string) (int, string) {
		switch path {
		case "/v1/data/resource_instances/asset:a":
			return 200, `{"result":{"tenant":"acme"}}`
		case "/v1/data/resource_instances/asset:none":
			return 200, `{}`
		}
		return 500, `{"code":"internal_error"}`
	})
	t.Run("present", func(t *testing.T) {
		got, err := p.OPAData("resource_instances/asset:a")
		if err != nil || got == nil {
			t.Fatalf("got %v, %v", got, err)
		}
	})
	t.Run("absent is nil without an error", func(t *testing.T) {
		got, err := p.OPAData("resource_instances/asset:none")
		if err != nil || got != nil {
			t.Fatalf("got %v, %v", got, err)
		}
	})
	t.Run("a failed read is an error, with the status", func(t *testing.T) {
		_, err := p.OPAData("resource_instances/asset:broken")
		if permitapi.Status(err) != 500 {
			t.Fatalf("got %v, want a 500 HTTPError", err)
		}
	})
	t.Run("unreachable is an error", func(t *testing.T) {
		if _, err := unreachable(t).OPAData("resource_instances/asset:a"); err == nil {
			t.Fatal("no error from an unreachable OPA")
		}
	})
}

// A wait must never read "couldn't read" as "gone": that let a transfer re-create a truck while
// the PDP still had it, and `make setup` report the race guarded when it wasn't.
func TestWaitsFailOnReadErrors(t *testing.T) {
	for name, p := range map[string]*Client{
		"unreachable": unreachable(t),
		"401":         fakeOPA(t, func(string) (int, string) { return 401, `{}` }),
	} {
		t.Run(name, func(t *testing.T) {
			started := time.Now()
			for wait, err := range map[string]error{
				"WaitGone":     p.WaitGone([]string{"asset:a"}, 5*time.Second),
				"WaitUnlinked": p.WaitUnlinked([]string{"asset:a"}, 5*time.Second),
				"Settle":       p.Settle(map[string]string{"asset:a": "site:s"}),
			} {
				if _, behind := errors.AsType[*NotCaughtUpError](err); err == nil || behind {
					t.Errorf("%s: got %v, want a read error", wait, err)
				}
			}
			if _, err := p.Keep(map[string]string{"asset:a": "site:s"}, time.Second, 5*time.Second); err == nil {
				t.Error("Keep: no error")
			}
			if took := time.Since(started); took > 3*time.Second {
				t.Errorf("read errors took %s to surface: the waits kept polling", took)
			}
		})
	}
}

func TestWaitGone(t *testing.T) {
	t.Run("gone once the PDP has only a stub", func(t *testing.T) {
		var reads atomic.Int32
		p := fakeOPA(t, func(path string) (int, string) {
			if path == "/v1/data/resource_instances/asset:a" && reads.Add(1) < 3 {
				return 200, `{"result":{"tenant":"acme","attributes":{}}}`
			}
			if path == "/v1/data/resource_instances/asset:a" {
				return 200, `{"result":{"attributes":{}}}`
			}
			return 200, `{}`
		})
		if err := p.WaitGone([]string{"asset:a"}, 5*time.Second); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("still there after the timeout", func(t *testing.T) {
		p := fakeOPA(t, func(path string) (int, string) {
			return 200, `{"result":{"relation:parent":{"site":["s"]}}}`
		})
		err := p.WaitGone([]string{"asset:a"}, 300*time.Millisecond)
		if behind, ok := errors.AsType[*NotCaughtUpError](err); !ok || !strings.Contains(behind.Detail, "asset:a") {
			t.Fatalf("got %v, want a NotCaughtUpError naming asset:a", err)
		}
	})
}

func TestStatus(t *testing.T) {
	root := "package permit.root\n\ndefault allow := false\n\n" + policy.RootAllow + "\n"
	custom := policy.Custom("v1")
	modules := func(rootStatus int, rootBody string, customStatus int) *Client {
		return fakeOPA(t, func(path string) (int, string) {
			switch path {
			case "/healthy":
				return 200, `{}`
			case "/v1/policies/root.rego":
				return rootStatus, `{"result":{"raw":` + quote(rootBody) + `}}`
			case "/v1/policies/custom/root.rego":
				return customStatus, `{"result":{"raw":` + quote(custom) + `}}`
			}
			return 404, `{}`
		})
	}
	for name, tc := range map[string]struct {
		client  *Client
		rules   bool
		unknown bool
	}{
		"rules installed and required":    {modules(200, root, 200), true, false},
		"custom module missing":           {modules(200, root, 404), false, false},
		"root not wired":                  {modules(200, "package permit.root\n\nallow {\n\tpolicies.allow\n}\n", 200), false, false},
		"OPA answers 500":                 {modules(500, root, 500), false, true},
		"no root.rego: not the PDP's OPA": {modules(404, root, 404), false, true},
	} {
		t.Run(name, func(t *testing.T) {
			st := tc.client.Status()
			if !st.PDP || st.ActingOrgRule != tc.rules || (st.RulesUnknown != "") != tc.unknown {
				t.Fatalf("got %+v", st)
			}
		})
	}
	t.Run("OPA unreachable: unknown, not missing", func(t *testing.T) {
		st := unreachable(t).Status()
		if st.ActingOrgRule || st.RulesUnknown == "" {
			t.Fatalf("got %+v", st)
		}
	})
}

func TestCustomPolicyVersion(t *testing.T) {
	installed := fakeOPA(t, func(string) (int, string) {
		return 200, `{"result":{"raw":` + quote(policy.Custom("2026-10-13T10:00:00Z")) + `}}`
	})
	if v, err := installed.CustomPolicyVersion(); err != nil || v != "2026-10-13T10:00:00Z" {
		t.Fatalf("got %q, %v", v, err)
	}
	missing := fakeOPA(t, func(string) (int, string) { return 404, `{}` })
	if v, err := missing.CustomPolicyVersion(); err != nil || v != "" {
		t.Fatalf("not loaded: got %q, %v", v, err)
	}
	if _, err := unreachable(t).CustomPolicyVersion(); err == nil {
		t.Fatal("unreachable: no error")
	}
}

func TestDebug(t *testing.T) {
	c := NewCheck("sam", "view", "asset:acme-hou-01", "acme")
	if _, err := unreachable(t).Debug(c); err == nil {
		t.Error("Debug: no error from an unreachable PDP")
	}
	if _, err := unreachable(t).DebugMany([]Check{c}); err == nil {
		t.Error("DebugMany: no error from an unreachable PDP")
	}
	short := fakeOPA(t, func(string) (int, string) { return 200, `{"allow":[{"debug":{"rbac":{}}}]}` })
	if _, err := short.DebugMany([]Check{c, c}); err == nil {
		t.Error("DebugMany: no error for one answer to two checks")
	}
	off := fakeOPA(t, func(string) (int, string) { return 200, `{"allow":false}` })
	if debug, err := off.Debug(c); err != nil || debug != nil {
		t.Errorf("PDP_DEBUG off: got %v, %v; want nil without an error", debug, err)
	}
}

func quote(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`)
	return `"` + r.Replace(s) + `"`
}

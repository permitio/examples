package server

import (
	"strings"
	"sync/atomic"
	"testing"
)

// An action reports success only when the PDP shows the write. When the PDP lags, or its data
// can't be read, the answer says so instead of claiming the effect.
func TestActionsReportWhetherThePDPCaughtUp(t *testing.T) {
	shortWaits(t)
	grant := `{"user":"rachel","org":"acme","action":"grant","partner":"pat"}`
	decommission := `{"user":"sam","org":"acme","action":"decommission"}`
	stored := func(state string) func(string) (int, string) {
		return func(path string) (int, string) {
			if path == "/v1/data/resource_instances/asset:acme-dal-01" {
				return 200, `{"result":{"tenant":"acme","attributes":{"lifecycle_state":"` + state + `"}}}`
			}
			return 200, `{}`
		}
	}
	broken := func(string) (int, string) { return 500, `{"code":"internal_error"}` }

	for name, tc := range map[string]struct {
		path, body string
		fake       func(granted *atomic.Bool) *fake
		ok         bool
		says       string // part of the message (ok) or of the error (not ok)
	}{
		"grant, the decision flips": {
			path: "/api/trucks/acme-hou-01/act", body: grant, ok: true,
			fake: func(granted *atomic.Bool) *fake {
				return &fake{decide: func(user, action, resource, tenant string) bool {
					return user != "pat" || granted.Load()
				}}
			},
			says: "Pat Morgan can now service Truck HOU-01, and only this truck, acting for Acme Freight.",
		},
		"grant, the decision never flips": {
			path: "/api/trucks/acme-hou-01/act", body: grant,
			fake: func(*atomic.Bool) *fake {
				return &fake{decide: func(user, _, _, _ string) bool { return user != "pat" }}
			},
			says: "Permit has the change, but the PDP doesn't confirm it: after 300ms it still denies Pat Morgan view on Truck HOU-01.",
		},
		"decommission, the PDP's data shows it": {
			path: "/api/trucks/acme-dal-01/act", body: decommission, ok: true,
			fake: func(*atomic.Bool) *fake { return &fake{opa: stored("decommissioned")} },
			says: "Truck DAL-01 is decommissioned: its lifecycle_state attribute in Permit changed.",
		},
		"decommission, the PDP's data never shows it": {
			path: "/api/trucks/acme-dal-01/act", body: decommission,
			fake: func(*atomic.Bool) *fake { return &fake{opa: stored("active")} },
			says: "after 300ms its data doesn't show Truck DAL-01's lifecycle_state decommissioned",
		},
		"decommission, the PDP's data can't be read": {
			path: "/api/trucks/acme-dal-01/act", body: decommission,
			fake: func(*atomic.Bool) *fake { return &fake{opa: broken} },
			says: "couldn't read its data to confirm Truck DAL-01's lifecycle_state decommissioned (reading the PDP's data: GET /v1/data/resource_instances/asset:acme-dal-01: 500 Internal Server Error)",
		},
		"transfer, the PDP's data can't be read": {
			path: "/api/trucks/acme-dal-01/act", body: `{"user":"ava","org":"acme","action":"transfer","site":"lonestar-fortworth"}`,
			fake: func(*atomic.Bool) *fake { return &fake{opa: broken} },
			says: "couldn't read its data to confirm Truck DAL-01 in Lone Star Logistics",
		},
	} {
		t.Run(name, func(t *testing.T) {
			var granted atomic.Bool
			f := tc.fake(&granted)
			_, h := newTestApp(t, f)
			if strings.Contains(tc.body, `"grant"`) {
				// Permit takes the assignment: the PDP allows Pat from then on (when it catches up).
				inner := f.decide
				f.decide = func(user, action, resource, tenant string) bool {
					for _, w := range f.written() {
						if strings.Contains(w, "/users/pat/roles") {
							granted.Store(true)
						}
					}
					return inner(user, action, resource, tenant)
				}
			}
			code, out := post(t, h, tc.path, tc.body)
			if code != 200 {
				t.Fatalf("status %d: %v", code, out)
			}
			if ok, _ := out["ok"].(bool); ok != tc.ok {
				t.Fatalf("ok = %v, want %v: %v", ok, tc.ok, out)
			}
			text, _ := out["message"].(string)
			if !tc.ok {
				text, _ = out["error"].(string)
				if _, claims := out["message"]; claims {
					t.Errorf("a lagging write still carries the success message %q", out["message"])
				}
			}
			if !strings.Contains(text, tc.says) {
				t.Errorf("got %q, want it to contain %q", text, tc.says)
			}
			if len(f.written()) == 0 {
				t.Error("nothing was written to Permit")
			}
		})
	}
}

// After a transfer the page moves on whatever the PDP shows: the truck has left the organization.
func TestTransferRedirectsEvenWhenThePDPLags(t *testing.T) {
	shortWaits(t)
	_, h := newTestApp(t, &fake{opa: func(string) (int, string) { return 500, `{}` }})
	_, out := post(t, h, "/api/trucks/acme-dal-01/act", `{"user":"ava","org":"acme","action":"transfer","site":"lonestar-fortworth"}`)
	if out["redirect"] != "#/" {
		t.Errorf("redirect %v, want #/: %v", out["redirect"], out)
	}
}

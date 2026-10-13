package server

import (
	"slices"
	"strings"
	"testing"
)

// The People page shows an organization's roster, roles and certifications only to someone the PDP
// lets act on it; a broker or a partner technician acting for a customer gets a denial.
func TestPeoplePageNeedsAnAllowedCheck(t *testing.T) {
	// The seed's decisions that matter here: Sam may give roles at Dallas; nobody else may do anything.
	pdp := &fake{decide: func(user, action, resource, tenant string) bool {
		return user == "sam" && action == "assign_roles" && resource == "site:acme-dallas"
	}}
	_, h := newTestApp(t, pdp)

	_, denied := get(t, h, "/api/people?user=skyler&org=acme")
	if denied["denied"] != true || denied["people"] != nil {
		t.Errorf("skyler: got %v, want a denial without the roster", denied)
	}
	if reason, _ := denied["reason"].(string); !strings.Contains(reason, "lets Skyler manage users of Acme Freight") {
		t.Errorf("skyler: reason %q", reason)
	}
	if log, _ := denied["log"].([]any); len(log) != 1 {
		t.Errorf("skyler: the log should hold the bulk check, got %v", denied["log"])
	}

	_, shown := get(t, h, "/api/people?user=sam&org=acme")
	if people, _ := shown["people"].([]any); shown["denied"] != nil || len(people) == 0 {
		t.Errorf("sam: got %v, want the roster", shown)
	}
}

// A certification change is decided and written against Permit's current attributes, not the app's
// copy from start-up: otherwise a tier 3 removed since (a reset, the dashboard) is given back by an
// org admin's tier 2 change, without the platform-staff check.
func TestCertifyReadsPermitsAttributes(t *testing.T) {
	pdp := &fake{
		decide: func(user, action, resource, tenant string) bool { return resource != "org:platform" },
		users:  map[string]map[string]any{"ivy": {"certifications": []any{"tier1"}}},
	}
	a, h := newTestApp(t, pdp)
	a.userAttrs["ivy"] = map[string]any{"certifications": []any{"tier1", "tier3"}} // stale: Permit has tier1 only

	_, out := post(t, h, "/api/people/ivy/act", `{"user":"olivia","org":"acme","action":"certify","certifications":["tier1","tier2","tier3"]}`)
	if out["denied"] != true {
		t.Fatalf("got %v, want the platform-staff check to deny tier 3", out)
	}
	for _, w := range pdp.written() {
		if strings.Contains(w, "/users/ivy") {
			t.Errorf("wrote %s", w)
		}
	}
	if got := certificationsIn(a.userAttrs["ivy"]); !slices.Equal(got, []string{"tier1"}) {
		t.Errorf("the app's copy is %v, want Permit's [tier1]", got)
	}
}

// Break-glass access writes the person's attributes back whole: Permit's current ones, with only the
// grants changed.
func TestBreakglassKeepsPermitsOtherAttributes(t *testing.T) {
	shortWaits(t)
	pdp := &fake{users: map[string]map[string]any{"pat": {"certifications": []any{"tier1"}, "home_tenant": "mesa"}}}
	a, h := newTestApp(t, pdp)
	a.userAttrs["pat"] = map[string]any{"certifications": []any{"tier1", "tier3"}} // stale

	_, out := post(t, h, "/api/access/act", `{"user":"olivia","org":"acme","action":"breakglass","person":"pat","incident":"INC-1","minutes":2}`)
	if out["error"] != nil && !strings.Contains(out["error"].(string), "Permit has the change") {
		t.Fatalf("got %v", out)
	}
	var update string
	for _, w := range pdp.written() {
		if strings.HasPrefix(w, "PATCH ") && strings.Contains(w, "/users/pat ") {
			update = w
		}
	}
	if !strings.Contains(update, `"certifications":["tier1"]`) || !strings.Contains(update, `"home_tenant":"mesa"`) || !strings.Contains(update, `"incident_id":"INC-1"`) {
		t.Errorf("the update was %q, want Permit's attributes with the new grant", update)
	}
}

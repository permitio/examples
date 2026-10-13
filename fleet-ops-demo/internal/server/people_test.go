package server

import (
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

package checks

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"fleetops/internal/model"
)

// Every pre-flight check names a seeded person, organization and resource, so a typo can't turn a
// check into a deny that passes for the wrong reason (the tenant rule denies unknown resources).
func TestChecksNameSeededData(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range Checks {
		t.Run(c.ID, func(t *testing.T) {
			if seen[c.ID] {
				t.Errorf("duplicate check ID %s", c.ID)
			}
			seen[c.ID] = true
			if _, ok := model.UserOf(c.User); !ok {
				t.Errorf("unknown person %q", c.User)
			}
			if _, ok := model.TenantOf(c.ActingOrg); !ok {
				t.Errorf("unknown organization %q", c.ActingOrg)
			}
			if _, ok := model.SeedByID[c.Resource]; !ok {
				t.Errorf("unknown resource %q", c.Resource)
			}
			if c.Expect != "allow" && c.Expect != "deny" {
				t.Errorf("expect is %q, want allow or deny", c.Expect)
			}
		})
	}
}

// The README states how many checks `make verify` runs.
func TestReadmeCountsTheChecks(t *testing.T) {
	readme, err := os.ReadFile("../../README.md")
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("(%d checks)", len(Checks))
	if !strings.Contains(string(readme), want) {
		t.Errorf("README.md doesn't say %q", want)
	}
}

// Scenario 7: acting for the operating organization, a role the owner granted doesn't count.
func TestOperatorChecksCoverOwnerGrantedRoles(t *testing.T) {
	want := map[string]bool{
		"ivy lonestar asset:acme-dal-04 service_basic deny":            false,
		"jordan lonestar asset:acme-dal-04 service_advanced deny":      false,
		"lena lonestar asset:acme-dal-04 operate allow":                false,
		"quinn acme asset:acme-dal-04 operate deny":                    false,
		"sam acme asset:acme-dal-04 decommission allow":                false,
		"lena lonestar asset:acme-dal-04 decommission deny":            false,
		"ivy acme asset:acme-dal-04 service_basic deny":                false,
		"jordan lonestar asset:lonestar-ftw-01 service_advanced allow": false,
	}
	for _, c := range Checks {
		key := strings.Join([]string{c.User, c.ActingOrg, c.Resource, c.Action, c.Expect}, " ")
		if _, ok := want[key]; ok {
			want[key] = true
		}
	}
	for key, found := range want {
		if !found {
			t.Errorf("no pre-flight check %q", key)
		}
	}
}

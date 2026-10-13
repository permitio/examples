package main

import (
	"strings"
	"testing"

	"fleetops/policy"
)

const generatedRoot = `package permit.root

import data.permit.custom
import data.permit.debug
import data.permit.policies

default allow := false

allow {
	policies.allow
}

allow {
	custom.allow
}

allowing_sources := policies.__allow_sources

debug = result {
	debugger_activated
	result := debug.debug
}
`

const isolationOnlyRoot = `package permit.root

default allow := false

# An earlier patch that required tenant isolation only.
allow {
	policies.allow
	custom.acting_org_ok
}

allowing_sources := policies.__allow_sources

debug = result {
	debugger_activated
	result := object.union(debug.debug, {"acting_org": custom.acting_org_debug})
}
`

func TestPatchRoot(t *testing.T) {
	for name, root := range map[string]string{"generated": generatedRoot, "isolation-only": isolationOnlyRoot} {
		t.Run(name, func(t *testing.T) {
			patched, err := patchRoot(root)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(patched, policy.RootAllow) || !strings.Contains(patched, policy.RootDebug) {
				t.Fatalf("patched root.rego misses the managed rules:\n%s", patched)
			}
			if strings.Contains(patched, "custom.allow\n") || strings.Count(patched, "\nallow {") != 2 {
				t.Fatalf("expected exactly the two managed allow rules:\n%s", patched)
			}
			again, err := patchRoot(patched)
			if err != nil || again != patched {
				t.Fatalf("patching twice changed the file (err %v)", err)
			}
		})
	}
	if _, err := patchRoot("package permit.root\n"); err == nil {
		t.Fatal("expected an error for an unexpected layout")
	}
}

func TestSameRules(t *testing.T) {
	installed := policy.Custom("2026-10-11T17:00:00Z")
	if !policy.SameRules(installed) {
		t.Fatal("an installed copy with another version should count as the same rules")
	}
	if policy.SameRules(installed + "\n# edited\n") {
		t.Fatal("an edited copy should not count as the same rules")
	}
}

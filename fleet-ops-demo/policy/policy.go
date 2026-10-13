// Package policy holds the custom Rego this demo adds to Permit's generated policy, and the allow
// rules root.rego needs to require it. `make apply-policy` installs both in the GitOps repo.
package policy

import (
	_ "embed"
	"regexp"
	"strings"
)

//go:embed custom.rego
var customTemplate string

const versionPlaceholder = "{{POLICY_VERSION}}"

var versionLine = regexp.MustCompile(`(?m)^policy_version := ".*"$`)

// Custom is custom/root.rego with the given version stamped in.
func Custom(version string) string {
	return strings.Replace(customTemplate, versionPlaceholder, version, 1)
}

// Version is the version stamped in an installed custom/root.rego, "" when none.
func Version(installed string) string {
	if m := versionValue.FindStringSubmatch(installed); m != nil {
		return m[1]
	}
	return ""
}

var versionValue = regexp.MustCompile(`(?m)^policy_version := "(.*)"$`)

// SameRules reports whether an installed custom/root.rego has these rules, whatever its version.
func SameRules(installed string) bool {
	return versionLine.ReplaceAllString(installed, `policy_version := "`+versionPlaceholder+`"`) == customTemplate
}

// RootAllow replaces the allow rules of Permit's generated root.rego: the generated policy, or a grant
// in custom/root.rego, must allow, and every allow requires the custom constraints.
const RootAllow = `# Fleet Ops demo: the generated policy (RBAC, ReBAC, ABAC) or a grant in custom/root.rego must allow,
# AND the request must satisfy the tenant-isolation rule and the fleet rules in custom/root.rego.
# Custom code adds constraints, and grants only through the second rule.
# Permit may regenerate this file after policy changes in the dashboard. If ` + "`make verify`" + ` reports
# the rules missing, run ` + "`make apply-policy`" + ` in fleetops-go to re-apply them.
allow {
	policies.allow
	custom.acting_org_ok
	custom.fleet_rules_ok
}

allow {
	custom.extra_allow
	custom.acting_org_ok
	custom.fleet_rules_ok
}`

// RootDebug is the debug result line: Permit's debug output plus both custom verdicts.
const RootDebug = `result := object.union(debug.debug, {"acting_org": custom.acting_org_debug, "fleet_rules": custom.fleet_rules_debug})`

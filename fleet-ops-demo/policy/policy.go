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

// Version is the version stamped in an installed custom/root.rego, "" when none. The PDP's copy of
// the module is read with it too.
func Version(installed string) string {
	if m := versionValue.FindStringSubmatch(installed); m != nil {
		return m[1]
	}
	return ""
}

var versionValue = regexp.MustCompile(`(?m)^policy_version := "([^"]*)"`)

// SameRules reports whether an installed custom/root.rego has these rules, whatever its version.
func SameRules(installed string) bool {
	return versionLine.ReplaceAllString(installed, `policy_version := "`+versionPlaceholder+`"`) == customTemplate
}

// RootAllow replaces the allow rules of Permit's generated root.rego: the generated policy, or a grant
// in custom/root.rego, must allow, and every allow requires the custom constraints.
const RootAllow = `# Fleet Ops demo: the generated policy (RBAC, ReBAC, ABAC) or a grant in custom/root.rego must allow,
# AND the request must satisfy the tenant-isolation rule and the fleet rules in custom/root.rego.
# Custom code adds constraints, and grants only through the second rule.
# Schema and dashboard changes leave this file alone; Permit replaces it only when it merges a policy
# library update into this branch. If ` + "`make verify`" + ` then reports the rules missing, run
# ` + "`make apply-policy`" + ` in fleet-ops-demo to apply them again.
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

var (
	regoComment = regexp.MustCompile(`(?m)#.*$`)
	allowHead   = regexp.MustCompile(`(?m)^allow\b`)
	allowRule   = regexp.MustCompile(`(?m)^allow\s*\{([^}]*)\}`)
)

// RequiredByRoot reports whether every allow rule in a root.rego requires both custom constraints,
// custom.acting_org_ok and custom.fleet_rules_ok, in any order: the rules RootAllow installs, or an
// equivalent edit. Comments are ignored, so rules that are commented out count as absent, and an
// allow rule of any other shape counts as not requiring them.
func RequiredByRoot(root string) bool {
	root = regoComment.ReplaceAllString(root, "")
	rules := allowRule.FindAllStringSubmatch(root, -1)
	if len(rules) == 0 || len(rules) != len(allowHead.FindAllStringIndex(root, -1)) {
		return false
	}
	for _, rule := range rules {
		if !hasStatement(rule[1], "custom.acting_org_ok") || !hasStatement(rule[1], "custom.fleet_rules_ok") {
			return false
		}
	}
	return true
}

// hasStatement reports whether a rule body has the expression as a statement of its own, so a
// negated or compared use (`not custom.acting_org_ok`) doesn't count.
func hasStatement(body, expr string) bool {
	for _, line := range strings.FieldsFunc(body, func(r rune) bool { return r == '\n' || r == ';' }) {
		if strings.TrimSpace(line) == expr {
			return true
		}
	}
	return false
}

// RootDebug is the debug result line: Permit's debug output plus both custom verdicts.
const RootDebug = `result := object.union(debug.debug, {"acting_org": custom.acting_org_debug, "fleet_rules": custom.fleet_rules_debug})`

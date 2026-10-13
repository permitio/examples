// Package explain turns a decision and the PDP's debug output into what the log shows: one
// sentence, the relationship route or the rule's conditions, and the tenant-isolation verdict.
package explain

import (
	"fmt"
	"strings"
	"time"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
	"fleetops/internal/schema"
)

var actionPhrases = map[string]string{
	"view":             "view",
	"operate":          "operate",
	"service_basic":    "do basic service on",
	"service_advanced": "do advanced service on",
	"decommission":     "decommission",
	"assign_roles":     "assign roles on",
	"manage_users":     "manage users of",
	"view_activity":    "view the activity of",
}

// Condition is one rule condition with the value the PDP evaluated.
type Condition struct {
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Actual any    `json:"actual"`
}

type Explanation struct {
	Reason string `json:"reason"`
	// Route is the relationship route, origin first ("role on Name"); nil when none.
	Route []string `json:"route"`
	// Rule is the ABAC rule's conditions; nil when the action has no rule.
	Rule []Condition `json:"rule"`
	// ActingOrg is the tenant-isolation rule's code: same_org, operator_org or acting_org_mismatch.
	ActingOrg string `json:"actingOrg"`
	// FleetRule is the fleet rule that blocked the decision (unassigned, decommissioned,
	// certification_missing, operated_by_other_org), if any.
	FleetRule string `json:"fleetRule"`
	// Grant names the custom grant that allowed the decision: operator_org or breakglass.
	Grant string `json:"grant"`
	// PolicyVersion is the version of the custom rules that decided (scenario 17).
	PolicyVersion string `json:"policyVersion"`
}

type hop struct{ resource, role, name string }

// route follows allowing_roles from the role that allowed down to the assignment it came from:
// role_derivation sources nest down to a role_assignment. Returns the origin first.
func route(allowingRole map[string]any, nameOf func(string) string) []hop {
	hops := []hop{{resource: str(allowingRole, "resource"), role: lastPart(str(allowingRole, "role"))}}
	node := allowingRole
	for {
		var derived map[string]any
		for _, s := range list(node, "sources") {
			if src, ok := s.(map[string]any); ok && str(src, "type") == "role_derivation" {
				derived = src
				break
			}
		}
		if derived == nil {
			break
		}
		hops = append(hops, hop{resource: str(derived, "resource"), role: lastPart(str(derived, "role"))})
		node = derived
	}
	out := make([]hop, len(hops))
	for n, h := range hops {
		h.name = nameOf(h.resource)
		out[len(hops)-1-n] = h
	}
	return out
}

var operators = map[string]func(actual, value any) bool{
	"array_contains": func(actual, value any) bool {
		items, ok := actual.([]any)
		if !ok {
			return false
		}
		for _, item := range items {
			if item == value {
				return true
			}
		}
		return false
	},
	"equals": func(actual, value any) bool {
		a, aNum := number(actual)
		b, bNum := number(value)
		if aNum && bNum {
			return a == b
		}
		return actual == value
	},
}

var labels = map[string]func(v any) string{
	"user.roles": func(v any) string { return fmt.Sprintf("Org-level role %v in the acting organization", v) },
	"user.certifications": func(v any) string {
		return fmt.Sprintf("Holds the %s certification", strings.Replace(fmt.Sprint(v), "tier", "tier ", 1))
	},
	"resource.lifecycle_state": func(v any) string { return fmt.Sprintf("Truck is %v", v) },
	"resource.region":          func(v any) string { return fmt.Sprintf("Truck's region is %v", v) },
	"resource.served_account":  func(v any) string { return fmt.Sprintf("Truck serves %v", v) },
}

// label words a condition; conditions without a wording of their own get a generic one.
func label(ref string, value any) string {
	if f, ok := labels[ref]; ok {
		return f(value)
	}
	return fmt.Sprintf("%s is %v", ref, value)
}

// rule re-evaluates an attribute rule's conditions on the attributes the PDP reported, so the log
// shows exactly which input made the rule match or miss. Of the rules for this permission it picks
// the one that allowed, or else one whose org-level role the person holds; none when the person is
// outside every rule.
func rule(c pdp.Check, debug map[string]any, allowedByRule bool) []Condition {
	request := obj(debug, "request")
	if request == nil {
		return nil
	}
	attrs := map[string]map[string]any{
		"user":     obj(obj(request, "user"), "attributes"),
		"resource": obj(obj(request, "resource"), "attributes"),
	}
	var inScope []Condition
	for _, r := range schema.ConditionSetRules {
		if r.Permission != c.Resource.Type+":"+c.Action {
			continue
		}
		rows, matched, holdsRole := evaluate(r, attrs)
		if allowedByRule && matched {
			return rows
		}
		if !allowedByRule && holdsRole && inScope == nil {
			inScope = rows
		}
	}
	return inScope
}

// evaluate checks one rule's conditions. holdsRole: the person holds the rule's org-level role.
func evaluate(r schema.ConditionSetRule, attrs map[string]map[string]any) (rows []Condition, matched, holdsRole bool) {
	matched, holdsRole = true, true
	for _, setKey := range []string{r.UserSet, r.ResourceSet} {
		cs, _ := schema.ConditionSetByKey(setKey)
		for _, cond := range cs.AllOf {
			o, attr, _ := strings.Cut(cond.Ref, ".")
			actual := attrs[o][attr]
			ok := operators[cond.Op](actual, cond.Value)
			matched = matched && ok
			if cond.Ref == "user.roles" {
				holdsRole = holdsRole && ok
			}
			rows = append(rows, Condition{Label: label(cond.Ref, cond.Value), OK: ok, Actual: actual})
		}
	}
	return rows, matched, holdsRole
}

// phraseOf words an action for a sentence: "do basic service on".
func phraseOf(action string) string {
	if phrase := actionPhrases[action]; phrase != "" {
		return phrase
	}
	return action
}

// Unavailable explains a decision whose debug output couldn't be had: the verdict, and why no reason
// is shown, never a guessed one. why is lowercase, without a final period.
func Unavailable(allow bool, c pdp.Check, nameOf func(string) string, why string) Explanation {
	verdict := "can"
	if !allow {
		verdict = "can't"
	}
	return Explanation{Reason: fmt.Sprintf("%s %s %s %s. No reason to show: %s.", model.UserName(c.User), verdict, phraseOf(c.Action), nameOf(c.Resource.ID()), why)}
}

// Explain builds the log's explanation of one decision. nameOf names an instance by "type:key". An
// empty debug gives only the verdict (see Unavailable).
func Explain(allow bool, debug map[string]any, c pdp.Check, nameOf func(string) string) Explanation {
	if len(debug) == 0 {
		return Unavailable(allow, c, nameOf, "the PDP answered without its debug output (is PDP_DEBUG=true set on its container?)")
	}
	user := model.UserName(c.User)
	res := c.Resource
	target := nameOf(res.ID())
	phrase := phraseOf(c.Action)
	acting := obj(debug, "acting_org")
	rebac, rbac, abac := obj(debug, "rebac"), obj(debug, "rbac"), obj(debug, "abac")
	var hops []hop
	if allowing := list(rebac, "allowing_roles"); len(allowing) > 0 {
		if first, ok := allowing[0].(map[string]any); ok {
			hops = route(first, nameOf)
		}
	}
	conditions := rule(c, debug, allow && boolean(abac, "allow"))
	blocked := acting != nil && !boolean(acting, "allow")
	fleet := obj(debug, "fleet_rules")
	var violation map[string]any
	if v := list(fleet, "violations"); len(v) > 0 {
		violation, _ = v[0].(map[string]any)
	}
	grant := str(fleet, "granted_by")

	var headline string
	switch {
	case allow && boolean(rebac, "allow") && len(hops) > 0:
		origin := hops[0]
		role := strings.ReplaceAll(origin.role, "_", " ")
		levels := len(hops) - 1
		if levels > 0 {
			plural := "s"
			if levels == 1 {
				plural = ""
			}
			headline = fmt.Sprintf("%s can %s %s through relationships: %s on %s, derived %d level%s down.", user, phrase, target, role, origin.name, levels, plural)
		} else {
			headline = fmt.Sprintf("%s can %s %s through a role granted on it directly: %s.", user, phrase, target, role)
		}
	case allow && boolean(rbac, "allow"):
		var roles []string
		for _, r := range list(rbac, "allowing_roles") {
			roles = append(roles, strings.ReplaceAll(fmt.Sprint(r), "_", " "))
		}
		headline = fmt.Sprintf("%s can %s %s with the org-level role %s in %s.", user, phrase, target, strings.Join(roles, ", "), model.OrgName(res.Tenant))
	case allow && boolean(abac, "allow"):
		headline = fmt.Sprintf("%s can %s %s: every condition of the rule matched.", user, phrase, target)
	case allow && grant == "operator_org":
		headline = fmt.Sprintf("%s can %s %s: %s operates it for %s, and %s holds a role in %s.",
			user, phrase, target, model.OrgName(res.Tenant), model.OrgName(str(acting, "resource_org")), user, model.OrgName(res.Tenant))
	case allow && grant == "breakglass":
		headline = fmt.Sprintf("%s can %s %s under a break-glass grant%s.", user, phrase, target, breakglassText(fleet))
	case allow:
		headline = fmt.Sprintf("%s can %s %s.", user, phrase, target)
	case blocked && str(acting, "code") == "unknown_resource":
		headline = fmt.Sprintf("%s isn't in the PDP's data, so the PDP can't tie it to an organization and denies.", target)
	case blocked:
		headline = fmt.Sprintf("%s belongs to %s, and %s is acting for %s. Access held through other organizations doesn't apply.",
			target, model.OrgName(str(acting, "resource_org")), user, model.OrgName(str(acting, "acting_org")))
	case violation != nil:
		headline = violationText(violation, user, phrase, target)
	case conditions != nil:
		failed := 0
		for _, r := range conditions {
			if !r.OK {
				failed++
			}
		}
		verb := "are"
		if failed == 1 {
			verb = "is"
		}
		headline = fmt.Sprintf("%s can't %s %s: %d of the rule's %d conditions %s not met.", user, phrase, target, failed, len(conditions), verb)
	default:
		headline = fmt.Sprintf("No role, relationship or rule in %s lets %s %s %s.", model.OrgName(res.Tenant), user, phrase, target)
	}

	e := Explanation{Reason: headline, Rule: conditions, ActingOrg: str(acting, "code"), Grant: grant, PolicyVersion: str(fleet, "policy_version")}
	if violation != nil && !allow {
		e.FleetRule = str(violation, "code")
	}
	for _, h := range hops {
		e.Route = append(e.Route, strings.ReplaceAll(h.role, "_", " ")+" on "+h.name)
	}
	return e
}

// violationText words a fleet rule that blocked the decision.
func violationText(v map[string]any, user, phrase, target string) string {
	switch str(v, "code") {
	case "unassigned":
		return fmt.Sprintf("%s is unassigned: only the platform staff can see or use it.", target)
	case "decommissioned":
		return fmt.Sprintf("%s is decommissioned: only view and decommission are allowed.", target)
	case "operated_by_other_org":
		return fmt.Sprintf("%s is operated by %s: operational actions belong to the operating organization, not the owner.", target, model.OrgName(str(v, "operator_org")))
	case "certification_missing":
		return fmt.Sprintf("%s can't %s %s: %s.", user, phrase, target, str(v, "reason"))
	}
	return fmt.Sprintf("%s can't %s %s: %s.", user, phrase, target, str(v, "reason"))
}

// breakglassText describes the active break-glass grant: " for incident INC-1042, until 15:31 UTC".
func breakglassText(fleet map[string]any) string {
	grants := list(fleet, "breakglass")
	if len(grants) == 0 {
		return ""
	}
	g, _ := grants[0].(map[string]any)
	until := ""
	if secs, ok := number(g["expires_at"]); ok {
		until = ", until " + time.Unix(int64(secs), 0).Format("15:04")
	}
	return fmt.Sprintf(" for incident %s%s", str(g, "incident_id"), until)
}

// ---- Reading the PDP's JSON ------------------------------------------------------------------------

func obj(m map[string]any, key string) map[string]any {
	v, _ := m[key].(map[string]any)
	return v
}

func list(m map[string]any, key string) []any {
	v, _ := m[key].([]any)
	return v
}

func str(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func boolean(m map[string]any, key string) bool {
	v, _ := m[key].(bool)
	return v
}

func lastPart(role string) string {
	parts := strings.Split(role, "#")
	return parts[len(parts)-1]
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

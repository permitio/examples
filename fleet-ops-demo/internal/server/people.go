package server

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/permitio/permit-golang/pkg/models"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
	"fleetops/internal/permitapi"
	"fleetops/internal/schema"
)

var tiers = []string{"tier1", "tier2", "tier3"}

var roleNames = map[string]string{
	"org_admin": "Org admin", "region_manager": "Region manager", "site_manager": "Site manager",
	"operator": "Operator", "technician": "Technician", "viewer": "Viewer",
	"team_supervisor": "Team supervisor", "partner_technician": "Partner technician",
}

func roleName(role string) string {
	if n, ok := roleNames[role]; ok {
		return n
	}
	return strings.ReplaceAll(role, "_", " ")
}

// peoplePage lists the acting organization's people and what the person may do with each one: give
// and remove roles on sites (scenario 2), see a team's recent activity (scenario 5), change
// certifications (scenario 9), remove the person from Permit (scenario 15). One bulk call decides it,
// and when it allows none of these the page is denied: the roster is shown only to people who may
// act on it.
func (a *App) peoplePage(user, org string) (obj, error) {
	r := a.newRequest()
	var people []model.User
	for _, u := range model.Users {
		if u.HomeTenant == org && a.exists(u.Key) {
			people = append(people, u)
		}
	}
	teams := a.filter(func(i *model.Instance) bool { return i.Type == "team" && i.Tenant == org }, byName)
	sites := a.sitesOf(org)
	asks := []pdp.Check{pdp.NewCheck(user, "manage_users", "org:"+org, org)}
	for _, t := range teams {
		asks = append(asks, pdp.NewCheck(user, "view_activity", t.ID(), org))
	}
	for _, s := range sites {
		asks = append(asks, pdp.NewCheck(user, "assign_roles", s.ID(), org))
	}
	answers, err := r.checkMany(fmt.Sprintf("People of %s: what may %s see and do?", model.OrgName(org), model.UserName(user)), asks)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(answers, true) {
		return obj{"denied": true, "reason": r.log[len(r.log)-1].Calls[0].Reason, "log": r.log}, nil
	}
	can := map[string]bool{}
	for n, c := range asks {
		can[c.Action+" "+c.Resource.ID()] = answers[n]
	}
	manage := can["manage_users org:"+org]

	rows := []obj{}
	for _, p := range people {
		row := obj{
			"key":            p.Key,
			"name":           model.FullName(p.Key),
			"title":          p.Title,
			"certifications": nonNil(a.certifications(p.Key)),
			"canCertify":     manage,
			"canRemove":      manage && p.Key != user,
			"team":           nil,
			"activity":       nil,
			"roles":          a.rolesOf(p.Key, org, can, p.Key != user),
		}
		if team := a.teamOf(p.Key); team != "" {
			row["team"] = a.nameOf(team)
			if can["view_activity "+team] {
				events := []obj{}
				for n, e := range a.activity[p.Key] {
					if n == 5 {
						break
					}
					events = append(events, obj{"text": e.Text, "time": e.At.Format("15:04")})
				}
				row["activity"] = events
			}
		}
		rows = append(rows, row)
	}
	// The role form lists every site of the organization, so a denied assignment can be tried and shown.
	siteList, canGive := []named{}, false
	for _, s := range sites {
		siteList = append(siteList, named{Key: s.Key, Name: s.Name})
		canGive = canGive || can["assign_roles "+s.ID()]
	}
	roles := []named{}
	for _, role := range siteRoles {
		roles = append(roles, named{Key: role, Name: roleName(role)})
	}
	return obj{"people": rows, "sites": siteList, "roles": roles, "canGiveRoles": canGive, "log": r.log}, nil
}

// rolesOf describes a person's roles in an organization; site roles can be removed by the site's
// admins, though not from themselves.
func (a *App) rolesOf(user, org string, can map[string]bool, removable bool) []obj {
	out := []obj{}
	for _, ra := range a.assignments {
		if ra.User != user || ra.Tenant != org {
			continue
		}
		row := obj{"role": ra.Role, "site": nil, "canRemove": false}
		switch typ, key, _ := strings.Cut(ra.ResourceInstance, ":"); typ {
		case "":
			// An org-level role: describe the resource sets its rules grant it (scenario 11).
			var sets []string
			for _, rule := range schema.ConditionSetRules {
				if rule.UserSet == schema.RoleSet(ra.Role) {
					if cs, ok := schema.ConditionSetByKey(rule.ResourceSet); ok && !slices.Contains(sets, cs.Name) {
						sets = append(sets, cs.Name)
					}
				}
			}
			on := strings.Join(sets, ", ")
			if on != "" {
				on = strings.ToLower(on[:1]) + on[1:]
			}
			row["label"] = fmt.Sprintf("%s (org-level) on %s", roleName(ra.Role), on)
		case "site":
			row["label"] = fmt.Sprintf("%s at %s", roleName(ra.Role), a.nameOf(ra.ResourceInstance))
			row["site"] = key
			row["canRemove"] = removable && slices.Contains(siteRoles, ra.Role) && can["assign_roles "+ra.ResourceInstance]
		case "asset":
			row["label"] = fmt.Sprintf("%s on %s", roleName(ra.Role), a.nameOf(ra.ResourceInstance))
		default:
			row["label"] = fmt.Sprintf("%s of %s", roleName(ra.Role), a.nameOf(ra.ResourceInstance))
		}
		out = append(out, row)
	}
	slices.SortFunc(out, func(x, y obj) int { return strings.Compare(x["label"].(string), y["label"].(string)) })
	return out
}

// teamOf is the team a person works on, "" when none.
func (a *App) teamOf(user string) string {
	for team, members := range a.members {
		if slices.Contains(members, user) {
			return team
		}
	}
	return ""
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// personAction changes a person's certifications (scenario 9), gives or removes a role on a site
// (scenario 2), or removes the person (scenario 15).
func (a *App) personAction(body actBody, key string) (obj, error) {
	r := a.newRequest()
	person, ok := model.UserOf(key)
	if !ok || !a.exists(key) {
		return obj{"error": "There is no such person.", "log": r.log}, nil
	}
	user, org, name := body.User, body.Org, model.FullName(key)
	fail := func(message string) (obj, error) { return obj{"error": message, "log": r.log}, nil }
	if person.HomeTenant != org {
		return fail(fmt.Sprintf("%s doesn't work for %s.", name, model.OrgName(org)))
	}

	switch body.Action {
	case "certify":
		var want []string
		for _, t := range tiers {
			if slices.Contains(body.Certifications, t) {
				want = append(want, t)
			}
		}
		stored, err := a.storedAttributes(key)
		if err != nil {
			return nil, err
		}
		have := certificationsIn(stored)
		changed := func(t string) bool { return slices.Contains(want, t) != slices.Contains(have, t) }
		basic, advanced := changed("tier1") || changed("tier2"), changed("tier3")
		if !basic && !advanced {
			return fail("Nothing changed.")
		}
		// Tier 1 and tier 2 are the organization's to give: managing its users. Tier 3 only the platform
		// operator can give: the same permission on the platform operator's own organization.
		if basic {
			if ok, err := r.checkOne(fmt.Sprintf("Change %s's tier 1 or tier 2 certification: enforce before writing", name), user, "manage_users", "org:"+org, org); !ok {
				return r.refuse(err)
			}
		}
		if advanced {
			verb := "Grant tier 3 to"
			if !slices.Contains(want, "tier3") {
				verb = "Remove tier 3 from"
			}
			if ok, err := r.platform(fmt.Sprintf("%s %s: platform staff only, enforce before writing", verb, name), user); !ok {
				return r.refuse(err)
			}
		}
		attrs := stored
		list := make([]any, len(want))
		for n, t := range want {
			list[n] = t
		}
		attrs["certifications"] = list
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.Users.Update(ctx, key, models.UserUpdate{Attributes: attrs})
			return err
		}); err != nil {
			return nil, err
		}
		a.userAttrs[key] = attrs
		certs := "no certifications"
		if len(want) > 0 {
			certs = strings.Join(want, ", ")
		}
		r.untilData(fmt.Sprintf("%s's certifications as %s", name, certs), "users/"+key, func(d any) bool {
			stored, _ := field(field(d, "attributes"), "certifications").([]any)
			return len(stored) == len(list) && !slices.ContainsFunc(list, func(t any) bool { return !slices.Contains(stored, t) })
		})
		// What the change does, decided by the PDP on a truck at a site where the person holds a role.
		if truck := a.truckFor(key, org); truck != nil {
			action, words := "service_basic", "basic service"
			if advanced {
				action, words = "service_advanced", "advanced service"
			}
			question := fmt.Sprintf("Can %s do %s on %s now?", name, words, truck.Name)
			if _, err := r.checkOne(question, key, action, truck.ID(), org); err != nil {
				return nil, err
			}
		}
		message := fmt.Sprintf("%s now holds %s. The certification is a person attribute: it counts in every organization that gives %s a role.", name, certs, model.UserName(key))
		a.record(user, fmt.Sprintf("Changed %s's certifications to %s", name, certs))
		return r.done(message, nil), nil

	case "assign", "unassign":
		site, ok := a.instances["site:"+body.Site]
		if !ok || site.Tenant != org || !slices.Contains(siteRoles, body.Role) {
			return fail("Pick a role and a site.")
		}
		assign := body.Action == "assign"
		role := body.Role
		verb, state := "Remove", "is no longer"
		if assign {
			verb, state = "Give", "is now"
		}
		label := fmt.Sprintf("%s %s the %s role at %s", verb, name, strings.ToLower(roleName(role)), site.Name)
		if ok, err := r.checkOne(label+": enforce before writing", user, "assign_roles", site.ID(), org); !ok {
			return r.refuse(err)
		}
		if err := a.writeAssignment(model.RoleAssignment{User: key, Role: role, ResourceInstance: site.ID(), Tenant: site.Tenant}, assign); err != nil {
			return nil, err
		}
		what := fmt.Sprintf("%s's %s role at %s", name, strings.ToLower(roleName(role)), site.Name)
		if !assign {
			what = "the removal of " + what
		}
		r.untilData(what, "role_assignments/user:"+key, func(d any) bool {
			roles, _ := field(d, site.ID()).([]any)
			return slices.Contains(roles, any(role)) == assign
		})
		if trucks := a.children(site.ID(), "asset"); len(trucks) > 0 { // what the role does, decided by the PDP on one of the site's trucks
			t, action := trucks[0], roleTruckAction[role]
			question := fmt.Sprintf("Can %s %s %s now?", name, strings.ReplaceAll(action, "_", " "), t.Name)
			if _, err := r.checkOne(question, key, action, t.ID(), site.Tenant); err != nil {
				return nil, err
			}
		}
		message := fmt.Sprintf("%s %s %s at %s. Every truck at the site follows.", name, state, strings.ToLower(roleName(role)), site.Name)
		a.record(user, message)
		return r.done(message, nil), nil

	case "remove":
		if key == user {
			return fail("You can't remove yourself.")
		}
		if ok, err := r.checkOne(fmt.Sprintf("Remove %s from Permit: enforce before writing", name), user, "manage_users", "org:"+org, org); !ok {
			return r.refuse(err)
		}
		truck := a.firstActiveTruck(org)
		if truck != nil {
			if _, err := r.checkOne(fmt.Sprintf("Before: can %s view %s?", name, truck.Name), key, "view", truck.ID(), org); err != nil {
				return nil, err
			}
		}
		if err := permitapi.Call(func(ctx context.Context) error { return a.api.Users.Delete(ctx, key) }, 404); err != nil {
			return nil, err
		}
		delete(a.userAttrs, key)
		a.assignments = slices.DeleteFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.User == key })
		for team, keys := range a.members {
			a.members[team] = slices.DeleteFunc(keys, func(k string) bool { return k == key })
		}
		if truck != nil {
			if err := r.untilDecision(fmt.Sprintf("After: can %s view %s?", name, truck.Name), key, "view", truck.ID(), org, false); err != nil {
				return nil, err
			}
		}
		// Nothing left behind: no role assignments for the person.
		left, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RoleAssignmentRead, error) {
			return permitapi.Deref(a.api.RoleAssignments.List(ctx, page, perPage, key, "", ""))
		})
		if err != nil {
			return nil, err
		}
		message := fmt.Sprintf("Removed %s from Permit. Left behind: %d role assignments. `make reset` brings %s back.", name, len(left), model.UserName(key))
		a.record(user, "Removed "+name+" from Permit")
		return r.done(message, nil), nil
	}
	return fail("Unknown action.")
}

// truckFor is the first active truck the organization owns and operates at a site where the person
// holds a role, else its first active truck: where a certification change shows.
func (a *App) truckFor(user, org string) *model.Instance {
	for _, t := range a.fleetOf(org) {
		if t.Tenant == org && str(t.Attributes["lifecycle_state"]) == "active" && operatorOf(t) == org &&
			slices.ContainsFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.User == user && ra.ResourceInstance == t.Parent }) {
			return t
		}
	}
	return a.firstActiveTruck(org)
}

// firstActiveTruck is an organization's first active truck that it also operates, for showing what a
// change does.
func (a *App) firstActiveTruck(org string) *model.Instance {
	for _, t := range a.fleetOf(org) {
		if t.Tenant == org && str(t.Attributes["lifecycle_state"]) == "active" && operatorOf(t) == org {
			return t
		}
	}
	return nil
}

// ---- Break-glass access (scenario 14) ---------------------------------------------------------------

// accessPage shows the acting organization's break-glass grants, to people who may grant them.
func (a *App) accessPage(user, org string) (obj, error) {
	r := a.newRequest()
	allowed, err := r.checkOne(fmt.Sprintf("Access page: can %s give break-glass access in %s?", model.UserName(user), model.OrgName(org)), user, "assign_roles", "org:"+org, org)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return obj{"denied": true, "reason": r.last().Reason, "log": r.log}, nil
	}
	now := time.Now()
	grants := []obj{}
	for _, u := range model.Users {
		for _, g := range a.breakglass(u.Key) {
			if g.Tenant != org {
				continue
			}
			grants = append(grants, obj{
				"person":   model.FullName(u.Key),
				"incident": g.IncidentID,
				"until":    time.Unix(g.ExpiresAt, 0).Format("15:04:05"),
				"active":   g.active(now),
				"by":       model.FullName(g.GrantedBy),
			})
		}
	}
	candidates := []named{}
	for _, u := range model.Users {
		if u.HomeTenant != org && a.exists(u.Key) && !a.platformStaff(u.Key) {
			candidates = append(candidates, named{Key: u.Key, Name: model.FullName(u.Key) + ", " + model.OrgName(u.HomeTenant)})
		}
	}
	return obj{"grants": grants, "candidates": candidates, "log": r.log}, nil
}

// accessAction grants break-glass access: view and basic service on the organization's trucks for a
// few minutes, for an incident. The custom policy rule compares the expiry with the clock on every
// decision, so access ends on time with no cleanup job.
func (a *App) accessAction(body actBody) (obj, error) {
	r := a.newRequest()
	user, org, person := body.User, body.Org, body.Person
	fail := func(message string) (obj, error) { return obj{"error": message, "log": r.log}, nil }
	if _, ok := model.UserOf(person); !ok || !a.exists(person) || body.Action != "breakglass" {
		return fail("Pick a person.")
	}
	incident := strings.ToUpper(strings.TrimSpace(body.Incident))
	if incident == "" || body.Minutes < 1 || body.Minutes > 60 {
		return fail("Give an incident ID and between 1 and 60 minutes.")
	}
	name := model.FullName(person)
	if ok, err := r.checkOne(fmt.Sprintf("Give %s break-glass access in %s: enforce before writing", name, model.OrgName(org)), user, "assign_roles", "org:"+org, org); !ok {
		return r.refuse(err)
	}
	// A truck the person can't see without the grant, to show the change.
	var probe *model.Instance
	for _, t := range a.fleetOf(org) {
		if t.Tenant == org && str(t.Attributes["lifecycle_state"]) == "active" && !slices.ContainsFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.User == person && ra.ResourceInstance == t.ID() }) {
			probe = t
			break
		}
	}
	if probe != nil {
		if _, err := r.checkOne(fmt.Sprintf("Before: can %s view %s?", name, probe.Name), person, "view", probe.ID(), org); err != nil {
			return nil, err
		}
	}
	attrs, err := a.storedAttributes(person)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	grant := breakglassGrant{Tenant: org, IncidentID: incident, ExpiresAt: now.Add(time.Duration(body.Minutes) * time.Minute).Unix(), GrantedBy: user}
	list := []any{}
	for _, g := range breakglassIn(attrs) {
		if g.active(now) && g.Tenant != org { // expired grants and the old grant here are dropped
			list = append(list, map[string]any{"tenant": g.Tenant, "incident_id": g.IncidentID, "expires_at": float64(g.ExpiresAt), "granted_by": g.GrantedBy})
		}
	}
	list = append(list, map[string]any{"tenant": grant.Tenant, "incident_id": grant.IncidentID, "expires_at": float64(grant.ExpiresAt), "granted_by": grant.GrantedBy})
	attrs["breakglass"] = list
	if err := permitapi.Call(func(ctx context.Context) error {
		_, err := a.api.Users.Update(ctx, person, models.UserUpdate{Attributes: attrs})
		return err
	}); err != nil {
		return nil, err
	}
	a.userAttrs[person] = attrs
	if probe != nil {
		if err := r.untilDecision(fmt.Sprintf("During incident %s: can %s view %s?", incident, name, probe.Name), person, "view", probe.ID(), org, true); err != nil {
			return nil, err
		}
	}
	until := time.Unix(grant.ExpiresAt, 0).Format("15:04:05")
	message := fmt.Sprintf("%s can view and service %s's trucks for incident %s until %s. After that the same checks deny on their own; nothing has to clean up.", name, model.OrgName(org), incident, until)
	a.record(user, fmt.Sprintf("Gave %s break-glass access for %s", name, incident))
	return r.done(message, nil), nil
}

package server

import (
	"context"
	"fmt"
	"log"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/permitio/permit-golang/pkg/models"

	"fleetops/internal/model"
	"fleetops/internal/permitapi"
)

// actBody is a POST to one of the /act endpoints.
type actBody struct {
	User    string `json:"user"`
	Org     string `json:"org"`
	Action  string `json:"action"`
	Lane    string `json:"lane"`
	Partner string `json:"partner"`
	Site    string `json:"site"`
	Person  string `json:"person"`
	Role    string `json:"role"`
	Region  string `json:"region"`
	Account string `json:"account"`
	// People, access and organizations pages.
	Certifications []string `json:"certifications"`
	Incident       string   `json:"incident"`
	Minutes        int      `json:"minutes"`
	Target         string   `json:"target"`
}

func ptr[T any](v T) *T { return &v }

// truckAction runs one action on a truck. Each is enforced with a PDP check before anything is written.
func (a *App) truckAction(body actBody, key string) (obj, error) {
	r := a.newRequest()
	truck, ok := a.instances["asset:"+key]
	if !ok {
		return obj{"error": "There is no such truck.", "log": r.log}, nil
	}
	id, user, org := truck.ID(), body.User, body.Org
	site := a.siteOf(truck)

	enforce := func(label, permission, resource string) (bool, error) {
		return r.checkOne(label+": enforce before writing", user, permission, resource, org)
	}
	fail := func(message string) (obj, error) { return obj{"error": message, "log": r.log}, nil }
	logTruck := func(kind string) {
		a.history[id] = append([]historyRecord{{Kind: kind, By: model.FullName(user), At: time.Now()}}, a.history[id]...)
	}

	var message string
	switch body.Action {
	case "dispatch":
		if ok, err := enforce("Dispatch "+truck.Name, "operate", id); !ok {
			return r.refuse(err)
		}
		lane := body.Lane
		if lane == "" {
			lane = "Local run"
		}
		logTruck("Dispatched on " + lane)
		message = fmt.Sprintf("Dispatched %s on %s.", truck.Name, lane)

	case "service_basic", "service_advanced":
		label, kind := "Log basic service", "Basic service"
		if body.Action == "service_advanced" {
			label, kind = "Run advanced service", "Advanced service"
		}
		if ok, err := enforce(label, body.Action, id); !ok {
			return r.refuse(err)
		}
		logTruck(kind)
		message = fmt.Sprintf("%s logged on %s.", kind, truck.Name)

	case "decommission", "reactivate":
		label, state := "Decommission", "decommissioned"
		if body.Action == "reactivate" {
			label, state = "Reactivate", "active"
		}
		if ok, err := enforce(label, "decommission", id); !ok {
			return r.refuse(err)
		}
		attrs := maps.Clone(truck.Attributes)
		attrs["lifecycle_state"] = state
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.ResourceInstances.Update(ctx, id, models.ResourceInstanceUpdate{Attributes: attrs})
			return err
		}); err != nil {
			return nil, err
		}
		truck.Attributes = attrs
		r.untilData(fmt.Sprintf("%s's lifecycle_state %s", truck.Name, state), "resource_instances/"+id, func(d any) bool {
			return field(field(d, "attributes"), "lifecycle_state") == state
		})
		message = fmt.Sprintf("%s is %s: its lifecycle_state attribute in Permit changed.", truck.Name, state)

	case "move":
		// Scenario 4: re-parenting. Moving a truck takes admin rights on both sites.
		target, ok := a.instances["site:"+body.Site]
		if !ok || target.Tenant != truck.Tenant || target.ID() == truck.Parent {
			return fail("Pick another site in the same organization.")
		}
		if ok, err := enforce(fmt.Sprintf("Move %s out of %s (site admin)", truck.Name, site.Name), "assign_roles", site.ID()); !ok {
			return r.refuse(err)
		}
		if ok, err := enforce(fmt.Sprintf("Move %s into %s (site admin)", truck.Name, target.Name), "assign_roles", target.ID()); !ok {
			return r.refuse(err)
		}
		old := site
		if err := permitapi.Call(func(ctx context.Context) error {
			return a.api.RelationshipTuples.Delete(ctx, *models.NewRelationshipTupleDelete(old.ID(), "parent", id))
		}); err != nil {
			return nil, err
		}
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.RelationshipTuples.Create(ctx, models.RelationshipTupleCreate{Subject: target.ID(), Relation: "parent", Object: id, Tenant: ptr(truck.Tenant)})
			return err
		}); err != nil {
			return nil, err
		}
		truck.Parent = target.ID()
		r.untilData(fmt.Sprintf("%s's parent link to %s", truck.Name, target.Name), "relationships/"+id, func(d any) bool {
			sites, _ := field(field(d, "relation:parent"), "site").([]any)
			return len(sites) == 1 && sites[0] == target.Key
		})
		// Who loses and who gains the truck, decided by the PDP: someone with a role on each site.
		for _, s := range []*model.Instance{old, target} {
			if ra, ok := a.someoneOn(s.ID(), user); ok {
				question := fmt.Sprintf("After the move: can %s (%s at %s) view %s?", model.FullName(ra.User), strings.ReplaceAll(ra.Role, "_", " "), s.Name, truck.Name)
				if _, err := r.checkOne(question, ra.User, "view", id, truck.Tenant); err != nil {
					return nil, err
				}
			}
		}
		message = fmt.Sprintf("Moved %s to %s: one parent link replaced, no role assignment changed. Access derived from %s is gone; access derived from %s applies.", truck.Name, target.Name, old.Name, target.Name)

	case "grant", "revoke":
		// Scenario 6: a partner technician on this truck only.
		partner, isUser := model.UserOf(body.Partner)
		if !isUser || !model.PartnerOrgs[partner.HomeTenant] {
			return fail("Pick a partner technician.")
		}
		grant := body.Action == "grant"
		label := "Revoke partner access"
		if grant {
			label = "Grant partner access"
		}
		if ok, err := enforce(label+" (site admin)", "assign_roles", site.ID()); !ok {
			return r.refuse(err)
		}
		ra := model.RoleAssignment{User: partner.Key, Role: "partner_technician", ResourceInstance: id, Tenant: truck.Tenant}
		if err := a.writeAssignment(ra, grant); err != nil {
			return nil, err
		}
		verb := "loses"
		if grant {
			verb = "gains"
		}
		name := model.FullName(partner.Key)
		if err := r.untilDecision(fmt.Sprintf("%s %s access to %s", name, verb, truck.Name), partner.Key, "view", id, truck.Tenant, grant); err != nil {
			return nil, err
		}
		message = fmt.Sprintf("%s no longer has access to %s.", name, truck.Name)
		if grant {
			message = fmt.Sprintf("%s can now service %s, and only this truck, acting for %s.", name, truck.Name, model.OrgName(truck.Tenant))
		}

	case "edit_details":
		// Scenario 11: change the attributes the resource sets read. Takes admin rights on the site.
		region, account := body.Region, body.Account
		if !slices.Contains([]string{"South", "West", "East"}, region) || !slices.Contains([]string{"Acct1", "Acct2"}, account) {
			return fail("Pick a region and a served account.")
		}
		if ok, err := enforce(fmt.Sprintf("Edit the details of %s (site admin)", truck.Name), "assign_roles", site.ID()); !ok {
			return r.refuse(err)
		}
		before := truck.Attributes
		attrs := maps.Clone(truck.Attributes)
		attrs["region"], attrs["served_account"] = region, account
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.ResourceInstances.Update(ctx, id, models.ResourceInstanceUpdate{Attributes: attrs})
			return err
		}); err != nil {
			return nil, err
		}
		truck.Attributes = attrs
		r.untilData(fmt.Sprintf("%s's region %s and served account %s", truck.Name, region, account), "resource_instances/"+id, func(d any) bool {
			stored := field(d, "attributes")
			return field(stored, "region") == region && field(stored, "served_account") == account
		})
		// What the change does to the attribute-based rules, decided by the PDP.
		if before["served_account"] != account {
			for _, u := range a.withTenantRole("viewer", truck.Tenant) {
				if _, err := r.checkOne(fmt.Sprintf("Can %s see %s now?", model.FullName(u), truck.Name), u, "view", id, truck.Tenant); err != nil {
					return nil, err
				}
			}
		}
		if before["region"] != region {
			for _, u := range a.withTenantRole("operator", truck.Tenant) {
				if _, err := r.checkOne(fmt.Sprintf("Can %s operate %s now?", model.FullName(u), truck.Name), u, "operate", id, truck.Tenant); err != nil {
					return nil, err
				}
			}
		}
		message = fmt.Sprintf("%s now has region %s and serves %s. Access through the attribute-based sets follows the new values.", truck.Name, region, account)

	case "transfer":
		// Scenarios 6 and 13: move the truck to another organization. Platform staff only.
		target, ok := a.instances["site:"+body.Site]
		if !ok || target.Tenant == truck.Tenant || !a.tenants[target.Tenant] {
			return fail("Pick a site in another organization.")
		}
		from, to := truck.Tenant, target.Tenant
		if ok, err := r.platform(fmt.Sprintf("Transfer %s to %s: platform staff only, enforce before writing", truck.Name, model.OrgName(to)), user); !ok {
			return r.refuse(err)
		}
		var grantees []string // people with a grant on this truck in the old organization
		for _, ra := range a.assignments {
			if ra.ResourceInstance == id && !slices.Contains(grantees, ra.User) {
				grantees = append(grantees, ra.User)
			}
		}
		// An instance can't change organization: delete it (its links and grants go with it) and create it
		// again in the new one.
		if err := permitapi.Call(func(ctx context.Context) error { return a.api.ResourceInstances.Delete(ctx, id) }, 404); err != nil {
			return nil, err
		}
		// When the PDP still has it, a late deletion may strip the new link; holdLinks below repairs that.
		if err := a.pdp.WaitGone([]string{id}, 15*time.Second); err != nil {
			log.Printf("transfer: creating %s again before the PDP dropped it: %v", id, err)
		}
		attrs := maps.Clone(truck.Attributes)
		attrs["owner_org"], attrs["operator_org"], attrs["lifecycle_state"] = to, to, "active"
		if err := permitapi.CreateAgain(func(ctx context.Context) error {
			_, err := a.api.ResourceInstances.Create(ctx, models.ResourceInstanceCreate{Key: truck.Key, Resource: "asset", Tenant: ptr(to), Attributes: attrs})
			return err
		}); err != nil {
			return nil, err
		}
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.RelationshipTuples.Create(ctx, models.RelationshipTupleCreate{Subject: target.ID(), Relation: "parent", Object: id, Tenant: ptr(to)})
			return err
		}); err != nil {
			return nil, err
		}
		truck.Tenant, truck.Parent, truck.Attributes = to, target.ID(), attrs
		a.assignments = slices.DeleteFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.ResourceInstance == id })
		r.untilData(fmt.Sprintf("%s in %s", truck.Name, model.OrgName(to)), "resource_instances/"+id, func(d any) bool { return field(d, "tenant") == to })
		r.holdLinks(map[string]string{id: target.ID()}, 5*time.Second, 30*time.Second)
		// The old organization's grants did not follow the truck: decided by the PDP, acting for each side.
		for _, u := range grantees {
			for _, o := range []string{from, to} {
				question := fmt.Sprintf("After the transfer: can %s still view %s, acting for %s?", model.FullName(u), truck.Name, model.OrgName(o))
				if _, err := r.checkOne(question, u, "view", id, o); err != nil {
					return nil, err
				}
			}
		}
		names := make([]string, len(grantees))
		for n, u := range grantees {
			names[n] = model.FullName(u)
		}
		removed := "none"
		if len(names) > 0 {
			removed = strings.Join(names, ", ")
		}
		message = fmt.Sprintf("Transferred %s to %s, %s. Grants from %s were removed with it (%s); nothing followed the truck.", truck.Name, model.OrgName(to), target.Name, model.OrgName(from), removed)
		a.record(user, message)
		return r.done(message, obj{"redirect": "#/"}), nil

	default:
		return fail("Unknown action.")
	}
	a.record(user, message)
	return r.done(message, nil), nil
}

// someoneOn is a person with a role on the instance, other than except; the site manager if there is one.
func (a *App) someoneOn(id, except string) (model.RoleAssignment, bool) {
	var found model.RoleAssignment
	for _, ra := range a.assignments {
		if ra.ResourceInstance != id || ra.User == except {
			continue
		}
		if ra.Role == "site_manager" {
			return ra, true
		}
		if found.User == "" {
			found = ra
		}
	}
	return found, found.User != ""
}

// withTenantRole lists the people holding an org-level role in an organization.
func (a *App) withTenantRole(role, tenant string) []string {
	var users []string
	for _, ra := range a.assignments {
		if ra.ResourceInstance == "" && ra.Role == role && ra.Tenant == tenant {
			users = append(users, ra.User)
		}
	}
	return users
}

// writeAssignment assigns or unassigns a resource role through the SDK and keeps the app's copy in step.
func (a *App) writeAssignment(ra model.RoleAssignment, assign bool) error {
	if assign {
		if err := permitapi.Call(func(ctx context.Context) error {
			_, err := a.api.Users.AssignResourceRole(ctx, ra.User, ra.Role, ra.Tenant, ra.ResourceInstance)
			return err
		}, 409); err != nil {
			return err
		}
		a.assignments = append(a.assignments, ra)
		return nil
	}
	if err := permitapi.Call(func(ctx context.Context) error {
		_, err := a.api.Users.UnassignResourceRole(ctx, ra.User, ra.Role, ra.Tenant, ra.ResourceInstance)
		return err
	}, 404); err != nil {
		return err
	}
	a.assignments = slices.DeleteFunc(a.assignments, func(x model.RoleAssignment) bool {
		return x.User == ra.User && x.Role == ra.Role && x.ResourceInstance == ra.ResourceInstance
	})
	return nil
}

// field reads a key from decoded JSON, nil when absent.
func field(data any, key string) any {
	m, _ := data.(map[string]any)
	return m[key]
}

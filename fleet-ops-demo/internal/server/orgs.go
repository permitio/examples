package server

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"time"

	"github.com/permitio/permit-golang/pkg/models"

	"fleetops/internal/model"
	"fleetops/internal/permitapi"
)

// orgsPage is the platform operator's console: the customer organizations, which platform staff may delete
// (scenario 15) or merge into another as a sub-organization (scenario 16).
func (a *App) orgsPage(user string) (obj, error) {
	r := a.newRequest()
	allowed, err := r.platform(fmt.Sprintf("Organizations: is %s platform staff?", model.UserName(user)), user)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return obj{"denied": true, "reason": r.last().Reason, "log": r.log}, nil
	}
	rows, targets := []obj{}, []named{}
	for _, t := range model.Tenants {
		if !a.tenants[t.Key] || t.Platform {
			continue
		}
		counts := a.counts(t.Key)
		rows = append(rows, obj{
			"key": t.Key, "name": t.Name, "description": t.Description, "partner": t.Partner,
			"trucks": counts["trucks"], "resources": counts["resources"], "assignments": counts["assignments"],
		})
		if !t.Partner {
			targets = append(targets, named{Key: t.Key, Name: t.Name})
		}
	}
	return obj{"orgs": rows, "mergeTargets": targets, "log": r.log}, nil
}

// counts tallies what an organization holds in Permit, from the app's copy.
func (a *App) counts(tenant string) map[string]int {
	c := map[string]int{}
	for _, i := range a.instances {
		if i.Tenant == tenant {
			c["resources"]++
			if i.Type == "asset" {
				c["trucks"]++
			}
		}
	}
	for _, ra := range a.assignments {
		if ra.Tenant == tenant {
			c["assignments"]++
		}
	}
	return c
}

// orgAction deletes an organization (scenario 15) or merges it into another as a sub-organization,
// keeping its role assignments (scenario 16). Platform staff only.
func (a *App) orgAction(body actBody, key string) (obj, error) {
	r := a.newRequest()
	user := body.User
	fail := func(message string) (obj, error) { return obj{"error": message, "log": r.log}, nil }
	t, ok := model.TenantOf(key)
	if !ok || !a.tenants[key] || t.Platform {
		return fail("There is no such customer organization.")
	}
	// Someone with a role there (not platform staff), and one of its trucks, to show what changes.
	var probeUser string
	for _, ra := range a.assignments {
		if ra.Tenant == key && !a.platformStaff(ra.User) {
			probeUser = ra.User
			if ra.Role == "org_admin" {
				break
			}
		}
	}
	var probe *model.Instance
	for _, truck := range a.fleetOf(key) {
		if truck.Tenant == key {
			probe = truck
			break
		}
	}

	switch body.Action {
	case "delete":
		if ok, err := r.platform(fmt.Sprintf("Delete %s: platform staff only, enforce before writing", t.Name), user); !ok {
			return r.refuse(err)
		}
		if probeUser != "" && probe != nil {
			if _, err := r.checkOne(fmt.Sprintf("Before: can %s view %s?", model.FullName(probeUser), probe.Name), probeUser, "view", probe.ID(), key); err != nil {
				return nil, err
			}
		}
		before := a.counts(key)
		if err := permitapi.Call(func(ctx context.Context) error { return a.api.Tenants.Delete(ctx, key) }, 404); err != nil {
			return nil, err
		}
		a.forget(key)
		if probeUser != "" && probe != nil {
			if err := r.untilDecision(fmt.Sprintf("After: can %s view %s?", model.FullName(probeUser), probe.Name), probeUser, "view", probe.ID(), key, false); err != nil {
				return nil, err
			}
		}
		instances, tuples, assignments, err := a.leftIn(key)
		if err != nil {
			return nil, err
		}
		message := fmt.Sprintf("Deleted %s with its %d resources and %d role assignments. Left behind in Permit: %d resource instances, %d relationships, %d role assignments.",
			t.Name, before["resources"], before["assignments"], instances, tuples, assignments)
		a.record(user, "Deleted "+t.Name)
		return obj{"ok": true, "message": message, "redirect": "#/organizations", "log": r.log}, nil

	case "merge":
		target, ok := model.TenantOf(body.Target)
		if !ok || !a.tenants[target.Key] || target.Key == key || target.Partner || target.Platform {
			return fail("Pick a customer organization to merge into.")
		}
		if ok, err := r.platform(fmt.Sprintf("Merge %s into %s: platform staff only, enforce before writing", t.Name, target.Name), user); !ok {
			return r.refuse(err)
		}
		if probeUser != "" && probe != nil {
			if _, err := r.checkOne(fmt.Sprintf("Before: can %s view %s, acting for %s?", model.FullName(probeUser), probe.Name, target.Name), probeUser, "view", probe.ID(), target.Key); err != nil {
				return nil, err
			}
		}
		if err := a.merge(key, target.Key); err != nil {
			return nil, err
		}
		if probeUser != "" && probe != nil {
			if err := r.untilDecision(fmt.Sprintf("After: can %s view %s, acting for %s?", model.FullName(probeUser), probe.Name, target.Name), probeUser, "view", probe.ID(), target.Key, true); err != nil {
				return nil, err
			}
			// The target's own org admin reaches the merged tree through the new sub-organization link.
			for _, ra := range a.assignments {
				if ra.Tenant == target.Key && ra.Role == "org_admin" && ra.ResourceInstance == "org:"+target.Key && !a.platformStaff(ra.User) {
					question := fmt.Sprintf("Can %s, org admin of %s, view %s now?", model.FullName(ra.User), target.Name, probe.Name)
					if _, err := r.checkOne(question, ra.User, "view", probe.ID(), target.Key); err != nil {
						return nil, err
					}
					break
				}
			}
		}
		message := fmt.Sprintf("Merged %s into %s as a sub-organization: its tree now hangs under %s, and its people keep their roles there.", t.Name, target.Name, target.Name)
		a.record(user, fmt.Sprintf("Merged %s into %s", t.Name, target.Name))
		return obj{"ok": true, "message": message, "redirect": "#/organizations", "log": r.log}, nil
	}
	return fail("Unknown action.")
}

// forget drops a deleted organization from the app's copy of Permit.
func (a *App) forget(tenant string) {
	delete(a.tenants, tenant)
	for id, i := range a.instances {
		if i.Tenant == tenant {
			delete(a.instances, id)
			delete(a.members, id)
		}
	}
	a.assignments = slices.DeleteFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.Tenant == tenant })
}

// leftIn counts what Permit still holds for a deleted organization.
func (a *App) leftIn(tenant string) (instances, tuples, assignments int, err error) {
	rows, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.ResourceInstanceRead, error) {
		return permitapi.Deref(a.api.ResourceInstances.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return
	}
	for _, i := range rows {
		if i.Tenant != nil && *i.Tenant == tenant {
			instances++
		}
	}
	links, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RelationshipTupleRead, error) {
		return permitapi.Deref(a.api.RelationshipTuples.List(ctx, page, perPage, "", "", "", ""))
	})
	if err != nil {
		return
	}
	for _, t := range links {
		if t.Tenant == tenant {
			tuples++
		}
	}
	roles, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RoleAssignmentRead, error) {
		return permitapi.Deref(a.api.RoleAssignments.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return
	}
	for _, ra := range roles {
		if ra.Tenant == tenant {
			assignments++
		}
	}
	return
}

// merge moves an organization's tree into another organization, under a sub-organization link, and
// gives its people the same roles there. Instances can't change tenant, so the old organization is
// deleted (taking its data with it) and everything is created again in the target.
func (a *App) merge(from, to string) error {
	var moving []*model.Instance
	for _, i := range a.instances {
		if i.Tenant == from {
			moving = append(moving, i)
		}
	}
	tuples, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RelationshipTupleRead, error) {
		return permitapi.Deref(a.api.RelationshipTuples.List(ctx, page, perPage, from, "", "", ""))
	})
	if err != nil {
		return err
	}
	var roles []model.RoleAssignment
	for _, ra := range a.assignments {
		if ra.Tenant == from && !a.platformStaff(ra.User) {
			roles = append(roles, ra)
		}
	}

	ids := make([]string, len(moving))
	for n, i := range moving {
		ids[n] = i.ID()
	}
	// Remove the organization's links first, and wait until the PDP has dropped them. Deleting the
	// organization would remove them as well, but that cascade reaches the PDP late, after the new
	// links with the same instance keys, and would remove those too.
	if len(tuples) > 0 {
		del := make([]models.RelationshipTupleDelete, len(tuples))
		for n, t := range tuples {
			del[n] = *models.NewRelationshipTupleDelete(t.Subject, t.Relation, t.Object)
		}
		if err := permitapi.Call(func(ctx context.Context) error {
			return a.api.RelationshipTuples.BulkDelete(ctx, *models.NewRelationshipTupleDeleteBulkOperation(del))
		}); err != nil {
			return err
		}
		a.pdp.WaitUnlinked(ids, 20*time.Second)
	}
	if err := permitapi.Call(func(ctx context.Context) error { return a.api.Tenants.Delete(ctx, from) }, 404); err != nil {
		return err
	}
	a.pdp.WaitGone(ids, 20*time.Second)
	for _, i := range moving {
		attrs := maps.Clone(i.Attributes)
		if i.Type == "asset" {
			attrs["owner_org"], attrs["operator_org"] = to, to
		}
		body := models.ResourceInstanceCreate{Key: i.Key, Resource: i.Type, Tenant: ptr(to), Attributes: attrs}
		if err := permitapi.CreateAgain(func(ctx context.Context) error { _, err := a.api.ResourceInstances.Create(ctx, body); return err }); err != nil {
			return fmt.Errorf("creating %s in %s: %w", i.ID(), to, err)
		}
		i.Tenant, i.Attributes = to, attrs
	}
	links := []models.RelationshipTupleCreate{{Subject: "org:" + to, Relation: "parent", Object: "org:" + from, Tenant: ptr(to)}}
	for _, t := range tuples {
		links = append(links, models.RelationshipTupleCreate{Subject: t.Subject, Relation: t.Relation, Object: t.Object, Tenant: ptr(to)})
	}
	if err := permitapi.Call(func(ctx context.Context) error {
		return a.api.RelationshipTuples.BulkCreate(ctx, *models.NewRelationshipTupleCreateBulkOperation(links))
	}); err != nil {
		return err
	}
	a.get("org:" + from).Parent = "org:" + to
	// Trucks the merged organization operated for another one are now operated by the target.
	for _, i := range a.instances {
		if i.Type == "asset" && str(i.Attributes["operator_org"]) == from {
			attrs := maps.Clone(i.Attributes)
			attrs["operator_org"] = to
			if err := permitapi.Call(func(ctx context.Context) error {
				_, err := a.api.ResourceInstances.Update(ctx, i.ID(), models.ResourceInstanceUpdate{Attributes: attrs})
				return err
			}); err != nil {
				return err
			}
			i.Attributes = attrs
		}
	}
	if len(roles) > 0 {
		assign := make([]models.RoleAssignmentCreate, len(roles))
		for n, ra := range roles {
			assign[n] = *models.NewRoleAssignmentCreate(ra.Role, to, ra.User)
			if ra.ResourceInstance != "" {
				assign[n].ResourceInstance = ptr(ra.ResourceInstance)
			}
		}
		if err := permitapi.Call(func(ctx context.Context) error { _, err := a.api.Roles.BulkAssignRole(ctx, assign); return err }); err != nil {
			return err
		}
	}
	delete(a.tenants, from)
	a.assignments = slices.DeleteFunc(a.assignments, func(ra model.RoleAssignment) bool { return ra.Tenant == from })
	for _, ra := range roles {
		ra.Tenant = to
		a.assignments = append(a.assignments, ra)
	}
	// Wait until the PDP has the tree in its new organization, every parent link included, and keeps it.
	parents := map[string]string{}
	for _, i := range moving {
		if i.Parent != "" {
			parents[i.ID()] = i.Parent
		}
	}
	a.pdp.Settle(parents)
	a.pdp.Keep(parents, 8*time.Second, time.Minute)
	return nil
}

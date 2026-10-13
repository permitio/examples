// Command sync writes the Fleet Ops schema and seed data to Permit through the Go SDK.
//
//	make setup   make the schema match internal/schema exactly, then restore the seed data
//	make reset   data only: remove what the app added and restore the seed
//
// The schema converges both ways: what is missing is created, what differs is updated, and what
// internal/schema doesn't have is removed (resource types, actions, attributes, relations, roles,
// derivations, org-level roles, condition sets and their rules), dashboard changes included. Schema
// writes regenerate the GitOps policy branch; a reset never touches the schema.
//
// After a setup the command waits until the local PDP has the schema, then rebuilds the PDP's
// relationship cache: on pdp-v2 0.9.16 a schema change leaves that cache (used by /user-permissions
// and AuthZEN search) missing relationships until it is rebuilt.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/permitio/permit-golang/pkg/api"
	"github.com/permitio/permit-golang/pkg/models"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
	"fleetops/internal/permitapi"
	"fleetops/internal/schema"
	"fleetops/internal/settings"
)

func main() {
	reset := flag.Bool("reset", false, "data only: remove what the app added and restore the seed")
	flag.Parse()

	s := settings.MustLoad()
	client := settings.Client(s)
	api := rest{url: s.APIURL, key: s.APIKey}
	suffix := ""
	if *reset {
		suffix = " (reset)"
	}
	// Both commands delete what the seed doesn't have: name the environment first, and stop if .env
	// names another one.
	scope, err := scopeOf(api)
	if err != nil {
		fail(err)
	}
	fmt.Printf("Permit project=%s env=%s (%s)%s\n", scope.ProjectKey, scope.EnvKey, scope.EnvName, suffix)
	if err := scope.check(s.Project, s.Env); err != nil {
		fail(err)
	}
	if !*reset {
		if err := syncSchema(client.Api, api, scope); err != nil {
			fail(err)
		}
	}
	p := pdp.New(s, client)
	pdpUp := p.Status().PDP
	// A late deletion of what these waits watch can strip links created again with the same keys;
	// ensureLinks below checks and repairs the links, so a failed wait only warns.
	waitGone := func(ids []string) {
		if !pdpUp {
			return
		}
		if err := p.WaitGone(ids, 30*time.Second); err != nil {
			logf("couldn't confirm the PDP dropped the deleted instances (%v); continuing", err)
		}
	}
	waitUnlinked := func(ids []string) {
		if !pdpUp {
			return
		}
		if err := p.WaitUnlinked(ids, 30*time.Second); err != nil {
			logf("couldn't confirm the PDP dropped the deleted links (%v); continuing", err)
		}
	}
	var returned []string
	churn, err := syncFacts(client.Api, &returned, waitGone, waitUnlinked)
	if err != nil {
		fail(err)
	}
	if len(returned) > 0 && pdpUp {
		// Instances deleted and created again: make sure the PDP didn't lose their new parent links.
		links := map[string]string{}
		for _, id := range returned {
			for _, t := range model.Tuples {
				if t.Object == id && t.Relation == "parent" {
					links[id] = t.Subject
				}
			}
		}
		if err := p.Settle(links); err != nil {
			logf("couldn't confirm the PDP has the returned instances' parent links (%v); restart it with `make pdp` and run `make verify`", err)
		} else {
			logf("PDP has the returned instances' parent links")
		}
	}
	if pdpUp {
		ensureLinks(p, churn)
	}
	if !*reset || len(returned) > 0 {
		rebuildRelationshipCache(p)
	}
	fmt.Println("Done. The PDP receives data changes within a few seconds; restart the app to reload its data.")
}

// ensureLinks confirms the PDP has every seeded parent link, and keeps them. When instances or
// organizations were deleted and created again with the same keys (transfer, merge, delete, then a
// reset), the deletions of the old links can reach the PDP after the new links and remove them, and
// for a while the data Permit serves on a refetch can lack them too. So after any deletion the links
// must stay complete for 45 s in a row; whenever some are missing the PDP refetches its data. After
// five minutes it restarts the PDP as a last resort.
func ensureLinks(p *pdp.Client, churn bool) {
	links := map[string]string{}
	for _, t := range model.Tuples {
		if t.Relation == "parent" {
			links[t.Object] = t.Subject
		}
	}
	stable := 5 * time.Second
	if churn {
		stable = 45 * time.Second
	}
	unreadable := func(err error) {
		logf("couldn't read the PDP's data (%v); run `make verify` once it is reachable", err)
	}
	missing, err := p.Missing(links)
	if err != nil {
		unreadable(err)
		return
	}
	if len(missing) > 0 {
		logf("the PDP is missing %d parent links (%s); waiting for them, refetching its data if needed", len(missing), strings.Join(missing, ", "))
	}
	refetches, err := p.Keep(links, stable, 5*time.Minute)
	if err == nil {
		note := ""
		if refetches > 0 {
			note = fmt.Sprintf(" after %d data refetches", refetches)
		}
		logf("PDP has all %d parent links%s", len(links), note)
		return
	}
	var behind *pdp.NotCaughtUpError
	if !errors.As(err, &behind) {
		unreadable(err)
		return
	}
	logf("the links still come and go after five minutes; restarting the PDP")
	if err := p.Restart(); err != nil {
		logf("%v", err)
		return
	}
	if _, err := p.Keep(links, 10*time.Second, time.Minute); err != nil {
		logf("%v; run `make pdp`, then `make verify`", err)
		return
	}
	logf("PDP restarted; it has all %d parent links", len(links))
}

// rebuildRelationshipCache waits until the local PDP has loaded the schema, then rebuilds its
// relationship cache. Skipped when the PDP isn't running.
func rebuildRelationshipCache(p *pdp.Client) {
	if !p.Status().PDP {
		logf("local PDP not running: start it, then run `make setup` again to rebuild its relationship cache")
		return
	}
	deadline := time.Now().Add(90 * time.Second)
	for {
		loaded, err := pdpHasSchema(p)
		if err != nil {
			logf("couldn't read the PDP's data (%v); run `make setup` again once it is reachable", err)
			return
		}
		if loaded {
			break
		}
		if time.Now().After(deadline) {
			logf("the PDP has not loaded the whole schema after 90 s; run `make setup` again later")
			return
		}
		time.Sleep(2 * time.Second)
	}
	if err := p.RebuildRelationshipCache(); err != nil {
		logf("rebuilding the PDP's relationship cache failed: %v", err)
		return
	}
	logf("PDP has the schema; relationship cache rebuilt")
}

// pdpHasSchema reports whether the PDP's loaded data has every resource action, role permission and
// role derivation in the schema.
func pdpHasSchema(p *pdp.Client) (bool, error) {
	typesData, err := p.OPAData("resource_types")
	if err != nil {
		return false, err
	}
	permsData, err := p.OPAData("role_permissions")
	if err != nil {
		return false, err
	}
	types, _ := typesData.(map[string]any)
	perms, _ := permsData.(map[string]any)
	for _, r := range schema.Resources {
		rt, _ := types[r.Key].(map[string]any)
		actions, _ := rt["actions"].([]any)
		for _, a := range r.Actions {
			if !slices.Contains(actions, any(a)) {
				return false, nil
			}
		}
		derived, _ := rt["derived_roles"].(map[string]any)
		rolePerms, _ := perms[r.Key].(map[string]any)
		for _, role := range r.Roles {
			if len(role.DerivedFrom) > 0 {
				d, _ := derived[role.Key].(map[string]any)
				if rules, _ := d["rules"].([]any); len(rules) < len(role.DerivedFrom) {
					return false, nil
				}
			}
			rp, _ := rolePerms[role.Key].(map[string]any)
			grants, _ := rp["grants"].(map[string]any)
			have, _ := grants[r.Key].([]any)
			for _, perm := range role.Permissions {
				if !slices.Contains(have, any(perm)) {
					return false, nil
				}
			}
		}
	}
	return true, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "sync failed:", err)
	os.Exit(1)
}

func logf(format string, args ...any) { fmt.Printf("• "+format+"\n", args...) }

// title turns an action key into its display name: "service_basic" -> "Service basic".
func title(key string) string {
	s := strings.ToLower(strings.ReplaceAll(key, "_", " "))
	return strings.ToUpper(s[:1]) + s[1:]
}

func ptr[T any](v T) *T { return &v }

// call runs one API call (with the timeout and retries); statuses in allow count as success.
func call(fn func(ctx context.Context) error, allow ...int) error {
	return permitapi.Call(fn, allow...)
}

// syncSchema makes the schema in Permit match package schema: first it removes what the schema
// doesn't have (rules and sets before the roles and types they name), then creates and updates the rest.
func syncSchema(a *api.PermitApiClient, raw rest, scope keyScope) error {
	// User attributes, created once: Permit answers 500 to a PATCH of an existing one. Permit's own
	// (key, email, roles) are listed among them, so nothing here is removed.
	for _, attr := range schema.UserAttributes {
		body := models.ResourceAttributeCreate{Key: attr.Key, Type: models.AttributeType(attr.Type), Description: ptr(attr.Description)}
		if err := call(func(ctx context.Context) error {
			_, err := a.ResourceAttributes.Create(ctx, "__user", body)
			return err
		}, 409); err != nil {
			return err
		}
	}
	if err := pruneSchema(a, raw, scope); err != nil {
		return err
	}

	for _, r := range schema.Resources {
		actions := map[string]models.ActionBlockEditable{}
		for _, key := range r.Actions {
			actions[key] = models.ActionBlockEditable{Name: ptr(title(key))}
		}
		create := func(ctx context.Context) error {
			_, err := a.Resources.Create(ctx, *models.NewResourceCreate(r.Key, r.Name, actions))
			return err
		}
		update := func(ctx context.Context) error {
			_, err := a.Resources.Update(ctx, r.Key, models.ResourceUpdate{Name: ptr(r.Name), Actions: &actions})
			return err
		}
		if _, err := permitapi.Ensure(create, update); err != nil {
			return fmt.Errorf("resource %s: %w", r.Key, err)
		}
		for _, attr := range r.Attributes {
			body := models.ResourceAttributeCreate{Key: attr.Key, Type: models.AttributeType(attr.Type), Description: ptr(attr.Description)}
			if err := call(func(ctx context.Context) error { _, err := a.ResourceAttributes.Create(ctx, r.Key, body); return err }, 409); err != nil {
				return err
			}
		}
	}
	// Relations after every resource type exists, since a relation names its parent type.
	var keys []string
	for _, r := range schema.Resources {
		keys = append(keys, r.Key)
		for _, rel := range r.Relations {
			body := *models.NewRelationCreate(rel.Key, title(rel.Key), rel.Subject)
			if err := call(func(ctx context.Context) error { _, err := a.ResourceRelations.Create(ctx, r.Key, body); return err }, 409); err != nil {
				return err
			}
		}
	}
	logf("resources: %s", strings.Join(keys, ", "))

	// Roles with exactly their permissions, then derivations, so every role a derivation names exists.
	for _, r := range schema.Resources {
		for _, role := range r.Roles {
			create := func(ctx context.Context) error {
				_, err := a.ResourceRoles.Create(ctx, r.Key, models.ResourceRoleCreate{Key: role.Key, Name: role.Name, Permissions: role.Permissions})
				return err
			}
			update := func(ctx context.Context) error {
				_, err := a.ResourceRoles.Update(ctx, r.Key, role.Key, models.ResourceRoleUpdate{Name: ptr(role.Name), Permissions: role.Permissions})
				return err
			}
			if _, err := permitapi.Ensure(create, update); err != nil {
				return fmt.Errorf("role %s#%s: %w", r.Key, role.Key, err)
			}
		}
	}
	derivations := 0
	for _, r := range schema.Resources {
		for _, role := range r.Roles {
			for _, d := range role.DerivedFrom {
				body := *models.NewDerivedRoleRuleCreate(d.Role, d.OnResource, d.Relation)
				if err := call(func(ctx context.Context) error {
					_, err := a.ImplicitGrants.Create(ctx, r.Key, role.Key, body)
					return err
				}, 409); err != nil {
					return fmt.Errorf("derivation %s#%s from %s#%s: %w", r.Key, role.Key, d.OnResource, d.Role, err)
				}
				derivations++
			}
		}
	}
	logf("resource roles, with %d derivations", derivations)

	var tenantRoles []string
	for _, tr := range schema.TenantRoles {
		tenantRoles = append(tenantRoles, tr.Key)
		create := func(ctx context.Context) error {
			_, err := a.Roles.Create(ctx, models.RoleCreate{Key: tr.Key, Name: tr.Name, Description: ptr(tr.Description), Permissions: tr.Permissions})
			return err
		}
		update := func(ctx context.Context) error {
			_, err := a.Roles.Update(ctx, tr.Key, models.RoleUpdate{Name: ptr(tr.Name), Description: ptr(tr.Description), Permissions: tr.Permissions})
			return err
		}
		if _, err := permitapi.Ensure(create, update); err != nil {
			return fmt.Errorf("role %s: %w", tr.Key, err)
		}
	}
	logf("org-level (tenant) roles: %s", strings.Join(tenantRoles, ", "))

	var setKeys, rules []string
	for _, cs := range schema.ConditionSets {
		setKeys = append(setKeys, cs.Key)
		body := models.ConditionSetCreate{Key: cs.Key, Name: cs.Name, Type: ptr(models.ConditionSetType(cs.Type)), Conditions: cs.Conditions()}
		if cs.Resource != "" {
			body.ResourceId = &models.ResourceId{String: ptr(cs.Resource)}
		}
		update := func(ctx context.Context) error {
			_, err := a.ConditionSets.Update(ctx, cs.Key, models.ConditionSetUpdate{Name: ptr(cs.Name), Conditions: cs.Conditions()})
			return err
		}
		if _, err := permitapi.Ensure(func(ctx context.Context) error { _, err := a.ConditionSets.Create(ctx, body); return err }, update); err != nil {
			return fmt.Errorf("condition set %s: %w", cs.Key, err)
		}
	}
	for _, rule := range schema.ConditionSetRules {
		rules = append(rules, fmt.Sprintf("%s %s on %s", strings.TrimPrefix(rule.UserSet, "__autogen_"), rule.Permission, rule.ResourceSet))
		if err := call(func(ctx context.Context) error {
			_, err := a.ConditionSets.AssignSetPermissions(ctx, rule.UserSet, rule.Permission, rule.ResourceSet)
			return err
		}, 409); err != nil {
			return err
		}
	}
	logf("ABAC sets: %s; rules: %s", strings.Join(setKeys, ", "), strings.Join(rules, "; "))
	return nil
}

// pruneSchema removes what package schema doesn't have: attribute rules, condition sets and org-level
// roles first, then resource types, then the derivations, roles, actions, attributes and relations of
// the remaining types.
func pruneSchema(a *api.PermitApiClient, raw rest, scope keyScope) error {
	var removed []string

	have, err := listRaw[rule](raw, scope, "facts", "set_rules")
	if err != nil {
		return err
	}
	for _, r := range have {
		if slices.Contains(schema.ConditionSetRules, schema.ConditionSetRule{UserSet: r.UserSet, Permission: r.Permission, ResourceSet: r.ResourceSet}) {
			continue
		}
		if err := call(func(ctx context.Context) error {
			return a.ConditionSets.UnassignSetPermissions(ctx, r.UserSet, r.Permission, r.ResourceSet)
		}, 404); err != nil {
			return err
		}
		removed = append(removed, fmt.Sprintf("rule %s %s on %s", r.UserSet, r.Permission, r.ResourceSet))
	}

	sets, err := listRaw[conditionSet](raw, scope, "schema", "condition_sets")
	if err != nil {
		return err
	}
	for _, cs := range sets {
		if schema.IsRoleSet(cs.Key) || cs.Autogenerated {
			continue
		}
		if _, ok := schema.ConditionSetByKey(cs.Key); ok {
			continue
		}
		if err := call(func(ctx context.Context) error { return a.ConditionSets.Delete(ctx, cs.Key) }, 404); err != nil {
			return err
		}
		removed = append(removed, "condition set "+cs.Key)
	}

	roles, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RoleRead, error) {
		return a.Roles.List(ctx, page, perPage)
	})
	if err != nil {
		return err
	}
	for _, role := range roles {
		if slices.ContainsFunc(schema.TenantRoles, func(tr schema.TenantRole) bool { return tr.Key == role.Key }) {
			continue
		}
		if err := call(func(ctx context.Context) error { return a.Roles.Delete(ctx, role.Key) }, 404); err != nil {
			return err
		}
		removed = append(removed, "org-level role "+role.Key)
	}

	resources, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.ResourceRead, error) {
		return a.Resources.List(ctx, page, perPage)
	})
	if err != nil {
		return err
	}
	for _, res := range resources {
		if _, ok := schema.ResourceByKey(res.Key); ok || strings.HasPrefix(res.Key, "__") {
			continue
		}
		if err := call(func(ctx context.Context) error { return a.Resources.Delete(ctx, res.Key) }, 404); err != nil {
			return err
		}
		removed = append(removed, "resource type "+res.Key)
	}

	for _, res := range resources {
		want, ok := schema.ResourceByKey(res.Key)
		if !ok {
			continue
		}
		current, err := permitapi.Deref(func() (*[]models.ResourceRoleRead, error) {
			var out *[]models.ResourceRoleRead
			err := call(func(ctx context.Context) error {
				var err error
				out, err = a.ResourceRoles.List(ctx, 1, 100, res.Key)
				return err
			})
			return out, err
		}())
		if err != nil {
			return err
		}
		// Derivations the schema doesn't have, on the roles that stay; then the roles that go.
		for _, role := range current {
			wantRole := slices.IndexFunc(want.Roles, func(x schema.Role) bool { return x.Key == role.Key })
			if wantRole < 0 || role.GrantedTo == nil {
				continue
			}
			for _, rule := range role.GrantedTo.UsersWithRole {
				d := schema.Derivation{Role: rule.Role, OnResource: rule.OnResource, Relation: rule.LinkedByRelation}
				if slices.Contains(want.Roles[wantRole].DerivedFrom, d) {
					continue
				}
				// The SDK's Delete names its arguments (roleId, resourceId) but builds the URL from them as
				// (resource, role), the same order as Create.
				body := *models.NewDerivedRoleRuleDelete(rule.Role, rule.OnResource, rule.LinkedByRelation)
				if err := call(func(ctx context.Context) error { return a.ImplicitGrants.Delete(ctx, res.Key, role.Key, body) }, 404); err != nil {
					return fmt.Errorf("derivation %s#%s from %s#%s: %w", res.Key, role.Key, rule.OnResource, rule.Role, err)
				}
				removed = append(removed, fmt.Sprintf("derivation %s#%s from %s#%s", res.Key, role.Key, rule.OnResource, rule.Role))
			}
		}
		for _, role := range current {
			if slices.ContainsFunc(want.Roles, func(x schema.Role) bool { return x.Key == role.Key }) {
				continue
			}
			if err := call(func(ctx context.Context) error { return a.ResourceRoles.Delete(ctx, res.Key, role.Key) }, 404); err != nil {
				return err
			}
			removed = append(removed, fmt.Sprintf("role %s#%s", res.Key, role.Key))
		}
		if res.Actions != nil {
			for key := range *res.Actions {
				if slices.Contains(want.Actions, key) {
					continue
				}
				if err := call(func(ctx context.Context) error { return a.ResourceActions.Delete(ctx, res.Key, key) }, 404); err != nil {
					return err
				}
				removed = append(removed, fmt.Sprintf("action %s:%s", res.Key, key))
			}
		}
		if res.Attributes != nil {
			for key := range *res.Attributes {
				if slices.ContainsFunc(want.Attributes, func(x schema.Attribute) bool { return x.Key == key }) {
					continue
				}
				if err := call(func(ctx context.Context) error { return a.ResourceAttributes.Delete(ctx, res.Key, key) }, 404); err != nil {
					return err
				}
				removed = append(removed, fmt.Sprintf("attribute %s.%s", res.Key, key))
			}
		}
		relations, err := permitapi.Deref(func() (*[]models.RelationRead, error) {
			var out *[]models.RelationRead
			err := call(func(ctx context.Context) error {
				var err error
				out, err = a.ResourceRelations.List(ctx, 1, 100, res.Key)
				return err
			})
			return out, err
		}())
		if err != nil {
			return err
		}
		for _, rel := range relations {
			if slices.ContainsFunc(want.Relations, func(x schema.Relation) bool { return x.Key == rel.Key }) {
				continue
			}
			if err := call(func(ctx context.Context) error { return a.ResourceRelations.Delete(ctx, res.Key, rel.Key) }, 404); err != nil {
				return err
			}
			removed = append(removed, fmt.Sprintf("relation %s.%s", res.Key, rel.Key))
		}
	}
	if len(removed) > 0 {
		logf("removed from Permit (not in the schema): %s", strings.Join(removed, "; "))
	}
	return nil
}

type rule struct {
	UserSet     string `json:"user_set"`
	Permission  string `json:"permission"`
	ResourceSet string `json:"resource_set"`
}

type conditionSet struct {
	Key           string `json:"key"`
	Autogenerated bool   `json:"autogenerated"`
}

// rest makes GET calls to Permit's REST API with the key: for the key's scope, and for the lists
// the SDK can't read (see listRaw).
type rest struct{ url, key string }

// get reads path (with its query) into into. A non-200 answer is a *permitapi.HTTPError, so call's
// retries and allowed statuses see its status.
func (r rest) get(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(r.url, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.key)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return &permitapi.HTTPError{Method: http.MethodGet, Path: req.URL.Path, StatusCode: res.StatusCode, Status: res.Status}
	}
	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		return fmt.Errorf("decoding the answer to GET %s: %w", req.URL.Path, err)
	}
	return nil
}

// keyScope is the environment PERMIT_API_KEY belongs to, as Permit reports it.
type keyScope struct {
	ProjectID, ProjectKey, EnvID, EnvKey, EnvName string
}

// scopeOf asks Permit which project and environment the key belongs to.
func scopeOf(api rest) (keyScope, error) {
	var ids struct {
		ProjectID     string `json:"project_id"`
		EnvironmentID string `json:"environment_id"`
	}
	if err := call(func(ctx context.Context) error { return api.get(ctx, "/v2/api-key/scope", &ids) }); err != nil {
		return keyScope{}, fmt.Errorf("reading the scope of PERMIT_API_KEY: %w", err)
	}
	if ids.ProjectID == "" || ids.EnvironmentID == "" {
		return keyScope{}, errors.New("PERMIT_API_KEY is not an environment's key: use the API key of the environment the demo runs in")
	}
	type named struct {
		Key  string `json:"key"`
		Name string `json:"name"`
	}
	var project, env named
	if err := call(func(ctx context.Context) error { return api.get(ctx, "/v2/projects/"+ids.ProjectID, &project) }); err != nil {
		return keyScope{}, fmt.Errorf("reading project %s: %w", ids.ProjectID, err)
	}
	if err := call(func(ctx context.Context) error {
		return api.get(ctx, "/v2/projects/"+ids.ProjectID+"/envs/"+ids.EnvironmentID, &env)
	}); err != nil {
		return keyScope{}, fmt.Errorf("reading environment %s: %w", ids.EnvironmentID, err)
	}
	return keyScope{ProjectID: ids.ProjectID, ProjectKey: project.Key, EnvID: ids.EnvironmentID, EnvKey: env.Key, EnvName: env.Name}, nil
}

// check refuses to go on when .env names another project or environment than the key's (by key or
// ID); unset names aren't compared.
func (k keyScope) check(project, env string) error {
	if project != "" && project != k.ProjectKey && project != k.ProjectID {
		return fmt.Errorf("PERMIT_PROJECT in .env is %q, but PERMIT_API_KEY belongs to project %q: nothing was changed; fix .env first", project, k.ProjectKey)
	}
	if env != "" && env != k.EnvKey && env != k.EnvID {
		return fmt.Errorf("PERMIT_ENV in .env is %q, but PERMIT_API_KEY belongs to environment %q (%s): nothing was changed; fix .env first", env, k.EnvKey, k.EnvName)
	}
	return nil
}

// listRaw lists every item of an environment-level API collection, e.g. ("facts", "set_rules"), in
// the key's own environment. Two SDK list methods can't do it: the rules list always sends its three
// filters, and empty filters match nothing; the condition sets list expects a paginated answer and
// reads the API's plain list as empty.
func listRaw[T any](api rest, scope keyScope, area, collection string) ([]T, error) {
	var all []T
	for page := 1; ; page++ {
		var batch []T
		path := fmt.Sprintf("/v2/%s/%s/%s/%s?page=%d&per_page=100", area, scope.ProjectID, scope.EnvID, collection, page)
		if err := call(func(ctx context.Context) error { return api.get(ctx, path, &batch) }); err != nil {
			return nil, fmt.Errorf("listing %s: %w", collection, err)
		}
		all = append(all, batch...)
		if len(batch) < 100 {
			return all, nil
		}
	}
}

// syncFacts writes tenants, users, resource instances, parent links and role assignments, and removes
// whatever the seed doesn't have: organizations, people, instances, links and role assignments added
// in the app or left from an earlier version. Moved instances go back to their organization and stored
// attributes are restored.
// returned collects the instances deleted and created again in their seeded organization; churn
// reports whether anything was deleted.
func syncFacts(a *api.PermitApiClient, returned *[]string, waitGone, waitUnlinked func(ids []string)) (churn bool, err error) {
	defer func() { churn = churn || len(*returned) > 0 }()
	tenants, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.TenantRead, error) {
		return a.Tenants.List(ctx, page, perPage)
	})
	if err != nil {
		return false, err
	}
	var gone []string
	for _, t := range tenants {
		if _, ok := model.TenantOf(t.Key); ok || t.Key == "default" {
			continue
		}
		if err := call(func(ctx context.Context) error { return a.Tenants.Delete(ctx, t.Key) }, 404); err != nil {
			return false, err
		}
		gone = append(gone, t.Key)
		churn = true
	}
	for _, t := range model.Tenants {
		create := func(ctx context.Context) error {
			_, err := a.Tenants.Create(ctx, models.TenantCreate{Key: t.Key, Name: t.Name, Description: ptr(t.Description)})
			return err
		}
		update := func(ctx context.Context) error {
			_, err := a.Tenants.Update(ctx, t.Key, models.TenantUpdate{Name: ptr(t.Name), Description: ptr(t.Description)})
			return err
		}
		if _, err := permitapi.Ensure(create, update); err != nil {
			return false, fmt.Errorf("tenant %s: %w", t.Key, err)
		}
	}
	users, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.UserRead, error) {
		return a.Users.List(ctx, page, perPage)
	})
	if err != nil {
		return false, err
	}
	for _, u := range users {
		if _, ok := model.UserOf(u.Key); ok {
			continue
		}
		if err := call(func(ctx context.Context) error { return a.Users.Delete(ctx, u.Key) }, 404); err != nil {
			return false, err
		}
		gone = append(gone, "user "+u.Key)
		churn = true
	}
	for _, u := range model.Users {
		body := models.UserCreate{
			Key: u.Key, Email: ptr(u.Email), FirstName: ptr(u.FirstName), LastName: ptr(u.LastName),
			Attributes: map[string]any{"home_tenant": u.HomeTenant, "certifications": u.Certifications},
		}
		if err := call(func(ctx context.Context) error { _, err := a.Users.SyncUser(ctx, body); return err }); err != nil {
			return false, fmt.Errorf("user %s: %w", u.Key, err)
		}
	}
	note := ""
	if len(gone) > 0 {
		note = fmt.Sprintf(" (removed %s)", strings.Join(gone, ", "))
	}
	logf("tenants: %d, users: %d%s", len(model.Tenants), len(model.Users), note)

	rows, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.ResourceInstanceRead, error) {
		return permitapi.Deref(a.ResourceInstances.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return false, err
	}
	have := map[string]models.ResourceInstanceRead{}
	for _, i := range rows {
		have[i.Resource+":"+i.Key] = i
	}
	updated := 0
	var moveBack []model.Instance // moved to another organization in the app (transfer, merge)
	for _, i := range model.Instances {
		current, exists := have[i.ID()]
		switch {
		case !exists:
			body := models.ResourceInstanceCreate{Key: i.Key, Resource: i.Type, Tenant: ptr(i.Tenant), Attributes: i.Attributes}
			if err := call(func(ctx context.Context) error { _, err := a.ResourceInstances.Create(ctx, body); return err }); err != nil {
				return false, fmt.Errorf("instance %s: %w", i.ID(), err)
			}
		case deref(current.Tenant) != i.Tenant:
			moveBack = append(moveBack, i)
		case len(i.Attributes) > 0 && !reflect.DeepEqual(current.Attributes, i.Attributes):
			body := models.ResourceInstanceUpdate{Attributes: i.Attributes}
			if err := call(func(ctx context.Context) error { _, err := a.ResourceInstances.Update(ctx, i.ID(), body); return err }); err != nil {
				return false, fmt.Errorf("instance %s: %w", i.ID(), err)
			}
			updated++
		}
	}
	// An instance can't change tenant: delete the moved ones, wait until the PDP has dropped them (so a
	// late deletion can't remove the new ones), and create them again where the seed has them. The
	// relationship and role-assignment steps below restore their links and grants.
	if len(moveBack) > 0 {
		var ids []string
		for _, i := range moveBack {
			ids = append(ids, i.ID())
		}
		// Their links first, so the instance deletions have none left to remove late (see ensureLinks).
		if err := unlink(a, ids, waitUnlinked); err != nil {
			return false, err
		}
		ids = ids[:0]
		for _, i := range moveBack {
			if err := call(func(ctx context.Context) error { return a.ResourceInstances.Delete(ctx, i.ID()) }, 404); err != nil {
				return false, fmt.Errorf("instance %s: %w", i.ID(), err)
			}
			ids = append(ids, i.ID())
		}
		waitGone(ids)
		for _, i := range moveBack {
			body := models.ResourceInstanceCreate{Key: i.Key, Resource: i.Type, Tenant: ptr(i.Tenant), Attributes: i.Attributes}
			if err := permitapi.CreateAgain(func(ctx context.Context) error { _, err := a.ResourceInstances.Create(ctx, body); return err }); err != nil {
				return false, fmt.Errorf("instance %s: %w", i.ID(), err)
			}
			*returned = append(*returned, i.ID())
		}
	}
	var extra []string
	for id := range have {
		if _, seeded := model.SeedByID[id]; !seeded {
			extra = append(extra, id)
		}
	}
	for _, id := range extra {
		if err := call(func(ctx context.Context) error { return a.ResourceInstances.Delete(ctx, id) }, 404); err != nil {
			return false, fmt.Errorf("instance %s: %w", id, err)
		}
	}
	churn = churn || len(extra) > 0
	note = ""
	if len(extra) > 0 {
		note += fmt.Sprintf(", removed %d not in the seed", len(extra))
	}
	if updated > 0 {
		note += fmt.Sprintf(", restored attributes on %d", updated)
	}
	if len(*returned) > 0 {
		note += fmt.Sprintf(", returned %d to their organization", len(*returned))
	}
	if note != "" {
		note = " (" + strings.TrimPrefix(note, ", ") + ")"
	}
	logf("resource instances: %d%s", len(model.Instances), note)

	tupleID := func(subject, relation, object string) string { return subject + "|" + relation + "|" + object }
	tuples, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RelationshipTupleRead, error) {
		return permitapi.Deref(a.RelationshipTuples.List(ctx, page, perPage, "", "", "", ""))
	})
	if err != nil {
		return false, err
	}
	haveT, wantT := map[string]bool{}, map[string]bool{}
	for _, t := range tuples {
		haveT[tupleID(t.Subject, t.Relation, t.Object)] = true
	}
	var create []models.RelationshipTupleCreate
	for _, t := range model.Tuples {
		id := tupleID(t.Subject, t.Relation, t.Object)
		wantT[id] = true
		if !haveT[id] {
			create = append(create, models.RelationshipTupleCreate{Subject: t.Subject, Relation: t.Relation, Object: t.Object, Tenant: ptr(t.Tenant)})
		}
	}
	for n := 0; n < len(create); n += 100 {
		batch := create[n:min(n+100, len(create))]
		if err := call(func(ctx context.Context) error {
			return a.RelationshipTuples.BulkCreate(ctx, *models.NewRelationshipTupleCreateBulkOperation(batch))
		}); err != nil {
			return false, err
		}
	}
	var remove []models.RelationshipTupleDelete
	for _, t := range tuples {
		if !wantT[tupleID(t.Subject, t.Relation, t.Object)] {
			remove = append(remove, *models.NewRelationshipTupleDelete(t.Subject, t.Relation, t.Object))
		}
	}
	if len(remove) > 0 {
		if err := call(func(ctx context.Context) error {
			return a.RelationshipTuples.BulkDelete(ctx, *models.NewRelationshipTupleDeleteBulkOperation(remove))
		}); err != nil {
			return false, err
		}
	}
	churn = churn || len(remove) > 0
	logf("relationships (parent links): %d (%d created, %d removed)", len(model.Tuples), len(create), len(remove))

	raID := func(user, role, instance, tenant string) string {
		return user + "|" + role + "|" + instance + "|" + tenant
	}
	current, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RoleAssignmentRead, error) {
		return permitapi.Deref(a.RoleAssignments.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return false, err
	}
	haveRA, wantRA := map[string]bool{}, map[string]bool{}
	for _, r := range current {
		haveRA[raID(r.User, r.Role, deref(r.ResourceInstance), r.Tenant)] = true
	}
	var assign []models.RoleAssignmentCreate
	for _, r := range model.RoleAssignments {
		id := raID(r.User, r.Role, r.ResourceInstance, r.Tenant)
		wantRA[id] = true
		if !haveRA[id] {
			body := *models.NewRoleAssignmentCreate(r.Role, r.Tenant, r.User)
			if r.ResourceInstance != "" {
				body.ResourceInstance = ptr(r.ResourceInstance)
			}
			assign = append(assign, body)
		}
	}
	if len(assign) > 0 {
		if err := call(func(ctx context.Context) error { _, err := a.Roles.BulkAssignRole(ctx, assign); return err }); err != nil {
			return false, err
		}
	}
	var unassign []models.RoleAssignmentRemove
	for _, r := range current {
		if !wantRA[raID(r.User, r.Role, deref(r.ResourceInstance), r.Tenant)] {
			body := *models.NewRoleAssignmentRemove(r.Role, r.Tenant, r.User)
			body.ResourceInstance = r.ResourceInstance
			unassign = append(unassign, body)
		}
	}
	if len(unassign) > 0 {
		if err := call(func(ctx context.Context) error { _, err := a.Roles.BulkUnAssignRole(ctx, unassign); return err }); err != nil {
			return false, err
		}
	}
	logf("role assignments: %d (%d created, %d removed)", len(model.RoleAssignments), len(assign), len(unassign))
	return churn, nil
}

// unlink deletes the relationship tuples that name any of the instances, then waits for the PDP to drop them.
func unlink(a *api.PermitApiClient, ids []string, waitUnlinked func(ids []string)) error {
	tuples, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RelationshipTupleRead, error) {
		return permitapi.Deref(a.RelationshipTuples.List(ctx, page, perPage, "", "", "", ""))
	})
	if err != nil {
		return err
	}
	var del []models.RelationshipTupleDelete
	for _, t := range tuples {
		if slices.Contains(ids, t.Subject) || slices.Contains(ids, t.Object) {
			del = append(del, *models.NewRelationshipTupleDelete(t.Subject, t.Relation, t.Object))
		}
	}
	if len(del) == 0 {
		return nil
	}
	if err := call(func(ctx context.Context) error {
		return a.RelationshipTuples.BulkDelete(ctx, *models.NewRelationshipTupleDeleteBulkOperation(del))
	}); err != nil {
		return err
	}
	waitUnlinked(ids)
	return nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

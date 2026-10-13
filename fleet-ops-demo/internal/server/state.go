// Package server is Fleet Ops: a multi-tenant fleet app whose every authorization decision comes from
// the local PDP, through the Permit Go SDK.
//
// Authorization data (organizations, resources, relationships, role assignments, people's attributes)
// lives in Permit: it is read at start and written through the SDK's API client. App data (team
// members, each truck's dispatch and service history, recent activity) lives in memory. Every check
// the server makes is returned to the browser, which shows it in the PDP log.
package server

import (
	"context"
	"maps"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/permitio/permit-golang/pkg/api"
	"github.com/permitio/permit-golang/pkg/models"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
	"fleetops/internal/permitapi"
)

var (
	truckActions = []string{"operate", "service_basic", "service_advanced", "decommission"}
	siteRoles    = []string{"site_manager", "operator", "technician", "viewer"}
	// roleTruckAction is the truck action each site role adds, used to show a role change taking effect.
	roleTruckAction = map[string]string{"site_manager": "decommission", "operator": "operate", "technician": "service_basic", "viewer": "view"}
)

// historyRecord is one entry in a truck's history: a dispatch or a service.
type historyRecord struct {
	Kind, By string
	At       time.Time
}

type activityEvent struct {
	Text string
	At   time.Time
}

// breakglassGrant is one time-boxed grant (scenario 14), stored in the person's `breakglass` attribute.
type breakglassGrant struct {
	Tenant     string `json:"tenant"`
	IncidentID string `json:"incident_id"`
	ExpiresAt  int64  `json:"expires_at"` // Unix seconds
	GrantedBy  string `json:"granted_by"`
}

func (g breakglassGrant) active(now time.Time) bool { return now.Unix() < g.ExpiresAt }

type App struct {
	pdp *pdp.Client
	api *api.PermitApiClient

	// mu guards the state below: page loads read it (RLock), actions change it (Lock).
	mu          sync.RWMutex
	tenants     map[string]bool            // organizations that exist in Permit
	instances   map[string]*model.Instance // "type:key" -> instance
	members     map[string][]string        // team id -> member person keys
	assignments []model.RoleAssignment     // as Permit lists them
	userAttrs   map[string]map[string]any  // person key -> attributes stored in Permit
	history     map[string][]historyRecord // truck id -> newest first
	activity    map[string][]activityEvent // person key -> newest first

	seq atomic.Int64 // log entry ids
}

func New(p *pdp.Client) *App {
	return &App{
		pdp:       p,
		api:       p.Permit.Api,
		tenants:   map[string]bool{},
		instances: map[string]*model.Instance{},
		members:   map[string][]string{},
		userAttrs: map[string]map[string]any{},
		history:   map[string][]historyRecord{},
		activity:  map[string][]activityEvent{},
	}
}

// Load reads the authorization data from Permit: organizations, resource instances, relationships,
// role assignments and people's attributes.
func (a *App) Load() error {
	tenants, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.TenantRead, error) {
		return a.api.Tenants.List(ctx, page, perPage)
	})
	if err != nil {
		return err
	}
	rows, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.ResourceInstanceRead, error) {
		return permitapi.Deref(a.api.ResourceInstances.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return err
	}
	tuples, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RelationshipTupleRead, error) {
		return permitapi.Deref(a.api.RelationshipTuples.List(ctx, page, perPage, "", "", "", ""))
	})
	if err != nil {
		return err
	}
	roles, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.RoleAssignmentRead, error) {
		return permitapi.Deref(a.api.RoleAssignments.List(ctx, page, perPage, "", "", ""))
	})
	if err != nil {
		return err
	}
	users, err := permitapi.ListAll(func(ctx context.Context, page, perPage int) ([]models.UserRead, error) {
		return a.api.Users.List(ctx, page, perPage)
	})
	if err != nil {
		return err
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	for _, t := range tenants {
		a.tenants[t.Key] = true
	}
	parentOf := map[string]string{}
	for _, t := range tuples {
		if t.Relation == "parent" {
			parentOf[t.Object] = t.Subject
		}
	}
	for _, row := range rows {
		id := row.Resource + ":" + row.Key
		name := model.SeedByID[id].Name
		if name == "" {
			name = defaultName(row.Resource, row.Key)
		}
		tenant := ""
		if row.Tenant != nil {
			tenant = *row.Tenant
		}
		attrs := maps.Clone(row.Attributes)
		if attrs == nil {
			attrs = map[string]any{}
		}
		a.instances[id] = &model.Instance{Type: row.Resource, Key: row.Key, Tenant: tenant, Name: name, Parent: parentOf[id], Attributes: attrs}
	}
	a.assignments = a.assignments[:0]
	for _, r := range roles {
		ra := model.RoleAssignment{User: r.User, Role: r.Role, Tenant: r.Tenant}
		if r.ResourceInstance != nil {
			ra.ResourceInstance = *r.ResourceInstance
		}
		a.assignments = append(a.assignments, ra)
	}
	for _, u := range users {
		a.userAttrs[u.Key] = maps.Clone(u.Attributes)
	}
	for team, keys := range model.TeamMembers {
		for _, k := range keys {
			if _, exists := a.userAttrs[k]; exists {
				a.members[team] = append(a.members[team], k)
			}
		}
	}
	now := time.Now()
	for n, e := range model.SeedActivity {
		a.activity[e.User] = append(a.activity[e.User], activityEvent{Text: e.Text, At: now.Add(-time.Duration(20+15*n) * time.Minute)})
	}
	return nil
}

// defaultName names instances the seed doesn't know: their display name is rebuilt from the key.
func defaultName(typ, key string) string {
	if typ == "asset" {
		_, code, found := strings.Cut(key, "-")
		if !found {
			code = key
		}
		return "Truck " + strings.ToUpper(code)
	}
	return key
}

// nameOf names an instance by "type:key", for the log's explanations.
func (a *App) nameOf(id string) string {
	if i, ok := a.instances[id]; ok {
		return i.Name
	}
	if i, ok := model.SeedByID[id]; ok {
		return i.Name
	}
	return id
}

// record adds to a person's recent activity (scenario 5).
func (a *App) record(user, text string) {
	a.activity[user] = append([]activityEvent{{Text: text, At: time.Now()}}, a.activity[user]...)
}

func (a *App) certifications(user string) []string {
	var certs []string
	if list, ok := a.userAttrs[user]["certifications"].([]any); ok {
		for _, c := range list {
			if s, ok := c.(string); ok {
				certs = append(certs, s)
			}
		}
	}
	return certs
}

func (a *App) breakglass(user string) []breakglassGrant {
	var grants []breakglassGrant
	list, _ := a.userAttrs[user]["breakglass"].([]any)
	for _, item := range list {
		m, _ := item.(map[string]any)
		g := breakglassGrant{IncidentID: str(m["incident_id"]), Tenant: str(m["tenant"]), GrantedBy: str(m["granted_by"])}
		if secs, ok := m["expires_at"].(float64); ok {
			g.ExpiresAt = int64(secs)
		}
		grants = append(grants, g)
	}
	return grants
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

var digits = regexp.MustCompile(`\d+|\D+`)

// naturalLess sorts "DAL-2" before "DAL-10".
func naturalLess(x, y string) bool {
	xs, ys := digits.FindAllString(x, -1), digits.FindAllString(y, -1)
	for n := 0; n < len(xs) && n < len(ys); n++ {
		if xs[n] == ys[n] {
			continue
		}
		xn, xErr := strconv.Atoi(xs[n])
		yn, yErr := strconv.Atoi(ys[n])
		if xErr == nil && yErr == nil {
			return xn < yn
		}
		return xs[n] < ys[n]
	}
	return len(xs) < len(ys)
}

// filter returns the instances that match, sorted by less.
func (a *App) filter(match func(*model.Instance) bool, less func(x, y *model.Instance) bool) []*model.Instance {
	var out []*model.Instance
	for _, i := range a.instances {
		if match(i) {
			out = append(out, i)
		}
	}
	sort.Slice(out, func(n, m int) bool { return less(out[n], out[m]) })
	return out
}

func byKey(x, y *model.Instance) bool  { return naturalLess(x.Key, y.Key) }
func byName(x, y *model.Instance) bool { return naturalLess(x.Name, y.Name) }

func (a *App) children(id, typ string) []*model.Instance {
	return a.filter(func(i *model.Instance) bool { return i.Parent == id && i.Type == typ }, byKey)
}

// sitesOf lists an organization's sites by name.
func (a *App) sitesOf(tenant string) []*model.Instance {
	return a.filter(func(i *model.Instance) bool { return i.Type == "site" && i.Tenant == tenant }, byName)
}

// get returns the instance, or an empty one when it doesn't exist.
func (a *App) get(id string) *model.Instance {
	if i, ok := a.instances[id]; ok {
		return i
	}
	return &model.Instance{}
}

func (a *App) siteOf(truck *model.Instance) *model.Instance { return a.get(truck.Parent) }

// operatorOf is the organization operating a truck; usually its owner (scenario 7).
func operatorOf(truck *model.Instance) string {
	if op := str(truck.Attributes["operator_org"]); op != "" {
		return op
	}
	return truck.Tenant
}

// fleetOf lists an organization's trucks: the ones it owns and the ones it operates for another
// organization (scenario 7).
func (a *App) fleetOf(org string) []*model.Instance {
	return a.filter(func(i *model.Instance) bool {
		return i.Type == "asset" && (i.Tenant == org || operatorOf(i) == org)
	}, byName)
}

// platformStaff reports whether a person is one of the platform operator's org admins, as Permit's data has it. The
// PDP decides what they may do; this only labels the organization menu and picks probes.
func (a *App) platformStaff(user string) bool {
	return slices.ContainsFunc(a.assignments, func(ra model.RoleAssignment) bool {
		return ra.User == user && ra.Role == "org_admin" && ra.ResourceInstance == model.PlatformOrg
	})
}

// exists reports whether a person is still in Permit (scenario 15 removes people).
func (a *App) exists(user string) bool {
	_, ok := a.userAttrs[user]
	return ok
}

type membership struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Via  string `json:"via"` // home, platform, granted or breakglass
}

// memberships are the organizations a person can act for: their own, those where they hold a role
// (for platform staff, every customer organization), and those where they hold an active
// break-glass grant.
func (a *App) memberships(userKey string) []membership {
	user, _ := model.UserOf(userKey)
	platform := a.platformStaff(userKey)
	out := []membership{}
	now := time.Now()
	for _, t := range model.Tenants {
		if !a.tenants[t.Key] {
			continue
		}
		hasRole := slices.ContainsFunc(a.assignments, func(r model.RoleAssignment) bool { return r.User == userKey && r.Tenant == t.Key })
		breakglass := slices.ContainsFunc(a.breakglass(userKey), func(g breakglassGrant) bool { return g.Tenant == t.Key && g.active(now) })
		via := ""
		switch {
		case t.Key == user.HomeTenant:
			via = "home"
		case hasRole && platform:
			via = "platform"
		case hasRole:
			via = "granted"
		case breakglass:
			via = "breakglass"
		}
		if via != "" {
			out = append(out, membership{Key: t.Key, Name: t.Name, Via: via})
		}
	}
	return out
}

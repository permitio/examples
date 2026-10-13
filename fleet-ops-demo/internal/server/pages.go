package server

import (
	"fmt"
	"slices"
	"time"

	"fleetops/internal/model"
	"fleetops/internal/pdp"
)

type obj = map[string]any

type truckSummary struct {
	Key       string `json:"key"`
	Name      string `json:"name"`
	Site      string `json:"site"`
	SiteKey   string `json:"siteKey"`
	Region    string `json:"region"`
	Lifecycle any    `json:"lifecycle"`
	Owner     string `json:"owner"`    // owning organization
	Operator  any    `json:"operator"` // operating organization when another one operates it, else null
	Org       string `json:"org"`      // the organization the person acted for when the row was checked
}

func (a *App) summary(truck *model.Instance) truckSummary {
	site := a.siteOf(truck)
	s := truckSummary{
		Key:       truck.Key,
		Name:      truck.Name,
		Site:      site.Name,
		SiteKey:   site.Key,
		Region:    a.get(site.Parent).Name,
		Lifecycle: truck.Attributes["lifecycle_state"],
		Owner:     model.OrgName(truck.Tenant),
	}
	if op := operatorOf(truck); op != truck.Tenant {
		s.Operator = model.OrgName(op)
	}
	return s
}

type named struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

// fleet lists the acting organization's trucks (owned or operated for another organization) and asks
// the PDP which ones the person may see. With org "*" it lists every organization the person can act
// for, each checked acting for that organization (scenario 8: a broker's shared trucks).
func (a *App) fleet(user, org string) (obj, error) {
	r := a.newRequest()
	orgs := []string{org}
	if org == "*" {
		orgs = nil
		for _, m := range a.memberships(user) {
			orgs = append(orgs, m.Key)
		}
	}
	visible, total := []truckSummary{}, 0
	for _, o := range orgs {
		trucks := a.fleetOf(o)
		total += len(trucks)
		if len(trucks) == 0 {
			continue
		}
		checks := make([]pdp.Check, len(trucks))
		for n, t := range trucks {
			checks[n] = pdp.NewCheck(user, "view", t.ID(), o)
		}
		allowed, err := r.checkMany(fmt.Sprintf("Fleet list: which %s trucks can %s see?", model.OrgName(o), model.UserName(user)), checks)
		if err != nil {
			return nil, err
		}
		for n, t := range trucks {
			if allowed[n] {
				row := a.summary(t)
				row.Org = o
				visible = append(visible, row)
			}
		}
	}
	return obj{"trucks": visible, "total": total, "log": r.log}, nil
}

type historyRow struct {
	Kind string `json:"kind"`
	By   string `json:"by"`
	At   string `json:"at"`
	Time string `json:"time"`
}

// truckPage opens only if the PDP allows view for the acting organization; then one bulk call
// decides which actions and admin controls to show.
func (a *App) truckPage(user, org, key string) (obj, error) {
	r := a.newRequest()
	truck, ok := a.instances["asset:"+key]
	if !ok {
		return obj{"notFound": true, "log": r.log}, nil
	}
	id := truck.ID()
	allowed, err := r.checkOne("Open "+truck.Name, user, "view", id, org)
	if err != nil {
		return nil, err
	}
	if !allowed {
		c := r.last()
		return obj{"denied": true, "truck": named{Key: key, Name: truck.Name}, "reason": c.Reason, "code": c.ActingOrg, "log": r.log}, nil
	}

	orgSites := a.sitesOf(truck.Tenant)
	var asks []pdp.Check
	for _, action := range truckActions {
		asks = append(asks, pdp.NewCheck(user, action, id, org))
	}
	// Site admin rights (assign_roles) on the truck's site and the organization's other sites decide
	// details, partner access and moves; platform staff may transfer the truck to another organization.
	for _, s := range orgSites {
		asks = append(asks, pdp.NewCheck(user, "assign_roles", s.ID(), org))
	}
	asks = append(asks, platformCheck(user))
	answers, err := r.checkMany(truck.Name+": which actions and controls to show", asks)
	if err != nil {
		return nil, err
	}
	can := map[string]bool{} // "action resource-id" -> allowed
	for n, c := range asks {
		can[c.Action+" "+c.Resource.ID()] = answers[n]
	}
	siteAdmin := can["assign_roles "+truck.Parent]
	platform := can["manage_users "+model.PlatformOrg]

	actions := []string{}
	for _, action := range truckActions {
		if can[action+" "+id] {
			actions = append(actions, action)
		}
	}
	history := []historyRow{}
	for _, h := range a.history[id] {
		history = append(history, historyRow{Kind: h.Kind, By: h.By, At: h.At.Format(time.RFC3339), Time: h.At.Format("15:04")})
	}
	moveTargets := []named{}
	var details, partners, eligible any // null unless the person is an admin of the truck's site
	if siteAdmin {
		for _, s := range orgSites {
			if s.ID() != truck.Parent && can["assign_roles "+s.ID()] {
				moveTargets = append(moveTargets, named{Key: s.Key, Name: s.Name})
			}
		}
		// Scenario 11: the attributes the resource sets read.
		details = obj{
			"region":   truck.Attributes["region"],
			"account":  truck.Attributes["served_account"],
			"regions":  []string{"South", "West", "East"},
			"accounts": []string{"Acct1", "Acct2"},
		}
		current, others := []named{}, []named{}
		var granted []string
		for _, ra := range a.assignments {
			if ra.Role == "partner_technician" && ra.ResourceInstance == id {
				granted = append(granted, ra.User)
				current = append(current, named{Key: ra.User, Name: model.FullName(ra.User)})
			}
		}
		for _, u := range model.Users {
			if model.PartnerOrgs[u.HomeTenant] && a.exists(u.Key) && !slices.Contains(granted, u.Key) {
				others = append(others, named{Key: u.Key, Name: model.FullName(u.Key) + ", " + model.OrgName(u.HomeTenant)})
			}
		}
		partners, eligible = current, others
	}
	// Scenarios 6 and 13: platform staff may transfer the truck to a site in another organization.
	transferTargets := []named{}
	if platform {
		for _, s := range a.filter(func(i *model.Instance) bool {
			return i.Type == "site" && i.Tenant != truck.Tenant && a.tenants[i.Tenant]
		}, byName) {
			transferTargets = append(transferTargets, named{Key: s.Key, Name: model.OrgName(s.Tenant) + ", " + s.Name})
		}
	}
	code := model.CodeOf(*truck)
	lanes, ok := model.Lanes[code[:min(3, len(code))]]
	if !ok {
		lanes = []string{"Local run"}
	}

	type truckDetail struct {
		truckSummary
		ServedAccount any      `json:"servedAccount"`
		Lanes         []string `json:"lanes"`
	}
	return obj{
		"truck":            truckDetail{truckSummary: a.summary(truck), ServedAccount: truck.Attributes["served_account"], Lanes: lanes},
		"actions":          actions,
		"history":          history,
		"moveTargets":      moveTargets,
		"details":          details,
		"transferTargets":  transferTargets,
		"partners":         partners,
		"eligiblePartners": eligible,
		"log":              r.log,
	}, nil
}

type personRole struct {
	User string `json:"user"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// sitePage shows a site: its trucks, its teams and, to its admins, the people with roles on it.
func (a *App) sitePage(user, org, key string) (obj, error) {
	r := a.newRequest()
	site, ok := a.instances["site:"+key]
	if !ok {
		return obj{"notFound": true, "log": r.log}, nil
	}
	id := site.ID()
	allowed, err := r.checkOne("Open "+site.Name, user, "view", id, org)
	if err != nil {
		return nil, err
	}
	if !allowed {
		c := r.last()
		return obj{"denied": true, "site": named{Key: key, Name: site.Name}, "reason": c.Reason, "code": c.ActingOrg, "log": r.log}, nil
	}

	trucks := a.children(id, "asset")
	asks := []pdp.Check{pdp.NewCheck(user, "assign_roles", id, org)}
	for _, t := range trucks {
		asks = append(asks, pdp.NewCheck(user, "view", t.ID(), org))
	}
	answers, err := r.checkMany(site.Name+": which trucks and controls to show", asks)
	if err != nil {
		return nil, err
	}
	visible := []truckSummary{}
	for n, t := range trucks {
		if answers[1+n] {
			visible = append(visible, a.summary(t))
		}
	}
	var people any // null unless the person may give roles here
	if answers[0] {
		onSite := []personRole{}
		for _, ra := range a.assignments {
			if ra.ResourceInstance == id {
				onSite = append(onSite, personRole{User: ra.User, Name: model.FullName(ra.User), Role: ra.Role})
			}
		}
		people = onSite
	}
	return obj{
		"site": obj{
			"key":    key,
			"name":   site.Name,
			"region": a.get(site.Parent).Name,
			"owner":  model.OrgName(site.Tenant),
		},
		"trucks": visible,
		"people": people,
		"teams":  a.teams(id),
		"log":    r.log,
	}, nil
}

// teams lists a site's teams with their members (scenario 5).
func (a *App) teams(siteID string) []obj {
	out := []obj{}
	for _, t := range a.children(siteID, "team") {
		names := []string{}
		for _, m := range a.members[t.ID()] {
			names = append(names, model.FullName(m))
		}
		out = append(out, obj{"key": t.Key, "name": t.Name, "members": names})
	}
	return out
}

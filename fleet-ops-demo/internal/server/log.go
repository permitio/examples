package server

import (
	"fmt"
	"time"

	"fleetops/internal/explain"
	"fleetops/internal/model"
	"fleetops/internal/pdp"
)

// Call is one check in a log entry, with the PDP's answer and its explanation.
type Call struct {
	User     string       `json:"user"`
	Action   string       `json:"action"`
	Resource pdp.Resource `json:"resource"`
	Allow    bool         `json:"allow"`
	Code     string       `json:"code"`
	explain.Explanation
}

// Entry is one line of the PDP log: a single check or a bulk check.
type Entry struct {
	ID      int64          `json:"id"`
	At      string         `json:"at"`
	Purpose string         `json:"purpose"`
	Kind    string         `json:"kind"` // check or bulk
	MS      float64        `json:"ms"`
	Calls   []Call         `json:"calls"`
	Code    string         `json:"code"`
	Debug   map[string]any `json:"debug"` // the PDP's raw debug output, single checks only
}

// request collects the checks one HTTP request makes, for the log.
type request struct {
	app *App
	log []Entry
}

func (a *App) newRequest() *request { return &request{app: a, log: []Entry{}} }

func millis(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func (r *request) record(purpose, kind string, checks []pdp.Check, results []bool, elapsed time.Duration, debugs []map[string]any) Entry {
	calls := make([]Call, len(checks))
	for n, c := range checks {
		calls[n] = Call{
			User: c.User, Action: c.Action, Resource: c.Resource, Allow: results[n], Code: pdp.Code(c),
			Explanation: explain.Explain(results[n], debugs[n], c, r.app.nameOf),
		}
	}
	e := Entry{
		ID:      r.app.seq.Add(1),
		At:      time.Now().UTC().Format(time.RFC3339Nano),
		Purpose: purpose,
		Kind:    kind,
		MS:      millis(elapsed),
		Calls:   calls,
		Code:    pdp.BulkCode(len(checks)),
	}
	if kind == "check" {
		e.Code, e.Debug = calls[0].Code, debugs[0]
	}
	r.log = append(r.log, e)
	return e
}

// last is the newest single check in the log.
func (r *request) last() Call { return r.log[len(r.log)-1].Calls[0] }

// refuse answers an action the PDP denied, with the PDP's reason, or passes on the error when the
// check itself failed.
func (r *request) refuse(err error) (obj, error) {
	if err != nil {
		return nil, err
	}
	return obj{"denied": true, "message": r.last().Reason, "log": r.log}, nil
}

// checkOne asks the PDP through permitClient.Check and logs the answer with its reason.
func (r *request) checkOne(purpose, user, action, resource, org string) (bool, error) {
	c := pdp.NewCheck(user, action, resource, org)
	started := time.Now()
	allow, err := r.app.pdp.Check(c)
	if err != nil {
		return false, fmt.Errorf("permitClient.Check: %w", err)
	}
	elapsed := time.Since(started)
	r.record(purpose, "check", []pdp.Check{c}, []bool{allow}, elapsed, []map[string]any{r.app.pdp.Debug(c)})
	return allow, nil
}

// checkMany asks the PDP through permitClient.BulkCheck and logs the answers with their reasons.
func (r *request) checkMany(purpose string, checks []pdp.Check) ([]bool, error) {
	if len(checks) == 0 {
		return []bool{}, nil
	}
	started := time.Now()
	results, err := r.app.pdp.BulkCheck(checks)
	if err != nil {
		return nil, fmt.Errorf("permitClient.BulkCheck: %w", err)
	}
	elapsed := time.Since(started)
	r.record(purpose, "bulk", checks, results, elapsed, r.app.pdp.DebugMany(checks))
	return results, nil
}

// untilDecision runs after a write: it polls the PDP until the answer flips (at most 10 s), then logs
// that final check with the delay.
func (r *request) untilDecision(purpose, user, action, resource, org string, want bool) error {
	c := pdp.NewCheck(user, action, resource, org)
	started := time.Now()
	var allow bool
	var elapsed time.Duration
	for {
		t := time.Now()
		var err error
		if allow, err = r.app.pdp.Check(c); err != nil {
			return fmt.Errorf("permitClient.Check: %w", err)
		}
		elapsed = time.Since(t)
		if allow == want || time.Since(started) > 10*time.Second {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	waited := time.Since(started)
	r.record(fmt.Sprintf("%s (%d ms after the write)", purpose, waited.Milliseconds()), "check", []pdp.Check{c}, []bool{allow}, elapsed, []map[string]any{r.app.pdp.Debug(c)})
	return nil
}

// platform asks whether the person is platform staff, for platform-only actions (tier 3, transfers,
// deleting or merging an organization): org admin rights (manage_users) on the platform operator's
// own organization, acting for it.
func (r *request) platform(purpose, user string) (bool, error) {
	return r.checkOne(purpose, user, "manage_users", model.PlatformOrg, model.PlatformTenant)
}

// platformCheck is the same check, for a bulk.
func platformCheck(user string) pdp.Check {
	return pdp.NewCheck(user, "manage_users", model.PlatformOrg, model.PlatformTenant)
}

// untilData runs after a write: it waits until the PDP's loaded data shows it (at most 10 s).
func (a *App) untilData(path string, ready func(data any) bool) {
	started := time.Now()
	for time.Since(started) < 10*time.Second && !ready(a.pdp.OPAData(path)) {
		time.Sleep(150 * time.Millisecond)
	}
}

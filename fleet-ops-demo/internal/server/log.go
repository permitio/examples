package server

import (
	"errors"
	"fmt"
	"maps"
	"strings"
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

// request collects the checks one HTTP request makes, for the log, and what the PDP had not caught
// up with after the request's writes.
type request struct {
	app *App
	log []Entry
	lag []string
}

func (a *App) newRequest() *request { return &request{app: a, log: []Entry{}} }

func millis(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

// record logs checks with their answers. debugs holds the PDP's debug output for each check; when
// it couldn't be read (debugErr), each check is logged with its verdict only.
func (r *request) record(purpose, kind string, checks []pdp.Check, results []bool, elapsed time.Duration, debugs []map[string]any, debugErr error) Entry {
	calls := make([]Call, len(checks))
	for n, c := range checks {
		var debug map[string]any
		if debugErr == nil {
			debug = debugs[n]
		}
		explanation := explain.Explain(results[n], debug, c, r.app.nameOf)
		if debugErr != nil {
			explanation = explain.Unavailable(results[n], c, r.app.nameOf, "the PDP's debug output couldn't be read: "+debugErr.Error())
		}
		calls[n] = Call{
			User: c.User, Action: c.Action, Resource: c.Resource, Allow: results[n], Code: pdp.Code(c),
			Explanation: explanation,
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
		e.Code = calls[0].Code
		if debugErr == nil {
			e.Debug = debugs[0]
		}
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

// done answers a write Permit accepted, with the success message and any extra fields (a redirect).
// When the PDP had not caught up with the write in time, the answer says so in place of the success
// message, so the page never claims an effect the PDP doesn't show yet.
func (r *request) done(message string, extra obj) obj {
	out := obj{"log": r.log}
	maps.Copy(out, extra)
	if len(r.lag) > 0 {
		out["error"] = fmt.Sprintf("Permit has the change, but the PDP doesn't confirm it: %s. Its decisions may still use the old data; reload in a moment, or run `make verify`.", strings.Join(r.lag, "; "))
		return out
	}
	out["ok"], out["message"] = true, message
	return out
}

// lagged notes what the PDP had not caught up with, or couldn't be read to confirm, for done.
func (r *request) lagged(err error) {
	var behind *pdp.NotCaughtUpError
	if errors.As(err, &behind) {
		r.lag = append(r.lag, behind.Detail)
		return
	}
	r.lag = append(r.lag, err.Error())
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
	debug, debugErr := r.app.pdp.Debug(c)
	r.record(purpose, "check", []pdp.Check{c}, []bool{allow}, elapsed, []map[string]any{debug}, debugErr)
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
	if len(results) != len(checks) {
		return nil, fmt.Errorf("permitClient.BulkCheck: %d answers for %d checks", len(results), len(checks))
	}
	elapsed := time.Since(started)
	debugs, debugErr := r.app.pdp.DebugMany(checks)
	r.record(purpose, "bulk", checks, results, elapsed, debugs, debugErr)
	return results, nil
}

// decisionWait bounds how long untilDecision polls for the answer to flip after a write.
var decisionWait = 10 * time.Second

// untilDecision runs after a write: it polls the PDP until the answer flips (at most decisionWait),
// then logs that final check with the delay. When the answer never flips, it notes that for done.
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
		if allow == want || time.Since(started) > decisionWait {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	waited := time.Since(started)
	debug, debugErr := r.app.pdp.Debug(c)
	r.record(fmt.Sprintf("%s (%d ms after the write)", purpose, waited.Milliseconds()), "check", []pdp.Check{c}, []bool{allow}, elapsed, []map[string]any{debug}, debugErr)
	if allow != want {
		verdict := "denies"
		if allow {
			verdict = "allows"
		}
		r.lagged(fmt.Errorf("after %s it still %s %s %s on %s", decisionWait, verdict, model.FullName(user), action, r.app.nameOf(resource)))
	}
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

// dataWait bounds how long untilData waits for the PDP's data to show a write.
var dataWait = 10 * time.Second

// untilData runs after a write: it waits until the PDP's loaded data at path shows it (at most
// dataWait). what names the change, for the note done shows when the PDP hasn't caught up or its
// data couldn't be read.
func (r *request) untilData(what, path string, ready func(data any) bool) {
	started := time.Now()
	for {
		data, err := r.app.pdp.OPAData(path)
		if err != nil {
			r.lagged(fmt.Errorf("couldn't read its data to confirm %s (%w)", what, err))
			return
		}
		if ready(data) {
			return
		}
		if time.Since(started) > dataWait {
			r.lagged(fmt.Errorf("after %s its data doesn't show %s", dataWait, what))
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

// holdLinks waits until the PDP has the parent links and keeps them (pdp.Settle, then pdp.Keep), and
// notes for done what it had not caught up with.
func (r *request) holdLinks(links map[string]string, stable, limit time.Duration) {
	var behind *pdp.NotCaughtUpError
	if err := r.app.pdp.Settle(links); err != nil && !errors.As(err, &behind) {
		r.lagged(fmt.Errorf("couldn't read its data to confirm the parent links (%w)", err))
		return
	}
	// Settle can see the links before a late deletion takes them again: Keep has the last word.
	if _, err := r.app.pdp.Keep(links, stable, limit); err != nil {
		r.lagged(err)
	}
}

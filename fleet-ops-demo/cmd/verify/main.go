// Command verify is the pre-flight before the call: is the PDP up, are the custom rules loaded, and
// does the PDP still give every decision the scenarios rely on? Exits non-zero if anything is off.
//
//	make verify
package main

import (
	"fmt"
	"os"
	"time"

	"fleetops/internal/checks"
	"fleetops/internal/pdp"
	"fleetops/internal/settings"
)

func main() {
	os.Exit(run())
}

func run() int {
	s := settings.MustLoad()
	client := pdp.New(s, settings.Client(s))

	st := client.Status()
	rules := yesNo(st.ActingOrgRule)
	if st.RulesUnknown != "" {
		rules = "unknown"
	}
	fmt.Printf("PDP reachable ......................................... %s\n", yesNo(st.PDP))
	fmt.Printf("Custom rules loaded (tenant isolation, fleet rules) .... %s\n", rules)
	if !st.PDP {
		fmt.Fprintln(os.Stderr, "\nStart the PDP with `make pdp` and wait for http://localhost:7766/healthy.")
		return 1
	}
	switch {
	case st.RulesUnknown != "":
		fmt.Fprintf(os.Stderr, "\nCouldn't read the PDP's policy, so it is unknown whether the custom rules are loaded: %s\nCheck OPA_URL in .env: the PDP's OPA, port 8181 in docker-compose.yml.\n", st.RulesUnknown)
	case !st.ActingOrgRule:
		fmt.Fprintln(os.Stderr, "\nThe custom rules are missing from the PDP. Run `make apply-policy`.")
	}

	requests := make([]pdp.Check, len(checks.Checks))
	for n, c := range checks.Checks {
		requests[n] = pdp.NewCheck(c.User, c.Action, c.Resource, c.ActingOrg)
	}
	started := time.Now()
	results, err := client.BulkCheck(requests)
	if err != nil {
		fmt.Fprintln(os.Stderr, "\npermitClient.BulkCheck failed:", err)
		return 1
	}
	fmt.Printf("\n%d checks through permitClient.BulkCheck in %d ms\n", len(requests), time.Since(started).Milliseconds())
	// Scenario 17: every decision names the version of the custom rules that decided it.
	version := "missing"
	debug, err := client.Debug(requests[0])
	if err != nil {
		version = "unknown, the debug output couldn't be read: " + err.Error()
	}
	if fleet, ok := debug["fleet_rules"].(map[string]any); ok {
		if v, ok := fleet["policy_version"].(string); ok {
			version = v
		}
	}
	fmt.Printf("Custom policy version in each decision ................ %s\n\n", version)

	failed := 0
	for n, c := range checks.Checks {
		actual := "deny"
		if results[n] {
			actual = "allow"
		}
		status := "ok  "
		if actual != c.Expect {
			status = "FAIL"
			failed++
		}
		fmt.Printf("%s %-6s %-7s %-17s %-24s acting for %-9s expect %-5s got %s\n", status, c.ID, c.User, c.Action, c.Resource, c.ActingOrg, c.Expect, actual)
	}
	if failed > 0 {
		fmt.Printf("\n%d check(s) did not match. Run `make reset`, then check again.\n", failed)
		return 1
	}
	if !st.ActingOrgRule {
		fmt.Println("\nThe checks match, but the custom rules aren't confirmed loaded (see above).")
		return 1
	}
	fmt.Println("\nAll checks match.")
	return 0
}

func yesNo(ok bool) string {
	if ok {
		return "yes"
	}
	return "NO"
}

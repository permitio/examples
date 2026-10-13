// Command apply-policy installs this demo's custom rules in the GitOps environment branch: the custom
// Rego in policy/custom.rego becomes custom/root.rego (stamped with a new version when it changes),
// and root.rego's allow rules require it. Then it restarts the PDP so it loads the policy at once
// (Permit polls customer repos; a restart is faster than waiting). Changes nothing in Git when both
// are already in place.
//
//	make apply-policy
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"fleetops/internal/pdp"
	"fleetops/internal/settings"
	"fleetops/policy"
)

func main() {
	os.Exit(run())
}

func run() int {
	s := settings.MustLoad()
	repo := filepath.Join(s.DemoDir, "policy-repo")
	git := func(args ...string) error {
		out, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return nil
	}
	fail := func(err error) int {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	if err := git("pull", "--ff-only", "-q"); err != nil {
		return fail(err)
	}

	changed := false
	customPath := filepath.Join(repo, "custom", "root.rego")
	installed, _ := os.ReadFile(customPath)
	version := policy.Version(string(installed))
	if !policy.SameRules(string(installed)) {
		version = time.Now().UTC().Format("2006-01-02T15:04:05Z")
		if err := os.WriteFile(customPath, []byte(policy.Custom(version)), 0o644); err != nil {
			return fail(err)
		}
		fmt.Printf("custom/root.rego: installed the custom rules, policy version %s.\n", version)
		changed = true
	}

	rootPath := filepath.Join(repo, "root.rego")
	data, err := os.ReadFile(rootPath)
	if err != nil {
		return fail(err)
	}
	root, err := patchRoot(string(data))
	if err != nil {
		return fail(err)
	}
	if root != string(data) {
		if err := os.WriteFile(rootPath, []byte(root), 0o644); err != nil {
			return fail(err)
		}
		fmt.Println("root.rego: every allow now requires the custom rules.")
		changed = true
	}

	if changed {
		for _, args := range [][]string{
			{"add", "custom/root.rego", "root.rego"},
			{"commit", "-q", "-m", "Install the custom rules (tenant isolation and fleet rules for the demo's scenarios) and require them in root.rego"},
			{"push", "-q", "origin", "HEAD"},
		} {
			if err := git(args...); err != nil {
				return fail(err)
			}
		}
		fmt.Println("Pushed to the environment branch.")
	} else {
		fmt.Println("The custom rules are already installed and required.")
	}

	fmt.Println("Restarting the PDP so it loads the policy now…")
	client := pdp.New(s, settings.Client(s))
	if err := client.Restart(); err != nil {
		return fail(err)
	}
	// Permit fetches the push from Git on its own schedule, so the restarted PDP may first load the
	// previous rules: wait for this version.
	for range 60 {
		time.Sleep(3 * time.Second)
		if st := client.Status(); st.PDP && st.ActingOrgRule && client.CustomPolicyVersion() == version {
			fmt.Printf("The PDP has loaded the custom rules, version %s. Run `make verify`.\n", version)
			return 0
		}
	}
	return fail(fmt.Errorf("the PDP has not loaded custom rules version %s after three minutes; run `make apply-policy` again, or check `docker compose logs pdp` in the demo folder", version))
}

var debugResult = regexp.MustCompile(`(?m)^(\s*)result := .*debug\.debug.*$`)

// patchRoot rewrites root.rego's allow rules (everything between `default allow := false` and
// `allowing_sources :=`) and the debug result line. It works on Permit's generated file and on an
// already patched one alike.
func patchRoot(root string) (string, error) {
	const marker = "default allow := false\n"
	start, end := strings.Index(root, marker), strings.Index(root, "\nallowing_sources :=")
	if start < 0 || end < start {
		return "", fmt.Errorf("root.rego doesn't have the expected layout (`default allow := false` ... `allowing_sources :=`); edit it by hand: every allow rule must also require custom.acting_org_ok and custom.fleet_rules_ok")
	}
	root = root[:start+len(marker)] + "\n" + policy.RootAllow + "\n" + root[end:]
	if !debugResult.MatchString(root) {
		return "", fmt.Errorf("root.rego has no `result := ... debug.debug` line to extend")
	}
	return debugResult.ReplaceAllString(root, "${1}"+policy.RootDebug), nil
}

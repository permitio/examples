package settings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeEnv(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func shell(vars map[string]string) func(string) (string, bool) {
	return func(name string) (string, bool) {
		v, ok := vars[name]
		return v, ok
	}
}

func TestLoadUsesOnlyTheKeyInEnvFile(t *testing.T) {
	dir := t.TempDir()
	writeEnv(t, dir, "PERMIT_API_KEY=permit_key_demo\nPERMIT_ENV=demo\n")
	t.Run("a different key in the shell is an error", func(t *testing.T) {
		_, err := load([]string{dir}, shell(map[string]string{"PERMIT_API_KEY": "permit_key_other"}))
		if err == nil || !strings.Contains(err.Error(), "unset PERMIT_API_KEY") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("the same key in the shell is fine", func(t *testing.T) {
		s, err := load([]string{dir}, shell(map[string]string{"PERMIT_API_KEY": "permit_key_demo"}))
		if err != nil || s.APIKey != "permit_key_demo" {
			t.Fatalf("got %+v, %v", s, err)
		}
	})
	t.Run("a key only in the shell isn't used", func(t *testing.T) {
		empty := t.TempDir()
		writeEnv(t, empty, "PERMIT_ENV=demo\n")
		if _, err := load([]string{empty}, shell(map[string]string{"PERMIT_API_KEY": "permit_key_other"})); err == nil {
			t.Fatal("no error without a key in .env")
		}
	})
	t.Run("other variables: the shell wins", func(t *testing.T) {
		s, err := load([]string{dir}, shell(map[string]string{"PERMIT_ENV": "from-shell", "PORT": "4000"}))
		if err != nil || s.Env != "from-shell" || s.Port != "4000" || s.PDPURL != "http://localhost:7766" {
			t.Fatalf("got %+v, %v", s, err)
		}
	})
}

// A .env in a parent folder is never used: the key there may belong to any environment.
func TestLoadDoesNotLookInParentFolders(t *testing.T) {
	parent := t.TempDir()
	writeEnv(t, parent, "PERMIT_API_KEY=permit_key_parent\n")
	child := filepath.Join(parent, "demo")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if s, err := load([]string{child}, shell(nil)); err == nil {
		t.Fatalf("loaded %s from a parent folder", s.DemoDir)
	}
}

// The parser reads .env the way Docker Compose v2 does (checked with `docker compose config`), so the
// app and the PDP get the same key.
func TestEnvValue(t *testing.T) {
	for in, want := range map[string]string{
		`permit_key_abc`:          "permit_key_abc",
		`"permit_key_abc"`:        "permit_key_abc",
		`'permit_key_abc'`:        "permit_key_abc",
		`3000 # app port`:         "3000",
		"3000\t# app port":        "3000\t# app port",
		`"a # b"`:                 "a # b",
		`a#b`:                     "a#b",
		`"unclosed`:               `"unclosed`,
		`https://api.permit.io`:   "https://api.permit.io",
		`"quoted" # and a remark`: "quoted",
		``:                        "",
	} {
		if got := envValue(in); got != want {
			t.Errorf("envValue(%q) = %q, want %q", in, got, want)
		}
	}
}

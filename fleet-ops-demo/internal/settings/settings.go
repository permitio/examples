// Package settings reads .env and builds the one Permit client the app and the commands share.
//
// The .env file is looked up in the working directory, then next to the program and in the folder
// above it (bin/), never further up: a stray .env in a parent folder must not supply a key.
package settings

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	permitconfig "github.com/permitio/permit-golang/pkg/config"
	"github.com/permitio/permit-golang/pkg/permit"
	"go.uber.org/zap"
)

type Settings struct {
	APIKey  string
	APIURL  string
	PDPURL  string
	OPAURL  string
	Project string
	Env     string
	Port    string
	// DemoDir holds .env, docker-compose.yml and policy-repo/.
	DemoDir string
}

// Load reads .env and returns the settings. A variable set in the shell wins over .env, except
// PERMIT_API_KEY: only the key in .env is used, and a different one in the shell is an error, so a
// key exported for another environment can't make `make setup` or `make reset` change that one.
func Load() (Settings, error) {
	var dirs []string
	if wd, err := os.Getwd(); err == nil {
		dirs = append(dirs, wd)
	}
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Dir(exe), filepath.Dir(filepath.Dir(exe)))
	}
	return load(dirs, os.LookupEnv)
}

// load reads the first .env found in dirs; env looks up the shell's variables.
func load(dirs []string, env func(string) (string, bool)) (Settings, error) {
	envFile, err := find(".env", dirs)
	if err != nil {
		return Settings{}, err
	}
	file, err := readEnvFile(envFile)
	if err != nil {
		return Settings{}, fmt.Errorf("reading %s: %w", envFile, err)
	}
	key := file["PERMIT_API_KEY"]
	if key == "" {
		return Settings{}, fmt.Errorf("PERMIT_API_KEY is not set in %s", envFile)
	}
	if shell, _ := env("PERMIT_API_KEY"); shell != "" && shell != key {
		return Settings{}, fmt.Errorf("PERMIT_API_KEY in your shell differs from the one in %s; the demo uses only the key in .env, so run `unset PERMIT_API_KEY` and try again", envFile)
	}
	get := func(name, fallback string) string {
		if v, _ := env(name); v != "" {
			return v
		}
		if v := file[name]; v != "" {
			return v
		}
		return fallback
	}
	return Settings{
		APIKey:  key,
		APIURL:  get("PERMIT_API_URL", "https://api.permit.io"),
		PDPURL:  get("PDP_URL", "http://localhost:7766"),
		OPAURL:  get("OPA_URL", "http://localhost:8181"),
		Project: get("PERMIT_PROJECT", ""),
		Env:     get("PERMIT_ENV", ""),
		Port:    get("PORT", "3000"),
		DemoDir: filepath.Dir(envFile),
	}, nil
}

// MustLoad is Load for commands: it exits with the error.
func MustLoad() Settings {
	s, err := Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return s
}

// Client is the Permit SDK client. The environment-scoped key lets the SDK resolve the project and
// environment by itself. The SDK's own logger is silenced; callers report errors.
func Client(s Settings) *permit.Client {
	cfg := permitconfig.NewConfigBuilder(s.APIKey).
		WithPdpUrl(s.PDPURL).
		WithApiUrl(s.APIURL).
		WithLogger(zap.NewNop()).
		Build()
	return permit.New(cfg)
}

// find returns the first dirs/name that exists.
func find(name string, dirs []string) (string, error) {
	for _, dir := range dirs {
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("no %s found in %s", name, strings.Join(dirs, " or "))
}

// readEnvFile parses KEY=value lines the way Docker Compose reads the same file for the PDP: blank
// lines and # comments are skipped, a value in matching single or double quotes is taken without
// them, and an unquoted value ends at a " #" comment.
func readEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	values := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		values[strings.TrimSpace(key)] = envValue(strings.TrimSpace(value))
	}
	return values, sc.Err()
}

func envValue(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
		if end := strings.IndexByte(v[1:], v[0]); end >= 0 {
			return v[1 : 1+end]
		}
	}
	for n := 1; n < len(v); n++ {
		if v[n] == '#' && v[n-1] == ' ' { // as Compose: a tab before # doesn't start a comment
			return strings.TrimSpace(v[:n])
		}
	}
	return v
}

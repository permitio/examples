// Package settings reads .env and builds the one Permit client the app and the commands share.
//
// The .env file is looked up in the working directory and then in each parent, so every command
// finds the demo folder's .env without a copy of the key.
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
	// DemoDir holds .env, docker-compose.yml and policy-repo/.
	DemoDir string
}

// Load reads .env (variables already set in the environment win) and returns the settings.
func Load() (Settings, error) {
	envFile, err := findUp(".env")
	if err != nil {
		return Settings{}, err
	}
	if err := loadEnvFile(envFile); err != nil {
		return Settings{}, err
	}
	s := Settings{
		APIKey:  os.Getenv("PERMIT_API_KEY"),
		APIURL:  getenv("PERMIT_API_URL", "https://api.permit.io"),
		PDPURL:  getenv("PDP_URL", "http://localhost:7766"),
		OPAURL:  getenv("OPA_URL", "http://localhost:8181"),
		Project: os.Getenv("PERMIT_PROJECT"),
		Env:     os.Getenv("PERMIT_ENV"),
		DemoDir: filepath.Dir(envFile),
	}
	if s.APIKey == "" {
		return Settings{}, fmt.Errorf("PERMIT_API_KEY is not set in %s", envFile)
	}
	return s, nil
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

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// findUp looks for name in the working directory and each parent, then likewise from the program's
// own folder (for a built server started from elsewhere).
func findUp(name string) (string, error) {
	var starts []string
	if wd, err := os.Getwd(); err == nil {
		starts = append(starts, wd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, dir := range starts {
		for {
			p := filepath.Join(dir, name)
			if _, err := os.Stat(p); err == nil {
				return p, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("no %s found in this folder or above it", name)
}

func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
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
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if _, set := os.LookupEnv(key); !set {
			os.Setenv(key, value)
		}
	}
	return sc.Err()
}

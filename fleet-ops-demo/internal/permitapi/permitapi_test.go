package permitapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	permiterrors "github.com/permitio/permit-golang/pkg/errors"
)

func TestStatus(t *testing.T) {
	for name, tc := range map[string]struct {
		err  error
		want int
	}{
		"HTTPError":         {&HTTPError{Method: "GET", Path: "/v2/x", StatusCode: 429, Status: "429 Too Many Requests"}, 429},
		"wrapped HTTPError": {fmt.Errorf("listing set_rules: %w", &HTTPError{StatusCode: 404, Status: "404 Not Found"}), 404},
		"PermitError":       {permiterrors.NewPermitConflictError(&http.Response{StatusCode: 409, Body: http.NoBody}), 409},
		"no status":         {errors.New("connection refused"), 0},
	} {
		t.Run(name, func(t *testing.T) {
			if got := Status(tc.err); got != tc.want {
				t.Errorf("got %d, want %d", got, tc.want)
			}
		})
	}
}

func noBackoff(t *testing.T) {
	t.Helper()
	saved := backoff
	backoff = func(int) time.Duration { return 0 }
	t.Cleanup(func() { backoff = saved })
}

// A raw call's 429 is retried like an SDK call's, and its allowed statuses count as success.
func TestCallReadsHTTPError(t *testing.T) {
	noBackoff(t)
	attempts := 0
	err := Call(func(context.Context) error {
		if attempts++; attempts < 3 {
			return fmt.Errorf("listing set_rules: %w", &HTTPError{StatusCode: 429, Status: "429 Too Many Requests"})
		}
		return nil
	})
	if err != nil || attempts != 3 {
		t.Fatalf("got %v after %d attempts, want success on the third", err, attempts)
	}
	if err := Call(func(context.Context) error { return &HTTPError{StatusCode: 404, Status: "404 Not Found"} }, 404); err != nil {
		t.Fatalf("an allowed 404: %v", err)
	}
	attempts = 0
	err = Call(func(context.Context) error {
		attempts++
		return &HTTPError{StatusCode: 500, Status: "500 Internal Server Error"}
	})
	if Status(err) != 500 || attempts != 1 {
		t.Fatalf("a 500: got %v after %d attempts, want it returned at once", err, attempts)
	}
}

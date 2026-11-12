// Package permitapi has small helpers around the SDK's REST client: a timeout on every call, retry
// when rate-limited or timed out, treat "already exists" as a result, and read every page of a list.
package permitapi

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	permiterrors "github.com/permitio/permit-golang/pkg/errors"
	"github.com/permitio/permit-golang/pkg/openapi"
)

const (
	perPage = 100
	// callTimeout bounds each API call. The SDK's facts clients (resource instances, relationship
	// tuples, role assignments) have no HTTP timeout of their own, so a stalled response would
	// otherwise block forever.
	callTimeout = 20 * time.Second
)

// HTTPError is a non-200 answer to a request made without the SDK: a raw list call, or a PDP or OPA
// request. It carries the status so Status, and so Call's retries and allowed statuses, see it.
type HTTPError struct {
	Method, Path string
	StatusCode   int
	Status       string // the status line, e.g. "429 Too Many Requests"
}

func (e *HTTPError) Error() string { return fmt.Sprintf("%s %s: %s", e.Method, e.Path, e.Status) }

// Status is the HTTP status of a failed call, or 0 when the error carries none. Most SDK methods
// return a PermitError; a few (resource attributes, for one) pass on the generated client's error,
// whose message is the status line, e.g. "409 Conflict"; calls made without the SDK return HTTPError.
func Status(err error) int {
	if pe, ok := errors.AsType[permiterrors.PermitError](err); ok {
		return pe.StatusCode
	}
	if he, ok := errors.AsType[*HTTPError](err); ok {
		return he.StatusCode
	}
	if oe, ok := errors.AsType[*openapi.GenericOpenAPIError](err); ok {
		code, _ := strconv.Atoi(strings.SplitN(oe.Error(), " ", 2)[0])
		return code
	}
	return 0
}

// backoff is the wait before retry number attempt+1: 2 s, 4 s, ... 64 s.
var backoff = func(attempt int) time.Duration { return time.Duration(2<<attempt) * time.Second }

func timedOut(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), context.DeadlineExceeded.Error())
}

// Call runs one API call with a timeout, retrying 429s and timeouts with backoff (2 s, 4 s, ... six
// retries). An error whose status is in allow returns nil instead.
func Call(fn func(ctx context.Context) error, allow ...int) error {
	for attempt := 0; ; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
		err := fn(ctx)
		cancel()
		if err == nil {
			return nil
		}
		status := Status(err)
		if slices.Contains(allow, status) {
			return nil
		}
		if (status == 429 || timedOut(err)) && attempt < 6 {
			time.Sleep(backoff(attempt))
			continue
		}
		return err
	}
}

// Ensure creates the object. If it already exists (409), it runs update when given. Reports whether
// the object was created.
func Ensure(create, update func(ctx context.Context) error) (bool, error) {
	err := Call(create)
	if err == nil {
		return true, nil
	}
	if Status(err) != 409 {
		return false, err
	}
	if update != nil {
		return false, Call(update)
	}
	return false, nil
}

// ListAll reads every page of an SDK list method.
func ListAll[T any](list func(ctx context.Context, page, perPage int) ([]T, error)) ([]T, error) {
	var all []T
	for page := 1; ; page++ {
		var batch []T
		err := Call(func(ctx context.Context) error {
			var err error
			batch, err = list(ctx, page, perPage)
			return err
		})
		if err != nil {
			return nil, err
		}
		all = append(all, batch...)
		if len(batch) < perPage {
			return all, nil
		}
	}
}

// Deref turns the SDK's *[]T list results into []T.
func Deref[T any](items *[]T, err error) ([]T, error) {
	if err != nil || items == nil {
		return nil, err
	}
	return *items, nil
}

// CreateAgain creates an object that was just deleted with the same key, retrying while Permit still
// reports the old one (409).
func CreateAgain(create func(ctx context.Context) error) error {
	var err error
	for range 6 {
		if err = Call(create); Status(err) != 409 {
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
	return err
}

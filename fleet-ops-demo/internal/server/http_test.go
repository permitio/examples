package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Another web site open in the presenter's browser must not drive the app: no cross-site write, and
// no reading answers through a host name rebound to 127.0.0.1.
func TestOnlyThisMachinesPageIsServed(t *testing.T) {
	dispatch := `{"user":"sam","org":"acme","action":"dispatch","lane":"from another site"}`
	for name, tc := range map[string]struct {
		method, url, body string
		header            map[string]string
		want              int
	}{
		"the page's own POST": {
			"POST", "http://localhost:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "application/json", "Origin": "http://localhost:3000", "Sec-Fetch-Site": "same-origin"}, 200,
		},
		"a POST without browser headers (curl)": {
			"POST", "http://127.0.0.1:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "application/json"}, 200,
		},
		"a page load at 127.0.0.1": {"GET", "http://127.0.0.1:3000/api/meta", "", nil, 200},
		"a cross-site text/plain POST (no preflight)": {
			"POST", "http://localhost:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "text/plain;charset=UTF-8", "Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"}, 403,
		},
		"a cross-site JSON POST": {
			"POST", "http://localhost:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "application/json", "Origin": "https://attacker.example"}, 403,
		},
		"a rebound host name, reading": {"GET", "http://attacker.example:3000/api/people?user=olivia&org=acme", "", nil, 403},
		"a rebound host name, writing": {
			"POST", "http://attacker.example:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "application/json", "Origin": "http://attacker.example:3000", "Sec-Fetch-Site": "same-origin"}, 403,
		},
		"the page's own POST, not JSON": {
			"POST", "http://localhost:3000/api/trucks/acme-dal-01/act", dispatch,
			map[string]string{"Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin"}, 415,
		},
	} {
		t.Run(name, func(t *testing.T) {
			a, h := newTestApp(t, &fake{})
			req := httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body))
			for k, v := range tc.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
			dispatched := len(a.history["asset:acme-dal-01"]) > 0
			if wrote := tc.method == http.MethodPost && tc.want == 200; dispatched != wrote {
				t.Errorf("dispatched = %v, want %v", dispatched, wrote)
			}
		})
	}
}

package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"

	"fleetops/internal/model"
)

// Handler serves the API and the page (files from web).
func (a *App) Handler(web fs.FS, project, env string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/meta", func(w http.ResponseWriter, _ *http.Request) {
		type person struct {
			Key   string `json:"key"`
			Name  string `json:"name"`
			Title string `json:"title"`
			Org   string `json:"org"` // employer, for grouping the sign-in menu
		}
		users := make([]person, len(model.Users))
		for n, u := range model.Users {
			users[n] = person{Key: u.Key, Name: model.FullName(u.Key), Title: u.Title, Org: model.OrgName(u.HomeTenant)}
		}
		writeJSON(w, http.StatusOK, obj{"users": users, "project": project, "env": env})
	})
	mux.HandleFunc("GET /api/orgs", func(w http.ResponseWriter, req *http.Request) {
		a.mu.RLock()
		defer a.mu.RUnlock()
		writeJSON(w, http.StatusOK, obj{"orgs": a.memberships(req.URL.Query().Get("user"))})
	})
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, a.pdp.Status())
	})
	mux.HandleFunc("GET /api/fleet", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.fleet(user, org)
	}))
	mux.HandleFunc("GET /api/trucks/{key}", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.truckPage(user, org, req.PathValue("key"))
	}))
	mux.HandleFunc("GET /api/sites/{key}", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.sitePage(user, org, req.PathValue("key"))
	}))
	mux.HandleFunc("POST /api/trucks/{key}/act", a.write(func(req *http.Request, body actBody) (obj, error) {
		return a.truckAction(body, req.PathValue("key"))
	}))
	mux.HandleFunc("GET /api/people", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.peoplePage(user, org)
	}))
	mux.HandleFunc("POST /api/people/{key}/act", a.write(func(req *http.Request, body actBody) (obj, error) {
		return a.personAction(body, req.PathValue("key"))
	}))
	mux.HandleFunc("GET /api/access", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.accessPage(user, org)
	}))
	mux.HandleFunc("POST /api/access/act", a.write(func(req *http.Request, body actBody) (obj, error) {
		return a.accessAction(body)
	}))
	mux.HandleFunc("GET /api/organizations", a.read(func(req *http.Request, user, org string) (obj, error) {
		return a.orgsPage(user)
	}))
	mux.HandleFunc("POST /api/organizations/{key}/act", a.write(func(req *http.Request, body actBody) (obj, error) {
		return a.orgAction(body, req.PathValue("key"))
	}))
	mux.Handle("/", http.FileServerFS(web))
	return mux
}

// recovered turns a panic in a handler into a 502 with the error, so the page shows it.
func recovered(w http.ResponseWriter, req *http.Request) {
	if p := recover(); p != nil {
		log.Printf("%s %s: panic: %v", req.Method, req.URL.Path, p)
		writeJSON(w, http.StatusBadGateway, obj{"error": fmt.Sprintf("internal error: %v", p)})
	}
}

// read serves a page: it reads the app's state while it asks the PDP.
func (a *App) read(page func(req *http.Request, user, org string) (obj, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		defer recovered(w, req)
		a.mu.RLock()
		defer a.mu.RUnlock()
		q := req.URL.Query()
		respond(w, req)(page(req, q.Get("user"), q.Get("org")))
	}
}

// write serves an action: it holds the app's state for the whole action, checks and writes included.
func (a *App) write(action func(req *http.Request, body actBody) (obj, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		defer recovered(w, req)
		var body actBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, obj{"error": "The request body must be JSON."})
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		respond(w, req)(action(req, body))
	}
}

// respond writes the result, or the error as {"error": ...} with status 502, as the page expects.
func respond(w http.ResponseWriter, req *http.Request) func(obj, error) {
	return func(result obj, err error) {
		if err != nil {
			log.Printf("%s %s: %v", req.Method, req.URL.Path, err)
			writeJSON(w, http.StatusBadGateway, obj{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("writing JSON: %v", err)
	}
}

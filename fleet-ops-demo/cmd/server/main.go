// Command server runs Fleet Ops on http://localhost:3000 (PORT in .env changes it).
//
//	make start
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"

	"fleetops/internal/pdp"
	"fleetops/internal/server"
	"fleetops/internal/settings"
	"fleetops/web"
)

func main() {
	s := settings.MustLoad()
	app := server.New(pdp.New(s, settings.Client(s)))
	if err := app.Load(); err != nil {
		log.Fatalf("loading authorization data from Permit: %v", err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	addr := "127.0.0.1:" + port
	fmt.Printf("Fleet Ops (Go SDK) on http://localhost:%s, project %s, environment %s\n", port, s.Project, s.Env)
	log.Fatal(http.ListenAndServe(addr, app.Handler(web.Files, s.Project, s.Env)))
}

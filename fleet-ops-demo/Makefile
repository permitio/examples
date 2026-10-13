# Fleet Ops: a multi-tenant fleet app on the Permit Go SDK. Needs Docker and Go; `make test` also
# needs the opa CLI. Every command reads .env in this folder (copy .env.example).
.PHONY: pdp setup reset build start verify apply-policy test

pdp:           ## start the local container PDP (port 7766)
	docker compose --env-file .env up -d pdp

setup:         ## make Permit's schema match the code, then restore the seed data
	go run ./cmd/sync

reset:         ## restore the seeded data in Permit; restart the app afterwards
	go run ./cmd/sync --reset

build:         ## build the server into bin/
	go build -o bin/fleetops-server ./cmd/server

start: build   ## run the app on http://localhost:3000
	./bin/fleetops-server

verify:        ## pre-flight: PDP up, custom rules loaded, expected decisions
	go run ./cmd/verify

apply-policy:  ## install the custom rules in the GitOps branch and restart the PDP
	go run ./cmd/apply-policy

test:          ## unit tests: Go, and the custom Rego
	go test ./...
	opa test --v0-compatible policy/

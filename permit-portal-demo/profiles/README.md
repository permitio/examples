# Profiles

A profile says which Permit environment the demo talks to. `bin/demo <command> <profile>` loads `profiles/<profile>.env`. The profile is required: `bin/demo` refuses to run without one.

Create one file per Permit environment you want to use, for example `profiles/demo.env`:

```
PERMIT_API_URL=https://api.permit.io
PERMIT_API_KEY=<that environment's API key>
```

- **Use an environment made for the demo.** `bin/demo seed` creates its whole policy, and `bin/demo reset` rewrites its data, so don't point a profile at an environment you use for anything else.
- **`PERMIT_API_KEY`** is that environment's API key, from the Permit dashboard.
- **`PERMIT_APP_URL`** is optional: the dashboard address that the portal's Evidence tab links to. It defaults to `https://app.permit.io`.

The PDP uses the same URL as its control plane: `docker-compose.yml` passes `PERMIT_API_URL` to it as `PDP_CONTROL_PLANE`.

**API keys are never committed.** `profiles/*.env` is gitignored, and `.dockerignore` keeps this folder out of the images. Keep keys out of code, logs and chat as well.

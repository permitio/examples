"""Save what a Terraform change is about to delete in Permit, and put it back after a rollback.

Permit has no undo: deleting a role deletes every assignment of it, and deleting a relation deletes its
relationship tuples. `git revert` brings the schema back, not that data. So before each apply, CI runs

    permit_snapshot.py save <plan.json> <snapshot.json>

which reads the plan (`terraform show -json`) and saves the role assignments of every role the plan
destroys and the tuples of every relation it destroys. After a revert is applied, CI runs

    permit_snapshot.py restore <snapshot.json>

which puts back exactly what that snapshot saved, skipping people or instances that no longer exist and
anything already there. Reads PERMIT_API_URL, PERMIT_PROJECT, PERMIT_ENV and PERMIT_API_KEY."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = (os.environ.get("PERMIT_API_URL") or "https://api.permit.io").rstrip("/")
PROJECT, ENV, KEY = os.environ["PERMIT_PROJECT"], os.environ["PERMIT_ENV"], os.environ["PERMIT_API_KEY"]
FACTS = f"{API}/v2/facts/{PROJECT}/{ENV}"


def call(method, url, body=None, missing_ok=False):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(6):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 404 and missing_ok:
                return None
            if e.code == 429 and attempt < 5:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"{method} {url}: HTTP {e.code} {e.read().decode()[:300]}")
    raise SystemExit(f"{method} {url}: gave up after retries")


def list_all(path, **params):
    rows, page = [], 1
    while True:
        query = urllib.parse.urlencode({**params, "page": page, "per_page": 100})
        batch = call("GET", f"{FACTS}/{path}?{query}") or []
        rows += batch
        if len(batch) < 100:
            return rows
        page += 1


def destroyed(plan, kind):
    """The `before` state of every resource of this type that the plan deletes (or replaces)."""
    return [c["change"]["before"] for c in plan.get("resource_changes", [])
            if c["type"] == kind and "delete" in c["change"]["actions"]]


def save(plan_path, out_path):
    plan = json.load(open(plan_path))
    assignments, tuples = [], []
    for role in destroyed(plan, "permitio_role"):
        resource = role.get("resource")
        for ra in list_all("role_assignments", role=role["key"]):
            instance = ra.get("resource_instance") or ""
            if (resource and instance.startswith(f"{resource}:")) or (not resource and not instance):
                assignments.append({k: ra.get(k) for k in ("user", "role", "tenant", "resource_instance") if ra.get(k)})
    for rel in destroyed(plan, "permitio_relation"):
        for t in list_all("relationship_tuples", relation=rel["key"], object_type=rel["object_resource"]):
            if t["subject"].startswith(f"{rel['subject_resource']}:"):
                tuples.append({k: t[k] for k in ("subject", "relation", "object", "tenant")})
    if not assignments and not tuples:
        print("Nothing to save: the plan deletes no role assignments or relationships.")
        return
    snapshot = {"environment": ENV, "commit": os.environ.get("GITHUB_SHA", ""), "role_assignments": assignments,
                "tuples": tuples}
    json.dump(snapshot, open(out_path, "w"), indent=1)
    print(f"Saved what this change deletes in {ENV}: {len(assignments)} role assignments, {len(tuples)} relationships.")
    for ra in assignments:
        print(f"  {ra['user']} is {ra['role']} on {ra.get('resource_instance') or ra['tenant']}")


def restore(path):
    snap = json.load(open(path))
    users, instances, restored, skipped = {}, {}, [], 0

    def exists(cache, url):
        if url not in cache:
            cache[url] = call("GET", url, missing_ok=True) is not None
        return cache[url]

    have = {(a["user"], a["role"], a["tenant"], a.get("resource_instance") or "")
            for role in {ra["role"] for ra in snap["role_assignments"]} for a in list_all("role_assignments", role=role)}
    todo = []
    for ra in snap["role_assignments"]:
        key = (ra["user"], ra["role"], ra["tenant"], ra.get("resource_instance") or "")
        instance = ra.get("resource_instance")
        if key in have:
            continue
        if not exists(users, f"{FACTS}/users/{urllib.parse.quote(ra['user'])}") or (
                instance and not exists(instances, f"{FACTS}/resource_instances/{urllib.parse.quote(instance)}")):
            skipped += 1
            continue
        todo.append(ra)
    if todo:
        call("POST", f"{FACTS}/role_assignments/bulk", todo)
        restored += [f"{ra['user']} is {ra['role']} on {ra.get('resource_instance') or ra['tenant']}" for ra in todo]
    tuples = [t for t in snap.get("tuples", [])
              if exists(instances, f"{FACTS}/resource_instances/{urllib.parse.quote(t['subject'])}")
              and exists(instances, f"{FACTS}/resource_instances/{urllib.parse.quote(t['object'])}")]
    skipped += len(snap.get("tuples", [])) - len(tuples)
    if tuples:
        call("POST", f"{FACTS}/relationship_tuples/bulk", {"operations": tuples})
    print(f"Restored in {ENV}: {len(todo)} role assignments, {len(tuples)} relationships; "
          f"{skipped} skipped because their person or instance no longer exists.")
    for line in restored:
        print(f"  {line}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["save"] and len(sys.argv) == 4:
        save(sys.argv[2], sys.argv[3])
    elif sys.argv[1:2] == ["restore"] and len(sys.argv) == 3:
        restore(sys.argv[2])
    else:
        raise SystemExit(__doc__)

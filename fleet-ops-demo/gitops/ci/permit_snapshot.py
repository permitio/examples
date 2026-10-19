"""Save what a Terraform change is about to delete in Permit, and put it back after a rollback.

Permit has no undo: deleting a role deletes every assignment of it, and deleting a relation deletes its
relationship tuples. `git revert` brings the schema back, not that data. So before each apply, CI runs

    permit_snapshot.py save <plan.json> <snapshot.json>

which reads the plan (`terraform show -json`) and saves the role assignments of every role the plan
destroys and the tuples of every relation it destroys. If the plan destroys a resource type that still
has instances, it stops the apply instead: Permit would delete those instances too, and no snapshot can
bring them back. After a revert is applied, CI runs

    permit_snapshot.py restore <snapshot.json>

which puts back what the snapshot saved. It leaves out what is already there and what names a person or
instance that no longer exists, and lists what Permit refuses (say, an assignment in a deleted tenant).

Reads PERMIT_PROJECT, PERMIT_ENV, PERMIT_API_KEY and, if set, PERMIT_API_URL. It prints counts, never who
holds what: the snapshot file has that, and more people can usually read a CI log than the file."""
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

Row = dict[str, Any]

RETRIES = 5  # after the first try, waiting 1, 2, 4, 8 and 16 s, or as long as a Retry-After header asks
RETRY_STATUSES = {429, 502, 503, 504}
PAGE_SIZE = 100  # the most rows Permit's list routes return per page to an API key
BULK_SIZE = 1000  # the most operations Permit's bulk routes take in one call


class PermitError(Exception):
    """A call that Permit answered with an error, or never answered, after any retries."""

    def __init__(self, message: str, status: int = 0, detail: str = "") -> None:
        super().__init__(message)
        self.status = status  # 0 when no HTTP answer came back at all
        self.detail = detail


class Facts:
    """Permit's facts API (users, instances, role assignments, relationships) for one environment."""

    def __init__(self, api_url: str, project: str, env: str, api_key: str) -> None:
        self.env = env
        self.base = f"{api_url}/v2/facts/{segment(project)}/{segment(env)}"
        self._api_key = api_key
        self._exists: dict[str, bool] = {}

    def call(self, method: str, path: str, *, params: dict[str, Any] | None = None, body: Any = None,
             missing_ok: bool = False) -> Any:
        """One API call, retried while Permit is busy or unreachable. With missing_ok, a 404 is None.

        Retrying a POST is safe here: both bulk routes this script posts to skip rows that already exist."""
        url = f"{self.base}/{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        data = None if body is None else json.dumps(body).encode()
        attempt = 0
        while True:
            request = urllib.request.Request(url, data=data, method=method, headers={
                "Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    raw = response.read()
                return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:  # before OSError, which HTTPError is a kind of
                if e.code == 404 and missing_ok:
                    return None
                if e.code not in RETRY_STATUSES or attempt == RETRIES:
                    detail = e.read().decode(errors="replace")[:300]
                    tries = f" (tried {attempt + 1} times)" if attempt else ""
                    message = f"{method} {url}: HTTP {e.code} {detail}{tries}"
                    raise PermitError(message, e.code, detail) from None
                wait = retry_after(e) or 2**attempt
            except (OSError, http.client.HTTPException) as e:  # no answer: refused, reset, timed out
                if attempt == RETRIES:
                    raise PermitError(f"{method} {url}: {e} (tried {attempt + 1} times)") from None
                wait = 2**attempt
            time.sleep(wait)
            attempt += 1

    def list_all(self, path: str, **filters: str) -> list[Row]:
        rows: list[Row] = []
        page = 1
        while True:
            batch = self.call("GET", path, params={**filters, "page": page, "per_page": PAGE_SIZE}) or []
            rows += batch
            if len(batch) < PAGE_SIZE:
                return rows
            page += 1

    def exists(self, path: str) -> bool:
        if path not in self._exists:
            self._exists[path] = self.call("GET", path, missing_ok=True) is not None
        return self._exists[path]

    def user_exists(self, key: str) -> bool:
        return self.exists(f"users/{segment(key)}")

    def instance_exists(self, key: str) -> bool:
        return self.exists(f"resource_instances/{segment(key)}")

    def post_in_bulk(self, path: str, items: list[Row], field: str | None = None
                     ) -> tuple[list[Row], list[tuple[Row, PermitError]]]:
        """POST items to a bulk route, BULK_SIZE at a time, as a list or as {field: list}.

        Permit rejects a whole call when one item in it is wrong (its tenant or role is gone, say). When
        it does, this posts that call's items one by one, so the rest still go in. Returns the items
        Permit took, and the ones it refused with its answer."""
        taken: list[Row] = []
        refused: list[tuple[Row, PermitError]] = []
        for start in range(0, len(items), BULK_SIZE):
            chunk = items[start:start + BULK_SIZE]
            try:
                self.call("POST", path, body=chunk if field is None else {field: chunk})
                taken += chunk
                continue
            except PermitError as e:
                if not is_refusal(e):
                    raise
            for item in chunk:
                try:
                    self.call("POST", path, body=[item] if field is None else {field: [item]})
                    taken.append(item)
                except PermitError as e:
                    if not is_refusal(e):
                        raise
                    refused.append((item, e))
        return taken, refused


def segment(key: str) -> str:
    """A key as one URL path segment."""
    return urllib.parse.quote(key, safe="")


def retry_after(error: urllib.error.HTTPError) -> int | None:
    """How many seconds a 429 or 503 asks to wait, if it says (at most a minute)."""
    value = error.headers.get("Retry-After") or ""
    return min(int(value), 60) if value.isdigit() else None


def is_refusal(error: PermitError) -> bool:
    """Permit answered, and said no to what was sent (not to the key, and not "slow down")."""
    return 400 <= error.status < 500 and error.status not in (401, 429)


def assignment_key(a: Row) -> tuple[str, str, str, str]:
    return a["user"], a["role"], a["tenant"], a.get("resource_instance") or ""


def tuple_key(t: Row) -> tuple[str, str, str]:
    return t["subject"], t["relation"], t["object"]


def tuple_types(t: Row) -> tuple[str, str, str]:
    """(relation, object type, subject type): the filters that list a relation's tuples."""
    return t["relation"], t["object"].split(":", 1)[0], t["subject"].split(":", 1)[0]


def describe_assignment(a: Row) -> str:
    """What an assignment grants, without saying who holds it."""
    instance = a.get("resource_instance")
    return f"role {a['role']} on {instance.split(':', 1)[0]}" if instance else f"tenant role {a['role']}"


def describe_tuple(t: Row) -> str:
    relation, object_type, subject_type = tuple_types(t)
    return f"relationship: {subject_type} is {relation} of {object_type}"


def print_counts(assignments: list[Row], tuples: list[Row]) -> None:
    counts = Counter(map(describe_assignment, assignments)) + Counter(map(describe_tuple, tuples))
    for what, n in sorted(counts.items()):
        print(f"  {n:6}  {what}")


def destroyed(plan: Row, kind: str) -> list[Row]:
    """The `before` state of every resource of this type that the plan deletes (or replaces)."""
    return [c["change"]["before"] for c in plan.get("resource_changes", [])
            if c["type"] == kind and "delete" in c["change"]["actions"]]


def save(facts: Facts, plan_path: str, snapshot_path: str) -> None:
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))

    # Deleting a resource type deletes its instances, every role assignment on them and every relationship
    # they are in. None of that shows in the plan, and a snapshot can't recreate the instances.
    for resource_type in destroyed(plan, "permitio_resource"):
        key = resource_type["key"]
        if facts.call("GET", "resource_instances", params={"resource": key, "per_page": 1}):
            sys.exit(f"This plan deletes the resource type {key!r}, which still has instances. "
                     "Permit would delete them with it, along with every role assignment on them and every "
                     "relationship they are in, and this script can't bring those back. If that is what you "
                     "mean, delete the instances first, then run this job again.")

    assignments: list[Row] = []
    for role in destroyed(plan, "permitio_role"):
        resource = role.get("resource")  # None for a tenant-level role
        for a in facts.list_all("role_assignments", role=role["key"]):
            # The role filter matches this key on every resource type and at tenant level: keep this role's.
            instance = a.get("resource_instance") or ""
            if instance.startswith(f"{resource}:") if resource else not instance:
                assignments.append({k: a[k] for k in ("user", "role", "tenant", "resource_instance")
                                    if a.get(k)})

    tuples: list[Row] = []
    for relation in destroyed(plan, "permitio_relation"):
        for t in facts.list_all("relationship_tuples", relation=relation["key"],
                                object_type=relation["object_resource"],
                                subject_type=relation["subject_resource"]):
            tuples.append({k: t[k] for k in ("subject", "relation", "object", "tenant")})

    # Written even when empty: then a later revert reads "nothing to restore" from the file, and a
    # missing file always means the snapshot is missing.
    snapshot = {"environment": facts.env, "commit": os.environ.get("GITHUB_SHA", ""),
                "role_assignments": assignments, "tuples": tuples}
    Path(snapshot_path).write_text(json.dumps(snapshot, indent=1), encoding="utf-8")
    if not assignments and not tuples:
        print("Nothing to save: the plan deletes no role assignments or relationships.")
        return
    print(f"Saved what this change deletes in {facts.env}: {len(assignments)} role assignments, "
          f"{len(tuples)} relationships.")
    print_counts(assignments, tuples)


def restore(facts: Facts, snapshot_path: str) -> None:
    snapshot = json.loads(Path(snapshot_path).read_text(encoding="utf-8"))
    if snapshot.get("environment") != facts.env:
        sys.exit(f"{snapshot_path} was saved in {snapshot.get('environment')!r}, not in {facts.env!r}.")
    assignments: list[Row] = snapshot.get("role_assignments", [])
    tuples: list[Row] = snapshot.get("tuples", [])
    if not assignments and not tuples:
        print("Nothing to restore: that change deleted no role assignments or relationships.")
        return

    # What is already there. These calls come first and take a 404 as an error, so a wrong project or
    # environment stops the restore here, instead of every later lookup reading it as "that person is gone".
    have: set[tuple[str, ...]] = set()
    for role in sorted({a["role"] for a in assignments}):
        have.update(assignment_key(a) for a in facts.list_all("role_assignments", role=role))
    for relation, object_type, subject_type in sorted({tuple_types(t) for t in tuples}):
        found = facts.list_all("relationship_tuples", relation=relation, object_type=object_type,
                               subject_type=subject_type)
        have.update(tuple_key(t) for t in found)
    new_assignments = [a for a in assignments if assignment_key(a) not in have]
    new_tuples = [t for t in tuples if tuple_key(t) not in have]

    # Leave out what names a person or instance that is gone.
    todo_assignments = [a for a in new_assignments if facts.user_exists(a["user"])
                        and (not a.get("resource_instance") or facts.instance_exists(a["resource_instance"]))]
    todo_tuples = [t for t in new_tuples
                   if facts.instance_exists(t["subject"]) and facts.instance_exists(t["object"])]

    assignments_in, assignments_refused = facts.post_in_bulk("role_assignments/bulk", todo_assignments)
    tuples_in, tuples_refused = facts.post_in_bulk("relationship_tuples/bulk", todo_tuples,
                                                   field="operations")

    print(f"Restored in {facts.env}: {len(assignments_in)} role assignments, {len(tuples_in)} relationships.")
    print_counts(assignments_in, tuples_in)
    already = len(assignments) - len(new_assignments) + len(tuples) - len(new_tuples)
    gone = len(new_assignments) - len(todo_assignments) + len(new_tuples) - len(todo_tuples)
    if already:
        print(f"Already there: {already}.")
    if gone:
        print(f"Left out because their person or instance no longer exists: {gone}.")

    # Permit's answer can name the person, so it is printed with their key taken out.
    refusals = Counter(
        [(f"{describe_assignment(a)} in tenant {a['tenant']}", e.status,
          e.detail.replace(a["user"], "<user>")) for a, e in assignments_refused]
        + [(describe_tuple(t), e.status, e.detail) for t, e in tuples_refused])
    if refusals:
        print(f"Refused by Permit: {len(assignments_refused) + len(tuples_refused)}.")
        for (what, status, detail), n in sorted(refusals.items()):
            print(f"  {n:6}  {what}: HTTP {status} {detail}")
    # A 404 or 409 means something the item names is gone or has moved, like a person who left: expected.
    if any(status not in (404, 409) for _, status, _ in refusals):
        sys.exit("Permit refused part of the snapshot for some other reason (listed above). "
                 "Everything else in it was restored.")


def setting(name: str) -> str:
    """A required environment variable. Empty counts as unset: an unset repository variable reaches a
    workflow as an empty string."""
    value = os.environ.get(name, "")
    if not value:
        sys.exit(f"{name} is not set.")
    return value


def main(args: list[str]) -> None:
    if not ((args[:1] == ["save"] and len(args) == 3) or (args[:1] == ["restore"] and len(args) == 2)):
        sys.exit(__doc__)
    api_url = (os.environ.get("PERMIT_API_URL") or "https://api.permit.io").rstrip("/")
    if not api_url.startswith(("https://", "http://")):
        sys.exit(f"PERMIT_API_URL must be an http(s) URL, not {api_url!r}.")
    facts = Facts(api_url, setting("PERMIT_PROJECT"), setting("PERMIT_ENV"), setting("PERMIT_API_KEY"))
    try:
        if args[0] == "save":
            save(facts, args[1], args[2])
        else:
            restore(facts, args[1])
    except PermitError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main(sys.argv[1:])

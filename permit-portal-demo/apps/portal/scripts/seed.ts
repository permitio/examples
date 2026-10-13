// Creates the whole Permit setup for a profile. Idempotent: a 409 on create means the object exists,
// and it is updated instead. Run: bin/demo seed <profile>
import { loadSeed } from '#src/server/model';
import { ensure, type Log, logged, scriptPermit, upsert, writeData } from '#scripts/lib/admin';
import { scriptEnv } from '#scripts/lib/env';
import { demoData, preflightData } from '#scripts/lib/fixtures';
import { isMain, type Result, runCli } from '#scripts/lib/report';
import { CONDITION_SET_RULES, CONDITION_SETS, RELATIONS, RESOURCE_ROLES, RESOURCES, TENANT_ROLES, USER_ATTRIBUTES } from '#scripts/policy';

const USER_RESOURCE = '__user';

async function main(): Promise<Result> {
  const env = scriptEnv();
  const permit = scriptPermit(env);
  const log: Log = (line) => console.log(line);
  // With no update, a 409 means "exists" and there is nothing to change.
  const write = (label: string, create: () => Promise<unknown>, update?: () => Promise<unknown>) =>
    logged(log, label, () => (update ? upsert(label, create, update) : ensure(label, create)));
  console.log(`Seeding profile ${env.profile} (${env.apiUrl})`);

  console.log('Policy model');
  // Permit write: api.resourceAttributes declares, on the user resource, the user attributes the policy reads.
  for (const a of USER_ATTRIBUTES) {
    await write(`user attribute ${a.key}`, () => permit.api.resourceAttributes.create(USER_RESOURCE, { key: a.key, type: a.type }),
      () => permit.api.resourceAttributes.update(USER_RESOURCE, a.key, { type: a.type }));
  }
  // Permit write: api.resources declares each resource type with its actions and attributes.
  for (const r of RESOURCES) {
    await write(`resource ${r.key}`, () => permit.api.resources.create(r),
      () => permit.api.resources.update(r.key, { name: r.name, actions: r.actions, ...(r.attributes === undefined ? {} : { attributes: r.attributes }) }));
  }
  // Permit write: api.resourceRelations declares that a shipment's parent is an EAN (the ReBAC link).
  for (const { resource, relation } of RELATIONS) {
    await write(`relation ${resource}.${relation.key} -> ${relation.subject_resource}`, () => permit.api.resourceRelations.create(resource, relation));
  }
  // Permit write: api.roles creates the tenant roles with their permissions.
  for (const role of TENANT_ROLES) {
    await write(`role ${role.key}`, () => permit.api.roles.create(role),
      () => permit.api.roles.update(role.key, { name: role.name, permissions: role.permissions }));
  }
  // Permit write: api.resourceRoles creates account_admin on EAN and on shipment. A shipment's account_admin is
  // derived from account_admin on its parent EAN (ReBAC).
  for (const { resource, role } of RESOURCE_ROLES) {
    await write(`resource role ${resource}#${role.key}`, () => permit.api.resourceRoles.create(resource, role),
      () => permit.api.resourceRoles.update(resource, role.key, { name: role.name, ...(role.permissions === undefined ? {} : { permissions: role.permissions }), ...(role.granted_to === undefined ? {} : { granted_to: role.granted_to }) }));
  }
  // Permit write: api.conditionSets creates the ABAC user sets and resource sets (ABAC Rules in the dashboard).
  for (const cs of CONDITION_SETS) {
    await write(`condition set ${cs.key}`, () => permit.api.conditionSets.create(cs),
      () => permit.api.conditionSets.update(cs.key, { name: cs.name, ...(cs.conditions === undefined ? {} : { conditions: cs.conditions }) }));
  }
  // Permit write: api.conditionSetRules grants each user set its permissions on a resource set (the Policy Editor).
  for (const rule of CONDITION_SET_RULES) {
    // The rules endpoint skips a rule that already exists, so success means "granted", not necessarily "created".
    const label = `rule ${rule.user_set} may ${rule.permission} on ${rule.is_resource ? `every ${rule.resource_set}` : rule.resource_set}`;
    await logged(log, label, async () => {
      await ensure(label, () => permit.api.conditionSetRules.create(rule));
      return 'granted';
    });
  }

  console.log('Demo data');
  await writeData(permit, demoData(loadSeed()), log);
  console.log('Preflight fixtures');
  await writeData(permit, preflightData(Date.now()), log);
  return { outcome: 'pass', summary: `seeded ${env.profile}` };
}

if (isMain(import.meta.url)) await runCli(main);

import { describe, expect, it, vi } from 'vitest';
import { ELEMENTS } from '@/lib/elements';
import {
  configureElements,
  elementConfigs,
  linkRequests,
  upsertRequests,
  type Webhook,
} from '@/setup/elements';
import { PermitRestClient } from '@/setup/permit-rest';

const SCOPE = { project: 'p', environment: 'e' };
const CONFIG = '/v2/elements/p/e/config';
const WEBHOOK: Webhook = {
  url: 'https://bank.example/account/webhook',
  secret: 'test-only-webhook-secret',
};

describe('elementConfigs', () => {
  it('leaves the approval webhook out when there is no public URL', () => {
    const approval = elementConfigs(undefined)[ELEMENTS.operationApproval];
    expect(approval.webhook).toBeNull();
    expect(approval.settings['webhookNotification']).toBe(0);
    expect(approval.settings).not.toHaveProperty('webhookUrl');
    expect(approval.settings).not.toHaveProperty('webhookSecret');
  });

  it('sends operation approvals to the webhook, with its secret as the bearer token', () => {
    const configs = elementConfigs(WEBHOOK);
    expect(configs[ELEMENTS.operationApproval].webhook).toEqual({
      type: 'elements',
      url: WEBHOOK.url,
      bearer_token: WEBHOOK.secret,
    });
    expect(configs[ELEMENTS.operationApproval].settings).toMatchObject({
      webhookNotification: 1,
      webhookUrl: WEBHOOK.url,
    });
    for (const key of [ELEMENTS.userManagement, ELEMENTS.accessRequest]) {
      expect(configs[key].webhook).toBeNull();
    }
  });

  it('lets owners manage beneficiaries and members, and beneficiaries manage members', () => {
    expect(elementConfigs(undefined)[ELEMENTS.userManagement].roles_to_levels).toEqual({
      LEVEL_1: ['AccountOwner'],
      LEVEL_2: ['AccountBeneficiary'],
      LEVEL_3: ['AccountMember'],
    });
  });
});

describe('upsertRequests', () => {
  it('creates missing elements with their key and updates existing ones by key', () => {
    const configs = elementConfigs(undefined);
    const requests = upsertRequests(SCOPE, configs, new Set([ELEMENTS.userManagement]));
    expect(requests).toHaveLength(4);
    expect(requests).toContainEqual({
      method: 'PATCH',
      path: `${CONFIG}/${ELEMENTS.userManagement}`,
      body: configs[ELEMENTS.userManagement],
    });
    expect(requests).toContainEqual({
      method: 'POST',
      path: CONFIG,
      body: { key: ELEMENTS.accessRequest, ...configs[ELEMENTS.accessRequest] },
    });
  });
});

describe('linkRequests', () => {
  it('points user management and the access request at each other by id', () => {
    const configs = elementConfigs(undefined);
    const [userManagement, accessRequest] = linkRequests(SCOPE, configs, {
      [ELEMENTS.userManagement]: 'um-id',
      [ELEMENTS.accessRequest]: 'ar-id',
    });
    expect(userManagement).toMatchObject({
      method: 'PATCH',
      path: `${CONFIG}/${ELEMENTS.userManagement}`,
      body: { settings: { approvalFlowElement: 'ar-id', title: 'Members' } },
    });
    expect(accessRequest).toMatchObject({
      method: 'PATCH',
      path: `${CONFIG}/${ELEMENTS.accessRequest}`,
      body: { settings: { selectedUserManagementElement: 'um-id' } },
    });
  });

  it('fails when Permit did not return both ids', () => {
    expect(() => linkRequests(SCOPE, elementConfigs(undefined), {})).toThrow('did not return');
  });
});

describe('configureElements', () => {
  it('lists, upserts and links the elements through the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === 'GET') {
        return Response.json({ data: [{ id: 'um-id', key: ELEMENTS.userManagement }] });
      }
      const body = JSON.parse(String(init?.body)) as { key?: string };
      const key = body.key ?? url.split('/').at(-1) ?? '';
      return Response.json({ id: key === ELEMENTS.userManagement ? 'um-id' : `${key}-id`, key });
    });

    await configureElements(
      new PermitRestClient('http://permit.test', 'k', fetchImpl),
      SCOPE,
      WEBHOOK,
    );

    const calls = fetchImpl.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`);
    expect(calls[0]).toBe(`GET http://permit.test${CONFIG}?per_page=100`);
    expect(calls.slice(1, 5).toSorted()).toEqual(
      [
        `PATCH http://permit.test${CONFIG}/${ELEMENTS.userManagement}`,
        `POST http://permit.test${CONFIG}`,
        `POST http://permit.test${CONFIG}`,
        `POST http://permit.test${CONFIG}`,
      ].toSorted(),
    );
    expect(calls.slice(5)).toEqual([
      `PATCH http://permit.test${CONFIG}/${ELEMENTS.userManagement}`,
      `PATCH http://permit.test${CONFIG}/${ELEMENTS.accessRequest}`,
    ]);
    const lastBody = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body)) as {
      settings: Record<string, unknown>;
    };
    expect(lastBody.settings['selectedUserManagementElement']).toBe('um-id');
  });
});

import { z } from 'zod';
import { ELEMENTS, type ElementKey } from '@/lib/elements';
import type { ApiRequest, EnvironmentScope, PermitRestClient } from '@/setup/permit-rest';

type SettingValue = string | number | boolean | null;

/** The body of an Elements config create or update call. */
export interface ElementConfig {
  name: string;
  elements_type: 'user_management' | 'approval_flow' | 'operation_approval' | 'approval_management';
  settings: Record<string, SettingValue>;
  email_notifications: boolean;
  roles_to_levels: Record<string, string[]>;
  /** Permit's create call takes a `type`, its update call refuses one, so there is none. */
  webhook: { url: string; bearer_token: string } | null;
}

/** Where Permit posts operation approvals, and the bearer token it sends. */
export interface Webhook {
  url: string;
  secret: string;
}

const LIGHT = {
  isDarkMode: 0,
  primaryColor: '#067A6F',
  backgroundColor: '#FFFFFF',
  darkPrimaryColor: '#0AC5B3',
  darkBackgroundColor: '#282826',
};

/**
 * The four Elements of the demo. The Operation Approval element gets the approval webhook only when
 * there is one; without it, approvals still work in the Elements.
 */
export function elementConfigs(webhook: Webhook | undefined): Record<ElementKey, ElementConfig> {
  return {
    [ELEMENTS.approvalManagement]: {
      name: 'Wire Transfer Approval Management',
      elements_type: 'approval_management',
      settings: {
        ...LIGHT,
        name: 'Wire Transfer Approval Management',
        title: 'Approval Management',
        isShowDate: 1,
        isShowReason: 1,
        isShowUserEmail: 1,
        secondaryColor: '#E5484D',
        darkSecondaryColor: '#E5484D',
      },
      email_notifications: false,
      roles_to_levels: {},
      webhook: null,
    },
    [ELEMENTS.operationApproval]: {
      name: 'Wire Transfer Approval Request',
      elements_type: 'operation_approval',
      settings: {
        ...LIGHT,
        name: 'Wire Transfer Approval Request',
        title: 'Approval Required',
        resource: 'Wire_Transfer',
        messageText: 'Performing this transfer requires approval from the account owner',
        actionButtonText: 'Request Transfer Approval',
        emailNotifications: 0,
        isRequireJustification: 1,
        justificationPlaceholder: 'I need this wire for...',
        ...(webhook === undefined
          ? { webhookNotification: 0 }
          : { webhookNotification: 1, webhookUrl: webhook.url, webhookSecret: webhook.secret }),
      },
      email_notifications: false,
      roles_to_levels: {},
      webhook: webhook === undefined ? null : { url: webhook.url, bearer_token: webhook.secret },
    },
    [ELEMENTS.accessRequest]: {
      name: 'Wire Transfer Request',
      elements_type: 'approval_flow',
      settings: {
        ...LIGHT,
        name: 'Wire Transfer Request',
        title: 'Access Restricted to Perform a Wire Transfer',
        messageText:
          'Hit the request access button and we’ll let the Account Owner know that you want to ' +
          'perform a Wire Transfer.',
        primaryColor: '#33a2e9',
        actionButtonText: 'Request Access',
        justificationMessage: '',
        isAccessJustification: 1,
        isRequireJustification: 0,
        justificationPlaceholder: 'Reason',
        selectedUserManagementElement: ELEMENTS.userManagement,
      },
      email_notifications: false,
      roles_to_levels: {},
      webhook: null,
    },
    [ELEMENTS.userManagement]: {
      name: 'Account Members Management',
      elements_type: 'user_management',
      settings: {
        ...LIGHT,
        name: 'Account Members Management',
        title: 'Members',
        webhookUrl: '',
        webhookSecret: '',
        isShowTitle: 1,
        isShowReason: 1,
        configureType: 'RBAC',
        isShowUserEmail: 1,
        actionButtonText: 'Send Invite',
        multiRoleSupport: 'single',
        emailNotifications: 0,
        isShowUserFullName: 1,
        approvalFlowElement: ELEMENTS.accessRequest,
        defaultRoleSelected: '',
        webhookNotification: 0,
        resourceTypeSelected: '',
        requestedAccessTimeWindow: 1,
        approvalFlowIsShowUserEmail: 1,
        approvalFlowIsShowUserFullName: 1,
      },
      email_notifications: false,
      // Owners manage beneficiaries and members; beneficiaries manage members.
      roles_to_levels: {
        LEVEL_1: ['AccountOwner'],
        LEVEL_2: ['AccountBeneficiary'],
        LEVEL_3: ['AccountMember'],
      },
      webhook: null,
    },
  };
}

const configPath = ({ project, environment }: EnvironmentScope) =>
  `/v2/elements/${project}/${environment}/config`;

/** Creates the Elements that do not exist yet and updates those that do. */
export function upsertRequests(
  scope: EnvironmentScope,
  configs: Record<ElementKey, ElementConfig>,
  existing: ReadonlySet<string>,
): ApiRequest[] {
  return Object.entries(configs).map(([key, config]) =>
    existing.has(key)
      ? { method: 'PATCH', path: `${configPath(scope)}/${key}`, body: config }
      : { method: 'POST', path: configPath(scope), body: { key, ...config } },
  );
}

/**
 * The user management and access request elements point at each other by id, which exists only once
 * both are created.
 */
export function linkRequests(
  scope: EnvironmentScope,
  configs: Record<ElementKey, ElementConfig>,
  ids: Readonly<Record<string, string>>,
): ApiRequest[] {
  const userManagementId = ids[ELEMENTS.userManagement];
  const accessRequestId = ids[ELEMENTS.accessRequest];
  if (userManagementId === undefined || accessRequestId === undefined) {
    throw new Error('Permit did not return the ids of the user management elements');
  }
  const link = (key: ElementKey, settings: Record<string, SettingValue>): ApiRequest => ({
    method: 'PATCH',
    path: `${configPath(scope)}/${key}`,
    body: { ...configs[key], settings: { ...configs[key].settings, ...settings } },
  });
  return [
    link(ELEMENTS.userManagement, { approvalFlowElement: accessRequestId }),
    link(ELEMENTS.accessRequest, { selectedUserManagementElement: userManagementId }),
  ];
}

const listedElement = z.object({
  id: z.string(),
  key: z.string(),
  webhook: z.object({ url: z.string() }).nullish(),
});

export type ListedElement = z.infer<typeof listedElement>;

const elementList = z
  .union([z.array(listedElement), z.object({ data: z.array(listedElement) })])
  .transform((list) => (Array.isArray(list) ? list : list.data));

/**
 * The webhooks an earlier run registered that are no longer wanted. Updating an element without a
 * webhook keeps the one it had, and an environment API key may not delete webhooks, so setup can
 * only point them out.
 */
export function leftoverWebhooks(
  configs: Record<ElementKey, ElementConfig>,
  listed: readonly ListedElement[],
): string[] {
  return listed.flatMap(({ key, webhook }) => {
    const config = Object.entries(configs).find(([configKey]) => configKey === key)?.[1];
    return config !== undefined &&
      config.webhook === null &&
      webhook !== undefined &&
      webhook !== null
      ? [key]
      : [];
  });
}

/** Configures the four Elements, with the webhook when there is one. */
export async function configureElements(
  client: PermitRestClient,
  scope: EnvironmentScope,
  webhook: Webhook | undefined,
): Promise<void> {
  const configs = elementConfigs(webhook);
  const listed = await client.send({ method: 'GET', path: `${configPath(scope)}?per_page=100` });
  const elements = elementList.parse(listed.body);
  const existing = new Set(elements.map(({ key }) => key));
  const ids: Record<string, string> = {};
  for (const request of upsertRequests(scope, configs, existing)) {
    const { body } = await client.send(request);
    const { id, key } = z.object({ id: z.string(), key: z.string() }).parse(body);
    ids[key] = id;
  }
  await client.sendAll(linkRequests(scope, configs, ids));
  for (const key of leftoverWebhooks(configs, elements)) {
    console.warn(
      `The ${key} element still has the approval webhook of an earlier run. Without ` +
        'WEBHOOK_SECRET the app refuses its calls; to stop them, remove the webhook in Permit ' +
        '(Elements, then the element).',
    );
  }
}

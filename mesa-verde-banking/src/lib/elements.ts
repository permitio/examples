/** The keys of the Permit Elements setup configures and the app embeds. */
export const ELEMENTS = {
  userManagement: 'account-members-management',
  accessRequest: 'wire-transfer-request',
  approvalManagement: 'wire-transfer-approval-management',
  operationApproval: 'wire-transfer-approval-request',
} as const;

export type ElementKey = (typeof ELEMENTS)[keyof typeof ELEMENTS];

/** The iframe URL of an element: `<embed URL>/<element>?envId=…`, plus the element's options. */
export function elementUrl(
  embedUrl: string,
  element: ElementKey,
  envId: string,
  options: Readonly<Record<string, string>> = {},
): string {
  const query = new URLSearchParams({ envId, darkMode: 'false', ...options });
  return `${embedUrl}/${element}?${query.toString()}`;
}

// S2's writes: give a member a role on one resource, and take it away, through the shared client.

import { api } from '@/api';
import type { GrantBody, GrantResponse } from '@/pages/s2/types';

/**
 * POST /api/s2/grants: the portal asks Permit `grant_<role>` on that resource, writes the role and
 * answers once the PDP holds it.
 */
export const grantRole = (grant: GrantBody) => api.post<GrantResponse>('/api/s2/grants', grant);

/**
 * DELETE /api/s2/grants: the same check and the same confirmation, for taking the role away. The
 * member, role and resource travel in the body.
 */
export const revokeRole = (grant: GrantBody) => api.delete<GrantResponse>('/api/s2/grants', grant);

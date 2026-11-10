import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CURRENCY } from '@/lib/accounts';
import { findCustomer } from '@/lib/customers';
import { getDatabase } from '@/lib/db';
import {
  badRequest,
  forbidden,
  json,
  keySchema,
  permitFailed,
  readJson,
  tenantParam,
  unauthorized,
} from '@/lib/http';
import { sendTransferCode, redeemTransferCode } from '@/lib/otp';
import {
  getAccountOwner,
  getPermit,
  listTransactions,
  recordTransaction,
  requestWireApproval,
  type Transfer,
} from '@/lib/permit';
import { getSessionUser } from '@/lib/session';

/** The transactions of an account, for users who may `list` Transactions in that tenant. */
export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  const tenant = tenantParam(request);
  if (tenant === undefined) return badRequest('Pass the account as ?tenant=<key>');
  try {
    // Permit check: may the user list this account's transactions?
    const allowed = await getPermit().check(user.email, 'list', { type: 'Transaction', tenant });
    if (!allowed) return forbidden();
    return json(await listTransactions(tenant));
  } catch (error) {
    return permitFailed('transactions', error);
  }
}

const transferRequest = z.object({
  to: keySchema,
  amount: z.number().positive().max(1_000_000),
  description: z.string().trim().min(1).max(200),
  otp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

/**
 * A wire transfer from an account (`?tenant=`), checked in two steps:
 *
 * 1. `create` on Wire_Transfer, with the transfer as resource attributes. Account owners may send any
 *    amount, beneficiaries up to 1,000. When it is denied, the app starts an operation approval and
 *    answers `approval_required`.
 * 2. `create` on Transaction, with the user's current location and whether they entered a one-time
 *    code. Owners whose location matches their registered country, and owners who entered a code,
 *    may send any amount; other owners up to 1,000. When it is denied, the app sends a code (to the
 *    log) and answers `strong_auth_required`; the client asks for the code and sends the transfer
 *    again with it.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getSessionUser(request.headers);
  if (user === null) return unauthorized();
  const tenant = tenantParam(request);
  if (tenant === undefined) return badRequest('Pass the account as ?tenant=<key>');
  const body = transferRequest.safeParse(await readJson(request));
  if (!body.success) return badRequest('Send { to, amount, description } and, if asked, otp');
  const { to, amount, description, otp } = body.data;
  if (to === tenant) return badRequest('Choose another account to send money to');

  try {
    if (otp !== undefined) {
      const code = await redeemTransferCode(user.email, otp);
      if (!code.valid) return forbidden({ code: 'invalid_code', error: code.reason });
    }

    const transfer: Transfer = {
      id: randomUUID(),
      date: new Date().toISOString(),
      description,
      amount,
      currency: CURRENCY,
      to,
    };
    const permit = getPermit();
    const [wireAllowed, owner] = await Promise.all([
      // Permit check: may the user send this wire transfer (RBAC, and ABAC on the amount)?
      permit.check(user.email, 'create', {
        type: 'Wire_Transfer',
        tenant,
        attributes: { ...transfer },
      }),
      getAccountOwner(tenant),
    ]);
    if (owner === undefined) return json({ error: 'This account has no owner' }, 404);

    if (!wireAllowed) {
      await requestWireApproval(transfer, tenant, owner.key);
      return forbidden({ code: 'approval_required', transfer: transfer.id });
    }

    const location = findCustomer(getDatabase(), user.email)?.location;
    // Permit check: may the user, where they are now and with or without a code, make it?
    const transactionAllowed = await permit.check(
      {
        key: user.email,
        attributes: {
          strongAuth: otp !== undefined,
          ...(location === undefined ? {} : { location }),
        },
      },
      'create',
      { type: 'Transaction', tenant, attributes: { ...transfer } },
    );
    if (!transactionAllowed) {
      if (otp !== undefined) return forbidden({ code: 'denied' });
      await sendTransferCode(user.email);
      return forbidden({ code: 'strong_auth_required' });
    }

    await recordTransaction(transfer, tenant, owner.key);
    return json({ transaction: transfer });
  } catch (error) {
    return permitFailed('transactions', error);
  }
}

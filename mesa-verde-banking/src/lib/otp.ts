import { isAPIError } from 'better-auth/api';
import { getAuth } from '@/lib/auth';

/**
 * The step-up code of a wire transfer, through Better Auth's email-OTP plugin. The plugin keys
 * codes by type and address; this app uses its `sign-in` type, the one meant for proving that the
 * user holds the address.
 */
const OTP_TYPE = 'sign-in';

export async function sendTransferCode(email: string): Promise<void> {
  await getAuth().api.sendVerificationOTP({ body: { email, type: OTP_TYPE } });
}

export type CodeCheck = { valid: true } | { valid: false; reason: string };

/** Checks a transfer code and, if it is right, uses it up so it cannot approve a second one. */
export async function redeemTransferCode(email: string, otp: string): Promise<CodeCheck> {
  const auth = getAuth();
  try {
    await auth.api.checkVerificationOTP({ body: { email, type: OTP_TYPE, otp } });
  } catch (error) {
    if (isAPIError(error)) return { valid: false, reason: error.message };
    throw error;
  }
  // The plugin stores a code under `<type>-otp-<email>`. Checking a code leaves it in place, so
  // consume it here: if another request consumed it first, this one gets null.
  const context = await auth.$context;
  const consumed = await context.internalAdapter.consumeVerificationValue(
    `${OTP_TYPE}-otp-${email.toLowerCase()}`,
  );
  return consumed === null
    ? { valid: false, reason: 'The code was already used' }
    : { valid: true };
}

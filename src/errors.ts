/**
 * The OAuth provider rejected the refresh token (e.g. `invalid_grant` /
 * AADSTS70000 "grant is expired"). Retrying will not help; the account must be
 * re-authorized, so the cron skips it until its credentials change.
 */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

const REAUTH_ERROR_CODES = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required"]);

export function isReauthErrorCode(code: string | undefined): boolean {
  return !!code && REAUTH_ERROR_CODES.has(code);
}

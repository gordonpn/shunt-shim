import { type ApiError, createErrorResponse } from "../../errors.js";

/**
 * Candidate search provider descriptor evaluated by the quota policy gate.
 */
export interface QuotaCandidateProvider {
  readonly id: string;
  readonly name?: string | undefined;
  readonly requiresCreditCard: boolean;
  readonly hasCredentials?: boolean | undefined;
}

/**
 * Environment bindings inspected by the search quota and billing policy gate.
 */
export interface SearchQuotaPolicyEnv {
  readonly FREE_ONLY_POLICY?: string | undefined;
  readonly ALLOW_CARD_BACKED_PROVIDERS?: string | undefined;
  readonly MONTHLY_SPEND_CAP_USD?: string | undefined;
  readonly [key: string]: string | undefined;
}

/**
 * Discriminated union returned when filtering candidate search providers.
 */
export type EligibleProvidersResult<
  T extends QuotaCandidateProvider = QuotaCandidateProvider,
> =
  | {
      readonly ok: true;
      readonly providers: T[];
    }
  | {
      readonly ok: false;
      readonly status: 403 | 503;
      readonly error: ApiError;
    };

const KNOWN_CARD_BACKED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "brave",
  "parallel",
]);

/**
 * Determines whether the strict free-only policy is enabled.
 * Defaults to true (fail-closed) unless FREE_ONLY_POLICY is explicitly "false".
 */
export function isFreeOnlyPolicyEnabled(env: SearchQuotaPolicyEnv): boolean {
  return env.FREE_ONLY_POLICY?.trim().toLowerCase() !== "false";
}

/**
 * Checks whether MONTHLY_SPEND_CAP_USD is configured as a finite positive number (> 0).
 */
export function hasValidMonthlySpendCap(env: SearchQuotaPolicyEnv): boolean {
  const raw = env.MONTHLY_SPEND_CAP_USD?.trim();
  if (!raw) {
    return false;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Checks whether card-backed providers are permitted by the current environment policy.
 * Requires FREE_ONLY_POLICY="false", ALLOW_CARD_BACKED_PROVIDERS="true",
 * and a valid positive MONTHLY_SPEND_CAP_USD.
 */
export function isCardBackedProviderAllowed(
  env: SearchQuotaPolicyEnv,
): boolean {
  if (isFreeOnlyPolicyEnabled(env)) {
    return false;
  }
  const allowCardBacked =
    env.ALLOW_CARD_BACKED_PROVIDERS?.trim().toLowerCase() === "true";
  return allowCardBacked && hasValidMonthlySpendCap(env);
}

/**
 * Evaluates whether a single candidate search provider is eligible to handle requests.
 */
export function isProviderEligible(
  provider: QuotaCandidateProvider,
  env: SearchQuotaPolicyEnv,
): boolean {
  if (provider.hasCredentials === false) {
    return false;
  }
  if (!provider.requiresCreditCard) {
    return true;
  }
  return isCardBackedProviderAllowed(env);
}

/**
 * Filters candidate providers under the free-only billing policy.
 *
 * - If a specific card-backed provider is requested while quarantined, returns 403
 *   with code "provider_quarantined_for_billing_safety".
 * - If no eligible providers remain after filtering, returns 503
 *   with code "no_eligible_free_providers".
 */
export function filterEligibleProviders<T extends QuotaCandidateProvider>(
  providers: readonly T[],
  env: SearchQuotaPolicyEnv,
  requestedProviderId?: string,
): EligibleProvidersResult<T> {
  const normalizedRequestedId = requestedProviderId?.trim().toLowerCase();

  if (normalizedRequestedId && normalizedRequestedId !== "auto") {
    const requestedProvider = providers.find(
      (provider) => provider.id.trim().toLowerCase() === normalizedRequestedId,
    );
    const requiresCard =
      requestedProvider?.requiresCreditCard ??
      KNOWN_CARD_BACKED_PROVIDER_IDS.has(normalizedRequestedId);

    if (requiresCard && !isCardBackedProviderAllowed(env)) {
      return {
        ok: false,
        status: 403,
        error: createErrorResponse(
          "Requested search provider is quarantined under free-only billing policy",
          "policy_error",
          "provider_quarantined_for_billing_safety",
        ),
      };
    }

    const targetedCandidates = requestedProvider ? [requestedProvider] : [];
    const eligibleTargeted = targetedCandidates.filter((provider) =>
      isProviderEligible(provider, env),
    );

    if (eligibleTargeted.length === 0) {
      return {
        ok: false,
        status: 503,
        error: createErrorResponse(
          "No eligible free-tier search providers are available",
          "service_unavailable",
          "no_eligible_free_providers",
        ),
      };
    }

    return {
      ok: true,
      providers: eligibleTargeted,
    };
  }

  const eligible = providers.filter((provider) =>
    isProviderEligible(provider, env),
  );

  if (eligible.length === 0) {
    return {
      ok: false,
      status: 503,
      error: createErrorResponse(
        "No eligible free-tier search providers are available",
        "service_unavailable",
        "no_eligible_free_providers",
      ),
    };
  }

  return {
    ok: true,
    providers: eligible,
  };
}

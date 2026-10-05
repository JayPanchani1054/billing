/**
 * Live password checklist driven by the company's policy ('security.passwordPolicy'). Mirrors the
 * server's rules (core/modules/security/policy.ts) so people see what is missing while typing; the
 * server re-checks everything (and also the password history, which only it can see). Pure.
 */
import type { PasswordPolicyInfo } from '../../../../shared/types/security.ts';
import { DEFAULT_SECURITY_SETTINGS, PASSWORD_HISTORY_DEPTH } from '../../../../shared/types/security.ts';

export interface RuleCheck {
  id: 'length' | 'letter' | 'digit' | 'case' | 'symbol' | 'spaces' | 'username';
  label: string;
  ok: boolean;
  /** Message when failing (same wording as the server). */
  problem: string;
}

/** Policy used until the company's policy has loaded (the built-in minimum). */
export const FALLBACK_POLICY: PasswordPolicyInfo = {
  minLength: DEFAULT_SECURITY_SETTINGS.passwordMinLength,
  maxLength: 256,
  requireMixedCase: false,
  requireSymbol: false,
  historyDepth: PASSWORD_HISTORY_DEPTH,
  expiryDays: 0,
  rules: [],
};

/** Every rule with its state for `password` (empty password → all false except the "not" rules). */
export function checkPassword(policy: PasswordPolicyInfo | null, password: string, username: string): RuleCheck[] {
  const p = policy ?? FALLBACK_POLICY;
  const checks: RuleCheck[] = [
    {
      id: 'length',
      label: `At least ${p.minLength} characters`,
      ok: password.length >= p.minLength && password.length <= p.maxLength,
      problem: password.length > p.maxLength ? `Password must be at most ${p.maxLength} characters long` : `Password must be at least ${p.minLength} characters long`,
    },
    { id: 'letter', label: 'A letter', ok: /\p{L}/u.test(password), problem: 'Password must contain at least one letter' },
    { id: 'digit', label: 'A digit', ok: /\p{Nd}/u.test(password), problem: 'Password must contain at least one digit' },
  ];
  if (p.requireMixedCase)
    checks.push({
      id: 'case',
      label: 'Upper-case and lower-case letters',
      ok: /\p{Lu}/u.test(password) && /\p{Ll}/u.test(password),
      problem: 'Password must contain both upper-case and lower-case letters',
    });
  if (p.requireSymbol)
    checks.push({ id: 'symbol', label: 'A symbol, e.g. @ # $ %', ok: /[^\p{L}\p{N}\s]/u.test(password), problem: 'Password must contain at least one symbol, e.g. @ # $ % &' });
  checks.push({
    id: 'spaces',
    label: 'No space at the start or end',
    ok: password.length > 0 && password.trim() === password,
    problem: 'Password must not start or end with a space',
  });
  const u = username.trim().toLowerCase();
  checks.push({
    id: 'username',
    label: 'Not the same as the username',
    ok: password.length > 0 && (u === '' || password.trim().toLowerCase() !== u),
    problem: 'Password must not be the same as the username',
  });
  return checks;
}

/** First failing rule's message, or null when every rule passes. */
export function firstPasswordProblem(policy: PasswordPolicyInfo | null, password: string, username: string): string | null {
  return checkPassword(policy, password, username).find((c) => !c.ok)?.problem ?? null;
}

/** Note shown under the checklist: what the server checks additionally. */
export function historyNote(policy: PasswordPolicyInfo | null): string {
  const n = (policy ?? FALLBACK_POLICY).historyDepth;
  return `It must also differ from the user’s last ${n} passwords.`;
}

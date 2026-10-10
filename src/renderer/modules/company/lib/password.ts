/**
 * Password policy (mirrors core/lib/crypto.ts passwordPolicy) and a friendly strength meter.
 * Pure — tested in password.test.ts.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Same rules as the server; null when acceptable. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters`;
  if (!/\p{L}/u.test(password)) return 'Include at least one letter';
  if (!/\p{Nd}/u.test(password)) return 'Include at least one digit';
  if (password.trim() !== password) return 'Remove spaces at the start or end';
  return null;
}

export function usernameError(username: string): string | null {
  const u = username.trim();
  if (u.length < 3) return 'Use at least 3 characters';
  if (u.length > 32) return 'Use at most 32 characters';
  if (!USERNAME_RE.test(u)) return 'Use letters, digits, dot, dash or underscore (start with a letter or digit)';
  return null;
}

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  score: StrengthScore;
  label: 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  /** What would make it stronger (plain language). */
  tips: string[];
  /** Meets the minimum policy. */
  acceptable: boolean;
}

const COMMON = ['password', 'passw0rd', '12345678', '123456789', '1234567890', 'qwerty', 'qwertyuiop', 'abc12345', 'admin123', 'welcome', 'letmein', 'iloveyou', 'india123', 'pevqori', 'tally', 'owner', 'admin'];

const LABELS: Readonly<Record<StrengthScore, PasswordStrength['label']>> = { 0: 'Too weak', 1: 'Weak', 2: 'Fair', 3: 'Good', 4: 'Strong' };

function hasSequence(pw: string): boolean {
  const s = pw.toLowerCase();
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    run = d === 1 || d === -1 || d === 0 ? run + 1 : 1;
    if (run >= 4) return true;
  }
  return false;
}

/**
 * Strength 0–4. 0 = fails the policy. Words from `context` (company name, username) and common
 * passwords cap the score at Weak.
 */
export function passwordStrength(password: string, context: readonly string[] = []): PasswordStrength {
  const policy = passwordPolicyError(password);
  if (policy) return { score: 0, label: LABELS[0], tips: [policy], acceptable: false };

  const tips: string[] = [];
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}\s]/u].filter((re) => re.test(password)).length;
  let points = 0;
  if (password.length >= 10) points++;
  if (password.length >= 14) points++;
  if (password.length >= 18) points++;
  points += Math.max(0, classes - 2);

  const lower = password.toLowerCase();
  const words = context
    .flatMap((c) => c.toLowerCase().split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w.length >= 4);
  const guessable = COMMON.some((c) => lower.includes(c)) || words.some((w) => lower.includes(w));
  if (guessable) tips.push('Avoid common words, your name or the company name');
  if (hasSequence(password)) {
    points--;
    tips.push('Avoid sequences like 1234 or aaaa');
  }
  if (password.length < 12) tips.push('A longer password is much harder to guess — try a short sentence');
  if (classes < 3) tips.push('Mix capital letters, digits and symbols');

  let score = Math.min(4, Math.max(1, 1 + points)) as StrengthScore;
  if (guessable) score = 1;
  return { score, label: LABELS[score], tips: tips.slice(0, 2), acceptable: true };
}

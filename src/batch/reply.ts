export interface ReplyCandidateDescriptor {
  locator: string;
  text?: string;
  ariaLabel?: string;
  title?: string;
  className?: string;
  id?: string;
  visible: boolean;
  enabled: boolean;
  inCommentContext: boolean;
  highConfidence?: boolean;
  inExcludedRegion?: boolean;
}

export type ReplyEntrySelection = { locator: string } | { requiresAuth: true } | null;

const normalized = (candidate: ReplyCandidateDescriptor) =>
  [candidate.text, candidate.ariaLabel, candidate.title, candidate.className, candidate.id]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

const AUTH = /\b(?:log[ -]?in|sign[ -]?in)\b[^\n]{0,40}\b(?:to\s+)?(?:reply|comment|respond)\b|(?:回复|评论).{0,20}(?:登录|登入)|(?:登录|登入).{0,20}(?:回复|评论)/i;
const UNSAFE = /\breply\s+by\s+e-?mail\b|\be-?mail\s+reply\b|\bshare\b|\breport\b|邮件回复|通过邮件回复|分享|举报/i;
const SAFE_TEXT = /^(?:reply|respond|reply\s+to(?:\s+[^\n]{1,80})?|回复(?:给|至)?(?:\s*[^\n]{1,80})?)$/i;
const SAFE_ATTR = /(?:^|[-_\s])(?:reply|respond)(?:$|[-_\s])/i;

/** Select one deterministic, conservative reply trigger. The input order is DOM order. */
export function selectReplyEntry(candidates: ReplyCandidateDescriptor[]): ReplyEntrySelection {
  let requiresAuth = false;
  const safe: Array<{ candidate: ReplyCandidateDescriptor; score: number; index: number }> = [];
  candidates.forEach((candidate, index) => {
    if (!candidate.visible || !candidate.enabled || candidate.inExcludedRegion) return;
    const value = normalized(candidate);
    if (AUTH.test(value)) { requiresAuth = true; return; }
    if (UNSAFE.test(value)) return;
    const label = [candidate.text, candidate.ariaLabel, candidate.title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const attr = [candidate.className, candidate.id].filter(Boolean).join(' ');
    const wordMatch = SAFE_TEXT.test(label) || SAFE_ATTR.test(attr);
    if (!candidate.highConfidence && (!candidate.inCommentContext || !wordMatch)) return;
    safe.push({ candidate, score: candidate.highConfidence ? 2 : 1, index });
  });
  safe.sort((a, b) => b.score - a.score || a.index - b.index);
  return safe[0] ? { locator: safe[0].candidate.locator } : requiresAuth ? { requiresAuth: true } : null;
}

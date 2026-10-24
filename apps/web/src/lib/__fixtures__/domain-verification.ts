import { META_DOMAIN_VERIFICATION_METADATA } from '../meta-domain';

/**
 * The root layout's metadata gained one block after the golden copy was taken (2026-10-25, the user's OK): Meta's
 * domain-verification tag for cheeseoclock.net (lib/meta-domain). The layout's metadata is the golden's with exactly
 * this added, and nothing else; every page's own metadata is untouched.
 */
export function withDomainVerification<T extends Record<string, unknown> | undefined>(metadata: T): T {
  const layout = metadata?.['layout'];
  if (!metadata || !layout) return metadata;
  return { ...metadata, layout: { ...(layout as Record<string, unknown>), verification: META_DOMAIN_VERIFICATION_METADATA } };
}

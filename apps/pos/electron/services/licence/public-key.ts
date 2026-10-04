/**
 * The vendor's licence public key (Ed25519, raw 32 bytes, base64url). Keys are
 * signed with the matching private key by `apps/pos/scripts/licence.mjs`, which
 * never ships; the private key lives outside the repository. Changing this
 * value invalidates every key issued so far.
 */
export const LICENCE_PUBLIC_KEY = 'MhgCT0Dniia1MFO49FvqMDDmvl4Y2a8xVmrQOpXI3SA';

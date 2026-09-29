import { z } from 'zod';
import {
  MENU_CLAIM_REFUSALS,
  MENU_DEPLOY_KEY_RE,
  MENU_DEPLOY_OUTCOMES,
  MENU_DEPLOY_SCOPES,
  MENU_FILE_MAX_BYTES,
  MENU_PACKAGE_STATES,
  MENU_UPLOAD_MAX_GZ_B64_CHARS,
} from '@cheeseoclock/shared-types';

/**
 * The wire of the menu file auto-deploy (shared-types menu-deploy.ts): what
 * the costing PC and the tills send the website, and what it answers. The
 * website (package subpath `@cheeseoclock/shared-schemas/menu-deploy`) and
 * the till validate with these; nothing here but zod and shared-types.
 *
 * Requests are strict (an unknown field is refused). Answers are not, so the
 * website may add fields later without breaking a till that reads them.
 * Timestamps are ISO 8601; the website sends them in UTC.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const isoDate = z.string().datetime({ offset: true });
/**
 * Control characters (C0, DEL, C1). A name the costing PC's --status prints
 * must not carry them: an escape sequence could rewrite the lines above it
 * and hide an upload from the one check the owner runs.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const MENU_DEPLOY_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const noControlChars = { message: 'no control characters' };

/** How many of each thing an import changed. Numbers only — never a price line, never money. */
const count = z.number().int().min(0).max(100_000).default(0);
export const menuDeployCountsSchema = z
  .object({
    newItems: count,
    updatedItems: count,
    priceChanges: count,
    newIngredients: count,
    updatedIngredients: count,
    newCategories: count,
    recipesSet: count,
    choiceGroupsChanged: count,
    batchRecipesSet: count,
    skipped: count,
  })
  // Unknown fields are dropped, never stored: the counts stay numbers only.
  .strip();
export type MenuDeployCounts = z.infer<typeof menuDeployCountsSchema>;

/** Which till is asking (every till request carries these). */
const deviceFields = {
  deviceId: z.string().min(1).max(100),
  deviceName: z.string().max(200).nullable(),
  appVersion: z.string().max(40),
};

const scope = z.enum(MENU_DEPLOY_SCOPES);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** POST /api/menu-deploy (upload key): one generated menu file, gzip + base64. */
export const menuDeployUploadBodySchema = z
  .object({
    /** The file's base name as the generator wrote it. */
    fileName: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[/\\]/.test(s), { message: 'a file name, not a path' })
      .refine((s) => !MENU_DEPLOY_CONTROL_CHARS.test(s), noControlChars),
    /** When the generator wrote it (the file's time on the costing PC). */
    generatedAt: isoDate,
    /** SHA-256 (hex) of the raw bytes, before gzip. */
    sha256: z.string().regex(HEX64),
    /** Length of the raw bytes. */
    sizeBytes: z.number().int().min(1).max(MENU_FILE_MAX_BYTES),
    contentGzB64: z.string().min(1).max(MENU_UPLOAD_MAX_GZ_B64_CHARS).regex(BASE64),
    /** The costing PC's name, for the history. */
    uploader: z
      .string()
      .max(100)
      .refine((s) => !MENU_DEPLOY_CONTROL_CHARS.test(s), noControlChars)
      .optional(),
    /** Upload even though the website holds a file made later. */
    force: z.boolean().default(false),
  })
  .strict();
export type MenuDeployUploadBody = z.infer<typeof menuDeployUploadBodySchema>;
export type MenuDeployUploadInput = z.input<typeof menuDeployUploadBodySchema>;

/** PUT /api/bridge/menu-deploy/key (BRIDGE_SECRET): the owner made a new upload key on this till. */
export const menuDeployKeyBodySchema = z
  .object({
    /** SHA-256 (hex) of the whole key. The key itself never leaves the till except on the owner's screen. */
    keyHash: z.string().regex(HEX64),
    /** Its last 4 characters, so the owner can tell keys apart. */
    keyHint: z.string().regex(/^[A-Za-z0-9_-]{4}$/),
    ...deviceFields,
  })
  .strict();
export type MenuDeployKeyBody = z.infer<typeof menuDeployKeyBodySchema>;

/** POST /api/bridge/menu-deploy/<id>/claim (BRIDGE_SECRET). */
export const menuDeployClaimBodySchema = z
  .object({
    ...deviceFields,
    scope,
    /** The newest menu file format this till reads (shared-schemas MAX_MENU_FILE_VERSION). */
    maxFormatVersion: z.number().int().min(1).max(99),
    /** The last package this till has (its synced marker), null when none. */
    lastPackageSeq: z.number().int().min(1).nullable(),
    /**
     * …and its id. The website goes by the id when it is given: a marker of a
     * package it does not know (its database was reset, so the numbers
     * started again) counts as no marker, never as a number from before.
     */
    lastPackageId: z.string().uuid().nullable().default(null),
    /** The owner's take-over of a claim that ran out (may double items). */
    takeOver: z.boolean().default(false),
    /** The owner's "Try again" after 5 failures. */
    retry: z.boolean().default(false),
  })
  .strict();
export type MenuDeployClaimBody = z.infer<typeof menuDeployClaimBodySchema>;
export type MenuDeployClaimInput = z.input<typeof menuDeployClaimBodySchema>;

/** POST /api/bridge/menu-deploy/<id>/report (BRIDGE_SECRET). */
export const menuDeployReportBodySchema = z
  .object({
    ...deviceFields,
    scope,
    outcome: z.enum(MENU_DEPLOY_OUTCOMES),
    counts: menuDeployCountsSchema.optional(),
    /** Plain words for the owner (cut to 300 characters by the till). */
    error: z.string().max(300).optional(),
    retryable: z.boolean().optional(),
    formatVersion: z.number().int().min(0).max(1000).optional(),
    maxFormatVersion: z.number().int().min(0).max(1000).optional(),
  })
  .strict();
export type MenuDeployReportBody = z.infer<typeof menuDeployReportBodySchema>;
export type MenuDeployReportInput = z.input<typeof menuDeployReportBodySchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** One uploaded file as the website holds it — never its content. */
export const menuPackageMetaSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  fileName: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int(),
  formatVersion: z.number().int(),
  source: z.string().nullable(),
  generatedAt: z.string(),
  uploadedAt: z.string(),
  uploader: z.string().nullable(),
  itemCount: z.number().int(),
  ingredientCount: z.number().int(),
  state: z.enum(MENU_PACKAGE_STATES),
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  leaseUntil: z.string().nullable(),
  /** Claimed, and the claim has run out ("stalled"). */
  leaseExpired: z.boolean(),
  attempts: z.number().int(),
  nextTryAt: z.string().nullable(),
  /** No next try time, or it has passed. */
  retryReady: z.boolean(),
  appliedBy: z.string().nullable(),
  appliedAt: z.string().nullable(),
  result: menuDeployCountsSchema.nullable(),
  error: z.string().nullable(),
  /** The website still keeps the file (the newest few do). */
  hasContent: z.boolean(),
});
export type MenuPackageMeta = z.infer<typeof menuPackageMetaSchema>;

/** One line of the history (newest first). `kind` is a MenuDeployEventKind; a later website may add kinds. */
export const menuDeployEventRowSchema = z.object({
  at: z.string(),
  kind: z.string(),
  packageId: z.string().nullable(),
  fileName: z.string().nullable(),
  deviceId: z.string().nullable(),
  deviceName: z.string().nullable(),
  detail: z.record(z.unknown()).nullable(),
});
export type MenuDeployEventRow = z.infer<typeof menuDeployEventRowSchema>;

/** GET /api/menu-deploy (upload key) and GET /api/bridge/menu-deploy (BRIDGE_SECRET). */
export const menuDeployStatusResponseSchema = z.object({
  ok: z.literal(true),
  key: z
    .object({
      keyHint: z.string(),
      createdAt: z.string(),
      deviceId: z.string(),
      deviceName: z.string().nullable(),
    })
    .nullable(),
  latest: menuPackageMetaSchema.nullable(),
  lastApplied: z
    .object({
      id: z.string(),
      seq: z.number().int(),
      appliedBy: z.string().nullable(),
      appliedAt: z.string().nullable(),
    })
    .nullable(),
  /**
   * The tills that have said they put the latest package in (either scope).
   * A till whose menu no longer has it (a backup copy restored since) never
   * puts it in again by itself.
   */
  appliedByTills: z.array(z.string()).default([]),
  /** The newest word from each till about the latest package. */
  tills: z.array(
    z.object({
      deviceId: z.string(),
      deviceName: z.string().nullable(),
      kind: z.string(),
      at: z.string(),
      detail: z.record(z.unknown()).nullable(),
    }),
  ),
  /** Only with the upload key, or ?history=1 on the bridge: the last 50 lines. */
  events: z.array(menuDeployEventRowSchema).optional(),
});
export type MenuDeployStatusResponse = z.infer<typeof menuDeployStatusResponseSchema>;

/** POST /api/menu-deploy: 201 new, 200 the same file is already there. */
export const menuDeployUploadResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  package: menuPackageMetaSchema,
});
export type MenuDeployUploadResponse = z.infer<typeof menuDeployUploadResponseSchema>;

/** POST …/<id>/claim, 200: the file to import and how long the claim lasts. */
export const menuDeployClaimResponseSchema = z.object({
  ok: z.literal(true),
  leaseSeconds: z.number().int(),
  package: menuPackageMetaSchema,
  contentGzB64: z.string(),
});
export type MenuDeployClaimResponse = z.infer<typeof menuDeployClaimResponseSchema>;

/** POST …/<id>/claim, 409: why not (MENU_CLAIM_REFUSALS), with the package as it stands. */
export const menuDeployClaimRefusalSchema = z.object({
  ok: z.literal(false),
  error: z.enum(MENU_CLAIM_REFUSALS),
  package: menuPackageMetaSchema.nullable().optional(),
  /** busy / stalled by an older file another till holds: that file. */
  blockedBy: z
    .object({ id: z.string(), seq: z.number().int(), claimedBy: z.string().nullable(), leaseExpired: z.boolean() })
    .nullable()
    .optional(),
});
export type MenuDeployClaimRefusal = z.infer<typeof menuDeployClaimRefusalSchema>;

/** GET …/<id>/content (the wait-mode preview): the file, changing nothing. 410 gone once not kept. */
export const menuDeployContentResponseSchema = z.object({
  ok: z.literal(true),
  sha256: z.string(),
  contentGzB64: z.string(),
});
export type MenuDeployContentResponse = z.infer<typeof menuDeployContentResponseSchema>;

/** POST …/<id>/report. */
export const menuDeployReportResponseSchema = z.object({
  ok: z.literal(true),
  /** The package's state after the report. */
  state: z.enum(MENU_PACKAGE_STATES),
  /** 'applied' for a package another till had already put in (the menu may now hold doubles). */
  duplicate: z.boolean(),
  /** Whether the report changed the package (own scope and word-only outcomes never do). */
  accepted: z.boolean(),
});
export type MenuDeployReportResponse = z.infer<typeof menuDeployReportResponseSchema>;

/** PUT /api/bridge/menu-deploy/key. */
export const menuDeployKeyResponseSchema = z.object({ ok: z.literal(true), createdAt: z.string() });
export type MenuDeployKeyResponse = z.infer<typeof menuDeployKeyResponseSchema>;

/** Any refusal: { ok: false, error: <code> } (claim refusals carry more, above). */
export const menuDeployErrorSchema = z.object({ ok: z.literal(false), error: z.string() });
export type MenuDeployError = z.infer<typeof menuDeployErrorSchema>;

/** A key the till made is shaped right (the website checks the same before any look-up). */
export function isMenuDeployKey(s: string): boolean {
  return MENU_DEPLOY_KEY_RE.test(s);
}

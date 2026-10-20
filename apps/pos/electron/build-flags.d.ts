/**
 * Build-time flags baked into the main process by electron.vite.config.ts
 * (`define`). Never read at run time from the environment.
 */

/** True when the build was code-signed (WIN_CSC_LINK was set when it was built). */
declare const __SIGNED_BUILD__: boolean;

/** The product this build is (COC_EDITION when it was built; shared-types edition.ts): absent in tests. */
declare const __EDITION__: string | undefined;

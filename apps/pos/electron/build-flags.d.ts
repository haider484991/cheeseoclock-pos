/**
 * Build-time flags baked into the main process by electron.vite.config.ts
 * (`define`). Never read at run time from the environment.
 */

/** True when the build was code-signed (WIN_CSC_LINK was set when it was built). */
declare const __SIGNED_BUILD__: boolean;

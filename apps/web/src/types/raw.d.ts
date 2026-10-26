/** A file's text, imported with `?raw` (next.config.mjs's webpack rule; Vite's own in tests). */
declare module '*?raw' {
  const text: string;
  export default text;
}

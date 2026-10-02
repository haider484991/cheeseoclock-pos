/**
 * Go to a screen from a click handler, through the app's own router (loaded
 * the first time it is needed, so a screen that imports this never pulls in
 * every page, and needs no router hook: react-router's useNavigate brings a
 * layout effect that a screen rendered on its own, as the tests render them,
 * warns about).
 */
export async function goTo(path: string): Promise<void> {
  const { router } = await import('./router');
  await router.navigate(path);
}

/** The screen showing now (the till's routes live in the hash: "#/orders/recent"). */
export function currentPath(fallback = '/'): string {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '').split('?')[0] ?? '';
  return hash || fallback;
}

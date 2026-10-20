import { useSyncExternalStore } from "react";
const listeners = new Set<() => void>();
let currentPath = location.pathname;
let guard: (() => Promise<void>) | undefined;
let changing = false;
const changed = () => { currentPath = location.pathname; for (const listener of listeners) listener(); };
export function setNavigationGuard(next: () => Promise<void>) { guard = next; return () => { if (guard === next) guard = undefined; }; }
async function navigate(path: string, replace: boolean) {
  if (changing || path === currentPath) return false;
  changing = true;
  try {
    if (currentPath.startsWith("/editor/")) await guard?.();
    if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
    changed(); return true;
  } catch { return false; } finally { changing = false; }
}
window.addEventListener("popstate", async () => {
  if (location.pathname === currentPath) return;
  const previous = currentPath;
  if (changing) { history.replaceState(null, "", previous); return; }
  changing = true;
  try { if (previous.startsWith("/editor/")) await guard?.(); changed(); }
  catch { history.replaceState(null, "", previous); }
  finally { changing = false; }
});
export const studioRouter = {
  push(path: string) { return navigate(path, false); },
  replace(path: string) { return navigate(path, true); },
  back() { history.back(); },
};
export function usePathname() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => location.pathname, () => "/projects");
}
export function useRouter() { return studioRouter; }
export function useParams() {
  const path = usePathname();
  return { project_id: decodeURIComponent(path.match(/^\/editor\/([^/]+)/)?.[1] || "") };
}

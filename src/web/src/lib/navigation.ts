export const TABS = ["feed", "tracks", "hot", "digest", "me", "rules", "push", "ai", "ops", "site", "admin"] as const;
export type Tab = typeof TABS[number];
export type WorkspaceScope = "personal" | "site";

export function readTab(hash: string): Tab {
  const value = hash.replace(/^#/, "");
  return TABS.includes(value as Tab) ? value as Tab : "feed";
}

export function tabUrl(pathname: string, search: string, tab: Tab): string {
  return pathname + search + (tab === "feed" ? "" : "#" + tab);
}

export function readWorkspaceScope(search: string): WorkspaceScope {
  return new URLSearchParams(search).get("workspace") === "site" ? "site" : "personal";
}

export function configurationScope(requested: WorkspaceScope, publicSite: boolean, signedIn: boolean): WorkspaceScope {
  return publicSite && signedIn ? requested : "site";
}

/** Admin credentials do not silently replace a signed-in user's personal workspace. */
export function configurationBase(requested: WorkspaceScope, publicSite: boolean, signedIn: boolean, adminReady: boolean): "/api" | "/api/me" | null {
  const scope = configurationScope(requested, publicSite, signedIn);
  return scope === "site" ? adminReady ? "/api" : null : signedIn ? "/api/me" : null;
}

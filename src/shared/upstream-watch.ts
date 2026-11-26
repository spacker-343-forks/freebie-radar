export type UpstreamImportance = "major" | "minor" | "none";

export type UpstreamCommitItem = {
  sha: string;
  short: string;
  date: string;
  message: string;
  url: string;
};

export type UpstreamWatchState = {
  repo: string;
  branch: string;
  baseSha: string | null;
  latestSha: string | null;
  latestTag: string | null;
  aheadCount: number;
  hasMajorFeature: boolean;
  importance: UpstreamImportance;
  headline: string;
  highlights: string[];
  mergeCommand: string;
  compareUrl: string | null;
  commits: UpstreamCommitItem[];
  checkedAt: string | null;
  dismissedSha: string | null;
  activeBanner: boolean;
  error?: string | null;
};

export function computeActiveBanner(
  state: Pick<UpstreamWatchState, "hasMajorFeature" | "aheadCount" | "latestSha" | "dismissedSha">,
): boolean {
  return Boolean(
    state.hasMajorFeature &&
      state.aheadCount > 0 &&
      state.latestSha &&
      state.latestSha !== state.dismissedSha,
  );
}

export type ScysOfficialReportSummary = {
  reportDate: string;
  edition: string;
  period: string | null;
  notice: string | null;
  title: string;
  signalCount: number;
  highlightCount: number;
  syncedAt: string;
};

export type ScysOfficialReportDetail = ScysOfficialReportSummary & {
  markdown: string;
  structured: Record<string, unknown>;
};

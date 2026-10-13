export interface WorkbookArtifactDiffSummary {
  hasArtifactOnlyDiff: true;
  kind: 'binary-only';
  baseBytes: number;
  mineBytes: number;
}

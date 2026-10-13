import type {
  DiffPerformanceMetrics,
  PreparedTextAnalysis,
} from '@/types/diff';
import type {
  WorkbookCompareMode,
  WorkbookMetadataMap,
} from '@/types/workbook';

export interface DiffAnalysisSnapshot {
  compareMode: WorkbookCompareMode;
  textAnalysis: PreparedTextAnalysis | null;
}

export interface WorkbookCompareModePayload {
  compareMode: WorkbookCompareMode;
  workbookArtifact: import('../../shared/workbookArtifactProtocol').WorkbookArtifactDescriptor;
  perf?: Pick<DiffPerformanceMetrics, 'rustDiffMs'> | null;
}

export interface WorkbookMetadataPayload {
  base: WorkbookMetadataMap | null;
  mine: WorkbookMetadataMap | null;
  perf?: Pick<DiffPerformanceMetrics, 'metadataMs'> | null;
}

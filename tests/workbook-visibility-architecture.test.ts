import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relativePath: string) => fs.readFileSync(path.resolve(relativePath), 'utf8');

test('workbook canvas adapters consume explicit render policy instead of global visibility state', () => {
  const canvasFiles = [
    'src/components/workbook/WorkbookPaneCanvasStrip.tsx',
    'src/components/workbook/WorkbookColumnsCanvasStrip.tsx',
    'src/components/workbook/WorkbookStackedCanvasStrip.tsx',
  ];

  canvasFiles.forEach((file) => {
    const source = read(file);
    assert.match(source, /maskedRegions: WorkbookMaskedRegionModel/);
    assert.doesNotMatch(source, /useAppStore/);
    assert.doesNotMatch(source, /renderPolicy: WorkbookRenderPolicy/);
    assert.match(source, /useWorkbookMaskedRegionReveal/);
    assert.match(source, /drawWorkbookMaskedCellSegments/);
  });
});

test('workbook visibility model is shared by panels search goto and canvas policy', () => {
  const viewModel = read('src/hooks/app/useAppViewModel.ts');
  const searchModel = read('src/hooks/app/useAppSearchModel.ts');
  const appContent = read('src/components/app-shell/AppContent.tsx');
  const workbookPanel = read('src/components/workbook/WorkbookPanel.tsx');
  const comparePanel = read('src/components/workbook/WorkbookComparePanel.tsx');
  const horizontalPanel = read('src/components/workbook/WorkbookHorizontalPanel.tsx');

  assert.match(viewModel, /buildWorkbookVisibilityModel/);
  assert.match(searchModel, /workbookVisibilityModel/);
  assert.match(appContent, /const sharedWorkbookPanelProps = \{[\s\S]*?visibilityModel: workbookVisibilityModel,/);
  const panelBranches = [...appContent.matchAll(/<WorkbookPanel\s+kind="(compare|horizontal)"\s+panelProps=\{\{([\s\S]*?)\}\}\s*\/>/g)];
  assert.deepEqual(panelBranches.map(branch => branch[1]), ['compare', 'horizontal']);
  panelBranches.forEach(branch => {
    assert.match(branch[2]!, /^\s*\.\.\.sharedWorkbookPanelProps,/);
    assert.doesNotMatch(branch[2]!, /\bvisibilityModel\s*:/);
  });
  assert.match(workbookPanel, /<WorkbookComparePanel \{\.\.\.props\.panelProps\}\s*\/>/);
  assert.match(workbookPanel, /<WorkbookHorizontalPanel \{\.\.\.props\.panelProps\}\s*\/>/);
  assert.match(comparePanel, /filterWorkbookSectionsByVisibility/);
  assert.match(horizontalPanel, /filterWorkbookSectionsByVisibility/);
  assert.match(comparePanel, /filterWorkbookRowsByVisibility/);
  assert.match(horizontalPanel, /filterWorkbookRowsByVisibility/);
  assert.equal(fs.existsSync(path.resolve('src/utils/workbook/workbookDifferencesOnlyNavigation.ts')), false);
});

test('theme appearance inference stays centralized in the theme module', () => {
  const files = [
    'src/utils/workbook/workbookRowVisuals.ts',
    'src/utils/workbook/workbookCompareVisuals.ts',
    'src/utils/workbook/workbookMaskedCellVisual.ts',
  ];

  files.forEach((file) => {
    const source = read(file);
    assert.match(source, /resolveThemeAppearance/);
    assert.doesNotMatch(source, /t0\.toLowerCase\(\) === '#09090b'/);
    assert.doesNotMatch(source, /bg0\.toLowerCase\(\) === '#000000'/);
  });
});

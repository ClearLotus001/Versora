# Binary workbook regression fixtures

The original XLS and XLSB workbooks are copied unchanged from
[calamine v0.31.0 tests](https://github.com/tafia/calamine/tree/v0.31.0/tests).
They retain their upstream filenames and the included MIT license.

The native artifact tests compare every source coordinate, cached value,
formula, row extent and mode signature against the existing calamine range
reader. Dates cover both the 1900 and 1904 epochs; the additional workbooks
exercise formulas, sheet visibility, strings, errors and XLS merged cells.

Tests also replace one sheet inside the XLSB package to verify stale declared
dimensions, gaps, formulas without cached values, and parser-error cleanup.

Two additional fixtures are generated locally and carry independent source
models. Their expected values were verified against the frozen pre-change
parser before the streaming library changes:

- `streaming_boundaries.xls` is generated with test-only xlwt 1.3.0 by
  `scripts/generate-binary-workbook-edge-fixtures.py`. Its SST spans seven
  CONTINUE records, including multilingual character data and 2,400 rich-text
  formatting runs. Formula caches cover strings, empty strings, numbers,
  booleans and errors. Deliberately unsorted and repeated cell records verify
  the original last-value and last-formula rules, empty LABEL/formula value
  replacement, and ignored BLANK/empty-SST references. Large and fractional
  numbers freeze the existing display normalization.
- `streaming_permuted.xlsb` replaces the worksheet and SST in `date.xlsb`
  using `scripts/generate-binary-workbook-stress.py`. It has 11 rows, 13
  columns and 141 distinct 128-character SST items. Every SST ID is referenced
  once, in a deterministic affine permutation, with exact SST counts.

Verify all artifact cells against either source model with
`python scripts/verify-binary-workbook-source.py --artifact=ARTIFACT_DIR
--expected-source=tests/fixtures/binary/FIXTURE.expected.json`.

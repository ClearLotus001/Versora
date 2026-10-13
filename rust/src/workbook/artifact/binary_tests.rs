use super::*;
use crate::workbook::artifact::tests::TestDir;
use calamine::Sheets;
use zip::write::SimpleFileOptions;

fn fixture_path(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/binary")
        .join(name)
}

fn assert_same_as_range_reader(path: &str, dir: &Path) {
    let mut oracle = open_workbook_auto(path).unwrap();
    let mut sheets = Vec::new();
    let mut actual = xml::ingest(path, dir, "base", &mut sheets)
        .unwrap_or_else(|error| panic!("{path}: {error}"));
    assert_eq!(
        sheets.iter().map(|sheet| &sheet.name).collect::<Vec<_>>(),
        oracle.sheet_names().iter().collect::<Vec<_>>()
    );
    for sheet in sheets {
        let range = oracle.worksheet_range(&sheet.name).unwrap();
        let formulas = oracle.worksheet_formula(&sheet.name).unwrap();
        let start = range.start().unwrap_or((0, 0));
        let ordinals = actual
            .sheet_rows
            .get(&sheet.id)
            .cloned()
            .unwrap_or_default();
        assert_eq!(ordinals.len(), range.height(), "{}", sheet.name);
        for ((row_index, row), ordinal) in range.rows().enumerate().zip(ordinals) {
            let absolute_row = start.0 + row_index as u32;
            let mut expected_cells = vec![empty_cell(); start.1 as usize];
            for (column, value) in row.iter().enumerate() {
                let absolute_column = start.1 + column as u32;
                expected_cells.push(WorkbookCellSnapshotJson {
                    value: format_cell(value),
                    formula: get_formula_for_position(&formulas, absolute_row, absolute_column)
                        .map(|formula| format!("={formula}"))
                        .unwrap_or_default(),
                });
            }
            while expected_cells
                .last()
                .is_some_and(|cell| cell.value.is_empty() && cell.formula.is_empty())
            {
                expected_cells.pop();
            }
            let expected = crate::workbook::rows::build_row_line_and_signature_owned(
                absolute_row as usize + 1,
                expected_cells,
            );
            let row = actual.read_row(ordinal).unwrap();
            assert_eq!(row.row_number, expected.row_number);
            assert_eq!(row.raw_line, expected.raw_line, "{}", sheet.name);
            assert_eq!(row.strict_signature, expected.strict_signature);
            assert_eq!(row.content_signature, expected.content_signature);
        }
        let metadata = &actual.metadata.sheets[&sheet.name];
        assert!(metadata.hidden_columns.is_empty());
        if let Sheets::Xls(workbook) = &oracle {
            let expected_merges = workbook.worksheet_merge_cells(&sheet.name).unwrap();
            assert_eq!(metadata.merge_ranges.len(), expected_merges.len());
            for (actual, expected) in metadata.merge_ranges.iter().zip(expected_merges) {
                assert_eq!(actual.start_row, expected.start.0 as usize + 1);
                assert_eq!(actual.end_row, expected.end.0 as usize + 1);
                assert_eq!(actual.start_col, expected.start.1 as usize);
                assert_eq!(actual.end_col, expected.end.1 as usize);
            }
        } else {
            assert!(metadata.merge_ranges.is_empty());
        }
        if let Some((row, column)) = range.end() {
            assert!(metadata.row_count.unwrap() > row as usize);
            assert!(metadata.max_columns.unwrap() > column as usize);
        }
    }
    assert!(!dir.join("base.formulas.bin").exists());
}

#[test]
fn real_xls_and_xlsb_keep_values_formulas_dates_coordinates_and_sheet_order() {
    let dir = TestDir::new();
    for name in [
        "date.xls",
        "date.xlsb",
        "date_1904.xls",
        "date_1904.xlsb",
        "issues.xlsb",
        "xls_formula.xls",
        "merge_cells.xls",
        "streaming_boundaries.xls",
        "streaming_permuted.xlsb",
    ] {
        assert_same_as_range_reader(fixture_path(name).to_str().unwrap(), &dir.0);
    }
}

#[test]
fn unsupported_binary_sheet_kinds_keep_range_reader_errors() {
    let dir = TestDir::new();
    let path = fixture_path("any_sheets.xlsb");
    let mut oracle = open_workbook_auto(&path).unwrap();
    let names = oracle.sheet_names().to_owned();
    assert!(names
        .iter()
        .any(|name| oracle.worksheet_range(name).is_err()));
    assert!(xml::ingest(path.to_str().unwrap(), &dir.0, "base", &mut Vec::new()).is_err());
    assert!(!dir.0.join("base.formulas.bin").exists());
}

fn append_record(bytes: &mut Vec<u8>, kind: u16, value: &[u8]) {
    if kind < 0x80 {
        bytes.push(kind as u8);
    } else {
        bytes.push((kind as u8 & 0x7f) | 0x80);
        bytes.push((kind >> 7) as u8);
    }
    let mut length = value.len();
    while length >= 0x80 {
        bytes.push((length as u8 & 0x7f) | 0x80);
        length >>= 7;
    }
    bytes.push(length as u8);
    bytes.extend_from_slice(value);
}

fn append_row(bytes: &mut Vec<u8>, row: u32) {
    let mut header = vec![0; 25];
    header[..4].copy_from_slice(&row.to_le_bytes());
    append_record(bytes, 0, &header);
}

fn append_number(bytes: &mut Vec<u8>, column: u32, value: f64) {
    let mut body = Vec::new();
    body.extend_from_slice(&column.to_le_bytes());
    body.extend_from_slice(&0u32.to_le_bytes());
    body.extend_from_slice(&value.to_le_bytes());
    append_record(bytes, 5, &body);
}

fn append_error_formula(bytes: &mut Vec<u8>, column: u32, tokens: &[u8]) {
    let mut body = Vec::new();
    body.extend_from_slice(&column.to_le_bytes());
    body.extend_from_slice(&0u32.to_le_bytes());
    body.extend_from_slice(&[0x2a, 0, 0]);
    body.extend_from_slice(&(tokens.len() as u32).to_le_bytes());
    body.extend_from_slice(tokens);
    body.extend_from_slice(&0u32.to_le_bytes());
    append_record(bytes, 0x0b, &body);
}

fn xlsb_sheet(dir: &Path, name: &str, content: &[u8]) -> String {
    let mut source = ZipArchive::new(File::open(fixture_path("date.xlsb")).unwrap()).unwrap();
    let path = dir.join(name);
    let mut destination = zip::ZipWriter::new(File::create(&path).unwrap());
    let mut replaced = false;
    for index in 0..source.len() {
        let mut entry = source.by_index(index).unwrap();
        destination
            .start_file(entry.name(), SimpleFileOptions::default())
            .unwrap();
        if !replaced && entry.name() == "xl/worksheets/sheet1.bin" {
            destination.write_all(content).unwrap();
            replaced = true;
        } else {
            io::copy(&mut entry, &mut destination).unwrap();
        }
    }
    assert!(replaced);
    destination.finish().unwrap();
    path.to_str().unwrap().to_owned()
}

fn sheet_prefix() -> Vec<u8> {
    let mut bytes = Vec::new();
    append_record(&mut bytes, 0x81, &[]);
    // The declared range deliberately contains many unused rows and columns.
    let mut dimensions = Vec::new();
    for value in [0u32, 500, 0, 200] {
        dimensions.extend_from_slice(&value.to_le_bytes());
    }
    append_record(&mut bytes, 0x94, &dimensions);
    append_record(&mut bytes, 0x91, &[]);
    bytes
}

#[test]
fn xlsb_uses_observed_bounds_and_keeps_gap_rows_and_in_range_formula_only_cells() {
    let dir = TestDir::new();
    let mut bytes = sheet_prefix();
    append_row(&mut bytes, 1);
    append_error_formula(&mut bytes, 1, &[0x1e, 7, 0]);
    append_row(&mut bytes, 2);
    append_number(&mut bytes, 4, 4.0);
    append_row(&mut bytes, 3);
    append_error_formula(&mut bytes, 3, &[0x1e, 7, 0]);
    append_error_formula(&mut bytes, 5, &[0x1e, 7, 0]);
    append_row(&mut bytes, 5);
    append_number(&mut bytes, 6, 6.0);
    append_record(&mut bytes, 0x92, &[]);
    append_record(&mut bytes, 0x82, &[]);
    let path = xlsb_sheet(&dir.0, "bounds.xlsb", &bytes);
    assert_same_as_range_reader(&path, &dir.0);
    let mut workbook = xml::ingest(&path, &dir.0, "mine", &mut Vec::new()).unwrap();
    let metadata = workbook.metadata.sheets.values().next().unwrap();
    assert_eq!(metadata.row_count, Some(6));
    assert_eq!(metadata.max_columns, Some(7));
    assert_eq!(workbook.rows.len(), 4);
    assert_eq!(workbook.read_row(1).unwrap().cells[5].formula, "=7");
    assert!(workbook.read_row(2).unwrap().cells.is_empty());
}

#[test]
fn formula_scratch_is_deleted_after_input_errors_and_formula_decode_errors() {
    let dir = TestDir::new();
    let result = FormulaScratch::write(
        &dir.0,
        "base",
        [
            Ok((0, 0, "1".to_owned())),
            Err(binary_error("Injected source failure")),
        ]
        .into_iter(),
    );
    assert!(result.is_err());
    assert!(!dir.0.join("base.formulas.bin").exists());

    let mut bytes = sheet_prefix();
    append_row(&mut bytes, 0);
    append_number(&mut bytes, 0, 1.0);
    append_error_formula(&mut bytes, 1, &[0xff]);
    append_record(&mut bytes, 0x92, &[]);
    let path = xlsb_sheet(&dir.0, "invalid-formula.xlsb", &bytes);
    assert!(xml::ingest(&path, &dir.0, "base", &mut Vec::new()).is_err());
    assert!(!dir.0.join("base.formulas.bin").exists());
}

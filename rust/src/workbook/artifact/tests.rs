use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use zip::write::SimpleFileOptions;

static NEXT_DIR: AtomicU64 = AtomicU64::new(0);
pub(super) struct TestDir(pub(super) std::path::PathBuf);
impl TestDir {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "versora-artifact-{}-{}",
            std::process::id(),
            NEXT_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fixture(dir: &Path, name: &str, worksheet: &str, strings: Option<&str>) -> String {
    let path = dir.join(name);
    let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
    let mut entries = vec![
        (
            "xl/workbook.xml",
            r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>"#,
        ),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/sheet1.xml", worksheet),
    ];
    if let Some(strings) = strings {
        entries.push(("xl/sharedStrings.xml", strings));
    }
    for (name, value) in entries {
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(value.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    path.to_str().unwrap().to_owned()
}

fn native_mode(
    dir: &Path,
    base: &str,
    mine: &str,
    mode: &str,
) -> (ModeSummary, StoredWorkbook, StoredWorkbook) {
    let mut sheets = Vec::new();
    let mut base = xml::ingest(base, dir, "base", &mut sheets).unwrap();
    let mut mine = xml::ingest(mine, dir, "mine", &mut sheets).unwrap();
    compare::prepare_keys(&mut base, &mut mine).unwrap();
    let summary = compare::build_mode(dir, mode, &sheets, &mut base, &mut mine).unwrap();
    (summary, base, mine)
}

fn integer(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn named_fixture(dir: &Path, name: &str, sheet: &str, worksheet: &str) -> String {
    let path = dir.join(name);
    let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
    let workbook = format!(
        r#"<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet}" r:id="rId1"/></sheets></workbook>"#
    );
    for (name, value) in [
        ("xl/workbook.xml", workbook.as_str()),
        (
            "xl/_rels/workbook.xml.rels",
            r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
        ),
        ("xl/worksheets/sheet1.xml", worksheet),
    ] {
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(value.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    path.to_str().unwrap().to_owned()
}

#[test]
fn exact_hash_verification_preserves_both_modes_even_with_forced_collisions() {
    let dir = TestDir::new();
    let base = fixture(
        &dir.0,
        "base.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t> </t></is></c></row><row r="2"><c><v>3</v></c></row></sheetData></worksheet>"#,
        None,
    );
    let mine = fixture(
        &dir.0,
        "mine.xlsx",
        r#"<worksheet><sheetData><row r="1"/><row r="2"><c><v>4</v></c></row></sheetData></worksheet>"#,
        None,
    );
    let mut sheets = Vec::new();
    let mut base = xml::ingest(&base, &dir.0, "base", &mut sheets).unwrap();
    let mut mine = xml::ingest(&mine, &dir.0, "mine", &mut sheets).unwrap();
    for row in base.rows.iter_mut().chain(mine.rows.iter_mut()) {
        row.strict_hash = 1;
        row.content_hash = 1;
    }
    compare::prepare_keys(&mut base, &mut mine).unwrap();
    assert_ne!(base.rows[0].strict_class, mine.rows[0].strict_class);
    assert_eq!(base.rows[0].content_class, mine.rows[0].content_class);
    assert_ne!(base.rows[1].strict_class, mine.rows[1].strict_class);
    assert_ne!(base.rows[1].content_class, mine.rows[1].content_class);
    let strict = compare::build_mode(&dir.0, "strict", &sheets, &mut base, &mut mine).unwrap();
    let content = compare::build_mode(&dir.0, "content", &sheets, &mut base, &mut mine).unwrap();
    assert_eq!(strict.changed_cell_count, 2);
    assert_eq!(content.changed_cell_count, 1);
    let runs = fs::read(dir.0.join(strict.runs_file)).unwrap();
    assert_eq!(integer(&runs, 16), 14); // delete, strict-only, base content
    let pairs = fs::read(dir.0.join(strict.pairs_file)).unwrap();
    assert_ne!(integer(&pairs, 36) & 0x10000, 0);
    let content_pairs = fs::read(dir.0.join(content.pairs_file)).unwrap();
    assert_eq!(integer(&content_pairs, 36) & 0x10000, 0);
}

#[test]
fn rename_annotations_keep_exact_similarity_and_weak_match_rules() {
    let dir = TestDir::new();
    let rows = |values: &[u32]| {
        format!(
            "<worksheet><sheetData>{}</sheetData></worksheet>",
            values
                .iter()
                .enumerate()
                .map(|(index, value)| format!(
                    "<row r=\"{}\"><c><v>{value}</v></c></row>",
                    index + 1
                ))
                .collect::<String>()
        )
    };
    let base = named_fixture(&dir.0, "base.xlsx", "Old", &rows(&[1, 2, 3, 4, 5]));
    for (values, expected) in [
        (vec![1, 2, 3, 4, 5], "rename"),
        (vec![1, 2, 3, 4, 6], "rename"),
        (vec![1, 2, 8, 9, 10], "delete"),
    ] {
        let mine = named_fixture(&dir.0, "mine.xlsx", "New", &rows(&values));
        let (summary, _, _) = native_mode(&dir.0, &base, &mine, "strict");
        assert_eq!(summary.sheets[0].change_type, expected);
        if expected == "rename" {
            assert_eq!(summary.sheets[0].rename_peer_name.as_deref(), Some("New"));
            assert_eq!(summary.sheets[1].rename_peer_name.as_deref(), Some("Old"));
            assert_eq!(summary.sheets[0].rename_role.as_deref(), Some("source"));
            assert_eq!(summary.sheets[1].rename_role.as_deref(), Some("target"));
        }
    }
    let base = named_fixture(&dir.0, "base.xlsx", "Old", &rows(&[1]));
    let mine = named_fixture(&dir.0, "mine.xlsx", "New", &rows(&[1]));
    let (summary, _, _) = native_mode(&dir.0, &base, &mine, "strict");
    assert_eq!(summary.sheets[0].change_type, "delete");
}

#[test]
fn package_relationships_and_local_namespace_aliases_are_resolved() {
    let dir = TestDir::new();
    let path = dir.0.join("aliases.xlsx");
    let mut archive = zip::ZipWriter::new(File::create(&path).unwrap());
    for (name, text) in [
        ("xl/workbook.xml", r#"<s:workbook xmlns:s="urn:sheet"><s:sheets><s:sheet xmlns:p="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="Visible" p:id="id1"/><s:sheet name="Hidden" state="hidden"/><s:sheet xmlns:q="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="Chart" q:id="id2"/></s:sheets></s:workbook>"#),
        ("xl/_rels/workbook.xml.rels", r#"<p:Relationships xmlns:p="urn:package"><p:Relationship Id="id1" Target="worksheets/../worksheets/custom.xml"/><p:Relationship Id="id2" Target="/xl/chartsheets/custom.xml"/></p:Relationships>"#),
        ("xl/worksheets/custom.xml", "<worksheet><sheetData><row r=\"4\"><c r=\"&#65;4\"><v>1</v></c></row></sheetData></worksheet>"),
        ("xl/chartsheets/custom.xml", "<chartsheet/>"),
    ] { archive.start_file(name, SimpleFileOptions::default()).unwrap(); archive.write_all(text.as_bytes()).unwrap(); }
    archive.finish().unwrap();
    let mut sheets = Vec::new();
    let workbook = xml::ingest(path.to_str().unwrap(), &dir.0, "base", &mut sheets).unwrap();
    assert_eq!(
        sheets
            .iter()
            .map(|sheet| sheet.name.as_str())
            .collect::<Vec<_>>(),
        ["Visible", "Chart"]
    );
    assert_eq!(workbook.cell_count, 1);
    assert_eq!(workbook.rows[0].row_number, 4);
}

#[test]
fn streaming_xml_preserves_entities_rich_text_formulas_and_observed_extent() {
    let dir = TestDir::new();
    let path = fixture(
        &dir.0,
        "entities.xlsx",
        r#"<?xml version="1.0"?><s:worksheet xmlns:s="urn:test"><s:dimension ref="A1"/><s:cols><s:col min="2" max="3" hidden="1"/></s:cols><s:sheetData><!-- skipped --><s:row r="7"><s:c r="B7" t="s"><s:v>0</s:v></s:c><s:c r="D7" t="inlineStr"><s:is><s:r><s:t>A&amp;B&#x1F600;&#65;<![CDATA[<C>]]></s:t></s:r><s:rPh><s:t>phonetic</s:t></s:rPh></s:is></s:c><s:c r="E7"><s:f>A1&amp;B1</s:f><s:v>2</s:v></s:c><s:c r="F7"><s:f t="shared" si="0"/><s:v>9</s:v></s:c></s:row><?test ignored?></s:sheetData><s:mergeCells><s:mergeCell ref="D7:D9"/></s:mergeCells></s:worksheet>"#,
        Some(
            r#"<sst><si><r><t>S&amp;T</t></r><rPh><t>reading</t></rPh><r><t>&#33;</t></r></si></sst>"#,
        ),
    );
    let mut sheets = Vec::new();
    let mut workbook = xml::ingest(&path, &dir.0, "base", &mut sheets).unwrap();
    let row = workbook.read_row(0).unwrap();
    assert_eq!(row.row_number, 7);
    assert_eq!(row.cells[1].value, "S&T!");
    assert_eq!(row.cells[3].value, "A&B😀A<C>");
    assert_eq!(row.cells[4].formula, "=A1&B1");
    assert!(row.cells[5].formula.is_empty());
    assert_eq!(workbook.cell_count, 4);
    assert_eq!(workbook.metadata.sheets["S"].row_count, Some(9));
    assert_eq!(workbook.metadata.sheets["S"].max_columns, Some(6));
    assert_eq!(workbook.metadata.sheets["S"].hidden_columns, vec![1, 2]);
    assert_eq!(side_summary(&workbook)["physicalRows"], 7);
}

#[test]
fn shared_string_scratch_is_removed_after_success_and_parser_errors() {
    for (worksheet, strings, succeeds) in [
        (
            r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>"#,
            "<sst><si><t>retained value</t></si></sst>",
            true,
        ),
        (
            "<worksheet><sheetData><row><c><v>broken",
            "<sst><si><t>retained value</t></si></sst>",
            false,
        ),
        ("<worksheet/>", "<sst><si><t>broken", false),
    ] {
        let dir = TestDir::new();
        let path = fixture(&dir.0, "scratch.xlsx", worksheet, Some(strings));
        let result = xml::ingest(&path, &dir.0, "base", &mut Vec::new());
        assert_eq!(result.is_ok(), succeeds);
        if let Ok(mut workbook) = result {
            assert_eq!(
                workbook.read_row(0).unwrap().cells[0].value,
                "retained value"
            );
        }
        assert!(!dir.0.join("base.sst.bin").exists());
        assert!(!dir.0.join("base.sst.idx").exists());
    }
}

#[test]
fn errors_are_reported_instead_of_empty_results() {
    for xml in [
        "",
        "<worksheet><sheetData><row r=\"1\"><c><v>1",
        "<worksheet></sheetData>",
        "<garbage/>",
        "<worksheet/><worksheet/>",
        "<worksheet><sheetData><row><c><v>&unknown;</v></c></row></sheetData></worksheet>",
    ] {
        let dir = TestDir::new();
        let path = fixture(&dir.0, "bad.xlsx", xml, None);
        assert!(
            xml::ingest(&path, &dir.0, "base", &mut Vec::new()).is_err(),
            "{xml}"
        );
    }
    let dir = TestDir::new();
    let path = fixture(
        &dir.0,
        "bad-sst.xlsx",
        "<worksheet/>",
        Some("<sst><si><t>broken"),
    );
    assert!(xml::ingest(&path, &dir.0, "base", &mut Vec::new()).is_err());
}

#[test]
fn binary_modes_match_existing_alignment_and_merge_deltas() {
    let dir = TestDir::new();
    let base = fixture(
        &dir.0,
        "base.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>  </t></is></c></row><row r="3"><c r="A3"><v>3</v></c></row><row r="4"><c r="A4"><f>SUM(A1:A3)</f><v>3</v></c></row><row r="5"><c r="C5"><v>99</v></c></row></sheetData><mergeCells><mergeCell ref="A3:B3"/></mergeCells></worksheet>"#,
        None,
    );
    let mine = fixture(
        &dir.0,
        "mine.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>4</v></c></row><row r="4"><c r="A4"><f>SUM(A1:A4)</f><v>3</v></c></row><row r="5"><c r="C5"><v>99</v></c></row></sheetData><mergeCells><mergeCell ref="A3:C3"/></mergeCells></worksheet>"#,
        None,
    );
    for mode in ["strict", "content"] {
        let legacy = crate::diff::compute_workbook_diff_output(&base, &mine, mode).unwrap();
        let expected = &legacy.workbook_delta.as_ref().unwrap().sections[0].rows;
        let (summary, _, _) = native_mode(&dir.0, &base, &mine, mode);
        let pairs = fs::read(dir.0.join(&summary.pairs_file)).unwrap();
        let runs = fs::read(dir.0.join(&summary.runs_file)).unwrap();
        assert_eq!(summary.pair_count as usize, expected.len());
        for (index, delta) in expected.iter().enumerate() {
            let record = &pairs[16 + index * 40..16 + (index + 1) * 40];
            assert_eq!(
                integer(record, 12),
                delta.base_row_number.unwrap_or(0) as u32
            );
            assert_eq!(
                integer(record, 16),
                delta.mine_row_number.unwrap_or(0) as u32
            );
            assert_eq!(integer(record, 24) as usize, delta.cell_deltas.len());
            let offset = u64::from_le_bytes(record[32..40].try_into().unwrap()) as usize;
            let mut columns = Vec::new();
            for run in runs[offset..offset + integer(record, 28) as usize * 16]
                .as_chunks::<16>()
                .0
            {
                columns.extend(integer(run, 0)..integer(run, 4));
            }
            assert_eq!(
                columns,
                delta
                    .cell_deltas
                    .iter()
                    .map(|cell| cell.column as u32)
                    .collect::<Vec<_>>()
            );
        }
    }
}

#[test]
fn merge_footprints_connect_regions_without_counting_covered_cells() {
    let dir = TestDir::new();
    let base = fixture(
        &dir.0,
        "base.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"/><row r="3"/><row r="4"/><row r="5"><c r="C5"><v>1</v></c><c r="H5"><v>1</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B5"/></mergeCells></worksheet>"#,
        None,
    );
    let mine = fixture(
        &dir.0,
        "mine.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1"><v>2</v></c></row><row r="2"/><row r="3"/><row r="4"/><row r="5"><c r="C5"><v>2</v></c><c r="H5"><v>2</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B5"/></mergeCells></worksheet>"#,
        None,
    );
    let (summary, _, _) = native_mode(&dir.0, &base, &mine, "strict");
    assert_eq!(summary.changed_cell_count, 3);
    assert_eq!(summary.region_count, 2);
    let regions = fs::read(dir.0.join(&summary.regions_file)).unwrap();
    assert_eq!(
        [
            integer(&regions, 24),
            integer(&regions, 28),
            integer(&regions, 32),
            integer(&regions, 36)
        ],
        [0, 5, 0, 3]
    );
    assert_eq!(u64::from_le_bytes(regions[48..56].try_into().unwrap()), 2);
}

#[test]
fn an_added_sheet_is_one_structural_region_even_with_disconnected_cells() {
    let dir = TestDir::new();
    let empty = dir.0.join("empty.xlsx");
    File::create(&empty).unwrap();
    let mine = fixture(
        &dir.0,
        "mine.xlsx",
        r#"<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="9"><c r="Z9"><v>2</v></c></row></sheetData></worksheet>"#,
        None,
    );
    let (summary, _, _) = native_mode(&dir.0, empty.to_str().unwrap(), &mine, "content");
    assert_eq!(summary.changed_cell_count, 2);
    assert_eq!(summary.region_count, 1);
    assert_eq!(summary.sheets[0].added_rows, 2);
    let empty_mine = fixture(&dir.0, "empty-mine.xlsx", "<worksheet/>", None);
    let (summary, _, _) = native_mode(&dir.0, empty.to_str().unwrap(), &empty_mine, "strict");
    assert_eq!(summary.pair_count, 0);
    assert_eq!(summary.region_count, 1);
    assert_eq!(summary.changed_cell_count, 0);
}

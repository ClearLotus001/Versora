use super::*;
use serde::Serialize;
use std::fs;
use std::time::Instant;

#[path = "artifact/binary.rs"]
mod binary;
#[path = "artifact/cell_sort.rs"]
mod cell_sort;
#[path = "artifact/compare.rs"]
mod compare;
#[path = "artifact/rename.rs"]
mod rename;
#[path = "artifact/store.rs"]
mod store;
#[path = "artifact/strings.rs"]
mod strings;
#[cfg(test)]
#[path = "artifact/tests.rs"]
mod tests;
#[path = "artifact/xml.rs"]
mod xml;

use store::{RowWriter, StoredWorkbook};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArtifactSheet {
    id: u32,
    name: String,
    has_base_side: bool,
    has_mine_side: bool,
    base_used_columns: Vec<usize>,
    mine_used_columns: Vec<usize>,
    base_row_count: u64,
    mine_row_count: u64,
    base_cell_count: u64,
    mine_cell_count: u64,
    change_type: String,
    rename_peer_name: Option<String>,
    rename_role: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct SheetSummary {
    sheet_id: u32,
    pair_start: u64,
    pair_count: u64,
    equal_rows: u64,
    added_rows: u64,
    deleted_rows: u64,
    modified_rows: u64,
    changed_cell_count: u64,
    changed_columns: Vec<usize>,
    change_type: String,
    rename_peer_name: Option<String>,
    rename_role: Option<String>,
    #[serde(skip)]
    legacy_line_start: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModeSummary {
    pairs_file: String,
    runs_file: String,
    regions_file: String,
    pair_count: u64,
    changed_cell_count: u64,
    region_count: u64,
    sheets: Vec<SheetSummary>,
    run_record_bytes: u32,
}

fn side_summary(workbook: &StoredWorkbook) -> serde_json::Value {
    let mut extents = HashMap::<u32, u32>::new();
    for row in &workbook.rows {
        extents
            .entry(row.sheet_id)
            .and_modify(|extent| *extent = (*extent).max(row.row_number))
            .or_insert(row.row_number);
    }
    serde_json::json!({ "rowCount": workbook.rows.len(), "physicalRows": extents.values().map(|value| u64::from(*value)).sum::<u64>(), "cellCount": workbook.cell_count, "maxColumns": workbook.rows.iter().map(|row| row.max_columns).max().unwrap_or(0) })
}

pub(crate) fn prepare_workbook_artifact(
    base_path: &str,
    mine_path: &str,
    artifact_dir: &str,
) -> io::Result<()> {
    let started = Instant::now();
    let dir = Path::new(artifact_dir);
    fs::create_dir_all(dir)?;
    let mut sheets = Vec::new();
    let mut base = xml::ingest(base_path, dir, "base", &mut sheets)?;
    let mut mine = xml::ingest(mine_path, dir, "mine", &mut sheets)?;
    for sheet in &mut sheets {
        sheet.base_used_columns = base
            .used_columns
            .get(&sheet.id)
            .map(|columns| columns.iter().copied().collect())
            .unwrap_or_default();
        sheet.mine_used_columns = mine
            .used_columns
            .get(&sheet.id)
            .map(|columns| columns.iter().copied().collect())
            .unwrap_or_default();
        sheet.base_row_count = base
            .sheet_rows
            .get(&sheet.id)
            .map(|rows| rows.len() as u64)
            .unwrap_or(0);
        sheet.mine_row_count = mine
            .sheet_rows
            .get(&sheet.id)
            .map(|rows| rows.len() as u64)
            .unwrap_or(0);
        sheet.base_cell_count = base.sheet_cell_counts.get(&sheet.id).copied().unwrap_or(0);
        sheet.mine_cell_count = mine.sheet_cell_counts.get(&sheet.id).copied().unwrap_or(0);
    }
    let ingest_ms = started.elapsed().as_secs_f64() * 1000.0;
    let alignment_start = Instant::now();
    compare::prepare_keys(&mut base, &mut mine)?;
    let strict = compare::build_mode(dir, "strict", &sheets, &mut base, &mut mine)?;
    let content = compare::build_mode(dir, "content", &sheets, &mut base, &mut mine)?;
    for (sheet, summary) in sheets.iter_mut().zip(&strict.sheets) {
        sheet.change_type.clone_from(&summary.change_type);
        sheet.rename_peer_name.clone_from(&summary.rename_peer_name);
        sheet.rename_role.clone_from(&summary.rename_role);
    }
    let manifest = serde_json::json!({
        "kind": "versora-workbook-artifact-v1", "version": 1, "complete": true,
        "artifactDir": fs::canonicalize(dir)?.to_string_lossy(),
        "files": { "baseRows": "base.rows.bin", "baseIndex": "base.rows.idx", "mineRows": "mine.rows.bin", "mineIndex": "mine.rows.idx" },
        "base": side_summary(&base), "mine": side_summary(&mine),
        "baseMetadata": base.metadata, "mineMetadata": mine.metadata,
        "sheets": sheets, "modes": { "strict": strict, "content": content },
        "perf": { "ingestMs": ingest_ms, "alignmentMs": alignment_start.elapsed().as_secs_f64() * 1000.0, "totalMs": started.elapsed().as_secs_f64() * 1000.0 }
    });
    let mut manifest_writer = BufWriter::new(File::create(dir.join("manifest.json"))?);
    serde_json::to_writer(&mut manifest_writer, &manifest).map_err(io::Error::other)?;
    manifest_writer.flush()?;
    let stdout = io::stdout();
    let mut stdout_writer = BufWriter::new(stdout.lock());
    serde_json::to_writer(&mut stdout_writer, &manifest).map_err(io::Error::other)?;
    stdout_writer.write_all(b"\n")?;
    stdout_writer.flush()
}

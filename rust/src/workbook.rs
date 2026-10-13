use std::cell::RefCell;
use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufWriter, Read, Write};
use std::path::Path;

use calamine::{open_workbook_auto, Data, Range, Reader};
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader as XmlReader;
use zip::ZipArchive;

use crate::model::{
    encode_cell, encode_cell_owned, format_cell, get_formula_for_position,
    has_workbook_cell_content, is_truthy_flag, normalize_field, parse_merge_range,
    try_get_column_index, try_get_row_number, WorkbookCellSnapshotJson, WorkbookMetadataMap,
    WorkbookRowEntry, WorkbookSheetDiffEntry, WorkbookSheetMetadata, WorkbookTextRowEntry,
    WorkbookTextSheetEntry, FORMULA_SEPARATOR, MAX_WORKBOOK_COLUMN_COUNT, MAX_WORKBOOK_ROW_NUMBER,
    ROW_PREFIX, SHEET_PREFIX,
};
use crate::profile;

const MAX_WORKBOOK_XML_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

#[path = "workbook/artifact.rs"]
mod artifact;
#[path = "workbook/context.rs"]
mod context;
#[path = "workbook/metadata.rs"]
mod metadata;
#[path = "workbook/rows.rs"]
mod rows;
#[path = "workbook/scan.rs"]
mod scan;
#[path = "workbook/shared_strings.rs"]
mod shared_strings;

pub(crate) use artifact::prepare_workbook_artifact;

pub(crate) use self::context::ZipWorkbookContext;
use self::context::{collect_visible_sheet_infos, SheetSemanticFingerprint};
use self::metadata::collect_workbook_metadata_impl;
use self::rows::{collect_workbook_row_entries, collect_workbook_text_row_entries, write_sheet};
use self::scan::{
    scan_encoded_sheet_rows, scan_full_sheet_rows, scan_text_sheet_rows_fast, FullRowsSink,
    SemanticFingerprintSink, SemanticFingerprintWithTextRowsSink,
};
use self::shared_strings::{parse_shared_strings, SharedStringsStore};

pub fn is_zip_workbook(file_path: &str) -> bool {
    matches!(
        Path::new(file_path)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase()),
        Some(ref ext) if matches!(ext.as_str(), "xlsx" | "xlsm" | "xltx" | "xltm")
    )
}

fn read_zip_entry_to_string(archive: &mut ZipArchive<File>, entry_path: &str) -> Option<String> {
    let entry = archive.by_name(entry_path).ok()?;
    if entry.size() > MAX_WORKBOOK_XML_ENTRY_BYTES {
        return None;
    }
    let mut text = String::new();
    let bytes_read = entry
        .take(MAX_WORKBOOK_XML_ENTRY_BYTES + 1)
        .read_to_string(&mut text)
        .ok()?;
    if bytes_read as u64 > MAX_WORKBOOK_XML_ENTRY_BYTES {
        return None;
    }
    Some(text)
}

fn decode_attr_value<R: BufRead>(
    reader: &XmlReader<R>,
    event: &BytesStart<'_>,
    key: &[u8],
) -> Option<String> {
    event
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == key)
        .and_then(|attribute| {
            attribute
                .decode_and_unescape_value(reader.decoder())
                .ok()
                .map(|value| value.into_owned())
        })
}

pub fn parse_workbook_document(
    file_path: &str,
    compare_mode: &str,
    requested_sheet_names: Option<&HashSet<String>>,
) -> io::Result<Vec<WorkbookSheetDiffEntry>> {
    if requested_sheet_names.is_some_and(|requested| requested.is_empty()) {
        return Ok(Vec::new());
    }
    if is_zip_workbook(file_path) {
        let total_start = profile::start();
        let mut context = ZipWorkbookContext::open(file_path)?;
        let result = context.parse_full_sheets(compare_mode, requested_sheet_names)?;
        profile::log_elapsed(
            total_start,
            format!(
                "parse_workbook_document file={} mode={} kind=full-xml sheets={}",
                file_path,
                compare_mode,
                result.len(),
            ),
        );
        return Ok(result);
    }
    let total_start = profile::start();
    let open_start = profile::start();
    let mut workbook = open_workbook_auto(file_path)
        .map_err(|error| io::Error::other(format!("Failed to open workbook: {error}")))?;
    profile::log_elapsed(
        open_start,
        format!(
            "open_workbook_auto file={} mode={} kind=full",
            file_path, compare_mode
        ),
    );
    let sheet_names = collect_visible_sheet_infos(file_path)
        .map(|infos| infos.into_iter().map(|info| info.name).collect::<Vec<_>>())
        .unwrap_or_else(|| workbook.sheet_names().to_owned());
    let mut result = Vec::new();

    for sheet_name in sheet_names {
        if let Some(requested) = requested_sheet_names {
            if !requested.contains(&sheet_name) {
                continue;
            }
        }
        let sheet_start = profile::start();
        let range = workbook.worksheet_range(&sheet_name).map_err(|error| {
            io::Error::other(format!("Failed to read worksheet '{sheet_name}': {error}"))
        })?;
        let formulas = workbook.worksheet_formula(&sheet_name).map_err(|error| {
            io::Error::other(format!(
                "Failed to read worksheet formula '{sheet_name}': {error}"
            ))
        })?;
        let row_count = range.height();
        let col_count = range.width();
        result.push(WorkbookSheetDiffEntry {
            name: sheet_name.clone(),
            raw_sheet_line: format!("{}\t{}", SHEET_PREFIX, normalize_field(&sheet_name).trim()),
            rows: collect_workbook_row_entries(&range, Some(&formulas)),
        });
        profile::log_elapsed(
            sheet_start,
            format!(
                "parse_sheet file={} mode={} kind=full sheet={} rows={} cols={}",
                file_path, compare_mode, sheet_name, row_count, col_count,
            ),
        );
    }

    profile::log_elapsed(
        total_start,
        format!(
            "parse_workbook_document file={} mode={} kind=full sheets={}",
            file_path,
            compare_mode,
            result.len()
        ),
    );
    Ok(result)
}

fn decode_xml_text(text: &[u8]) -> String {
    String::from_utf8_lossy(text).into_owned()
}

fn parse_workbook_text_document_from_zip(
    file_path: &str,
    requested_sheet_names: Option<&HashSet<String>>,
) -> io::Result<Vec<WorkbookTextSheetEntry>> {
    let total_start = profile::start();
    let mut context = ZipWorkbookContext::open(file_path)?;
    let result = context.parse_text_sheets(requested_sheet_names)?;

    profile::log_elapsed(
        total_start,
        format!(
            "parse_workbook_document file={} kind=text-only-xml sheets={}",
            file_path,
            result.len()
        ),
    );
    Ok(result)
}

pub fn parse_workbook_text_document(
    file_path: &str,
    requested_sheet_names: Option<&HashSet<String>>,
) -> io::Result<Vec<WorkbookTextSheetEntry>> {
    if requested_sheet_names.is_some_and(|requested| requested.is_empty()) {
        return Ok(Vec::new());
    }
    if is_zip_workbook(file_path) {
        return parse_workbook_text_document_from_zip(file_path, requested_sheet_names);
    }
    let total_start = profile::start();
    let open_start = profile::start();
    let mut workbook = open_workbook_auto(file_path)
        .map_err(|error| io::Error::other(format!("Failed to open workbook: {error}")))?;
    profile::log_elapsed(
        open_start,
        format!("open_workbook_auto file={} kind=text-only", file_path),
    );
    let sheet_names = collect_visible_sheet_infos(file_path)
        .map(|infos| infos.into_iter().map(|info| info.name).collect::<Vec<_>>())
        .unwrap_or_else(|| workbook.sheet_names().to_owned());
    let mut result = Vec::new();

    for sheet_name in sheet_names {
        if let Some(requested) = requested_sheet_names {
            if !requested.contains(&sheet_name) {
                continue;
            }
        }
        let sheet_start = profile::start();
        let range = workbook.worksheet_range(&sheet_name).map_err(|error| {
            io::Error::other(format!("Failed to read worksheet '{sheet_name}': {error}"))
        })?;
        let formulas = workbook.worksheet_formula(&sheet_name).map_err(|error| {
            io::Error::other(format!(
                "Failed to read worksheet formula '{sheet_name}': {error}"
            ))
        })?;
        let row_count = range.height();
        let col_count = range.width();
        result.push(WorkbookTextSheetEntry {
            name: sheet_name.clone(),
            raw_sheet_line: format!("{}\t{}", SHEET_PREFIX, normalize_field(&sheet_name).trim()),
            rows: collect_workbook_text_row_entries(&range, Some(&formulas)),
        });
        profile::log_elapsed(
            sheet_start,
            format!(
                "parse_sheet file={} kind=text-only sheet={} rows={} cols={}",
                file_path, sheet_name, row_count, col_count,
            ),
        );
    }

    profile::log_elapsed(
        total_start,
        format!(
            "parse_workbook_document file={} kind=text-only sheets={}",
            file_path,
            result.len()
        ),
    );
    Ok(result)
}

pub fn collect_workbook_metadata(file_path: &str) -> Option<WorkbookMetadataMap> {
    collect_workbook_metadata_impl(file_path)
}

pub fn write_workbook_text(file_path: &str) -> io::Result<()> {
    let mut workbook = match open_workbook_auto(file_path) {
        Ok(workbook) => workbook,
        Err(error) => {
            eprintln!("Failed to open workbook: {}", error);
            std::process::exit(3);
        }
    };

    let sheet_names = collect_visible_sheet_infos(file_path)
        .map(|infos| infos.into_iter().map(|info| info.name).collect::<Vec<_>>())
        .unwrap_or_else(|| workbook.sheet_names().to_owned());
    let stdout = io::stdout();
    let mut handle = BufWriter::with_capacity(64 * 1024, stdout.lock());

    for (index, sheet_name) in sheet_names.iter().enumerate() {
        match workbook.worksheet_range(sheet_name) {
            Ok(range) => {
                let formulas = match workbook.worksheet_formula(sheet_name) {
                    Ok(formula_range) => formula_range,
                    Err(error) => {
                        eprintln!(
                            "Failed to read worksheet formula '{}': {}",
                            sheet_name, error
                        );
                        std::process::exit(6);
                    }
                };

                write_sheet(&mut handle, sheet_name, &range, Some(&formulas))?;
                if index + 1 < sheet_names.len() {
                    writeln!(handle)?;
                }
            }
            Err(error) => {
                eprintln!("Failed to read worksheet '{}': {}", sheet_name, error);
                std::process::exit(5);
            }
        }
    }

    handle.flush()
}

pub fn write_workbook_metadata_json(file_path: &str) -> io::Result<()> {
    let metadata = collect_workbook_metadata(file_path).unwrap_or_else(|| WorkbookMetadataMap {
        sheets: BTreeMap::new(),
    });
    let stdout = io::stdout();
    let mut handle = BufWriter::with_capacity(64 * 1024, stdout.lock());
    serde_json::to_writer(&mut handle, &metadata)
        .map_err(|error| io::Error::other(error.to_string()))?;
    handle.flush()
}

use calamine::{Data, Range};
use serde::Serialize;

pub const SHEET_PREFIX: &str = "@@sheet";
pub const ROW_PREFIX: &str = "@@row";
pub const FORMULA_SEPARATOR: char = '\u{001F}';
pub const MAX_WORKBOOK_ROW_NUMBER: usize = 1_048_576;
pub const MAX_WORKBOOK_COLUMN_COUNT: usize = 16_384;

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookMergeRange {
    #[serde(rename = "sr")]
    pub start_row: usize,
    #[serde(rename = "er")]
    pub end_row: usize,
    #[serde(rename = "sc")]
    pub start_col: usize,
    #[serde(rename = "ec")]
    pub end_col: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookSheetMetadata {
    #[serde(rename = "h", default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_columns: Vec<usize>,
    #[serde(rename = "m", default, skip_serializing_if = "Vec::is_empty")]
    pub merge_ranges: Vec<WorkbookMergeRange>,
    #[serde(rename = "r", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<usize>,
    #[serde(rename = "c", skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookMetadataMap {
    #[serde(rename = "s")]
    pub sheets: std::collections::BTreeMap<String, WorkbookSheetMetadata>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookCellSnapshotJson {
    #[serde(rename = "v", default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    #[serde(rename = "f", default, skip_serializing_if = "String::is_empty")]
    pub formula: String,
}

#[derive(Debug, Clone)]
pub struct WorkbookRowEntry {
    pub raw_line: String,
    pub strict_signature: String,
    pub content_signature: String,
    pub row_number: usize,
    pub cells: Vec<WorkbookCellSnapshotJson>,
}

pub(crate) trait RowSignature {
    fn signature(&self, compare_mode: &str) -> &str;
}

impl RowSignature for WorkbookRowEntry {
    fn signature(&self, compare_mode: &str) -> &str {
        WorkbookRowEntry::signature(self, compare_mode)
    }
}

impl WorkbookRowEntry {
    pub fn signature(&self, compare_mode: &str) -> &str {
        if compare_mode == "content" {
            &self.content_signature
        } else {
            &self.strict_signature
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkbookSheetDiffEntry {
    pub name: String,
    pub raw_sheet_line: String,
    pub rows: Vec<WorkbookRowEntry>,
}

#[derive(Debug, Clone)]
pub struct WorkbookTextRowEntry {
    pub raw_line: String,
    pub row_number: usize,
}

#[derive(Debug, Clone)]
pub struct WorkbookTextSheetEntry {
    pub name: String,
    pub raw_sheet_line: String,
    pub rows: Vec<WorkbookTextRowEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookCellDeltaJson {
    #[serde(rename = "c")]
    pub column: usize,
    #[serde(rename = "b")]
    pub base_cell: WorkbookCellSnapshotJson,
    #[serde(rename = "m")]
    pub mine_cell: WorkbookCellSnapshotJson,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookRowDeltaJson {
    #[serde(rename = "l", skip_serializing_if = "Option::is_none")]
    pub left_line_idx: Option<usize>,
    #[serde(rename = "r", skip_serializing_if = "Option::is_none")]
    pub right_line_idx: Option<usize>,
    #[serde(rename = "br", skip_serializing_if = "Option::is_none")]
    pub base_row_number: Option<usize>,
    #[serde(rename = "mr", skip_serializing_if = "Option::is_none")]
    pub mine_row_number: Option<usize>,
    #[serde(rename = "c", default, skip_serializing_if = "Vec::is_empty")]
    pub cell_deltas: Vec<WorkbookCellDeltaJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookSectionDeltaJson {
    #[serde(rename = "n")]
    pub name: String,
    #[serde(rename = "b")]
    pub has_base_side: bool,
    #[serde(rename = "e")]
    pub has_mine_side: bool,
    #[serde(rename = "sl", skip_serializing_if = "Option::is_none")]
    pub start_line_idx: Option<usize>,
    #[serde(rename = "el", skip_serializing_if = "Option::is_none")]
    pub end_line_idx: Option<usize>,
    #[serde(rename = "mc", skip_serializing_if = "Option::is_none")]
    pub max_columns: Option<usize>,
    #[serde(rename = "rc", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<usize>,
    #[serde(rename = "fdl", skip_serializing_if = "Option::is_none")]
    pub first_data_line_idx: Option<usize>,
    #[serde(rename = "fdr", skip_serializing_if = "Option::is_none")]
    pub first_data_row_number: Option<usize>,
    #[serde(rename = "r")]
    pub rows: Vec<WorkbookRowDeltaJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookPrecomputedDeltaJson {
    #[serde(rename = "m")]
    pub compare_mode: String,
    #[serde(rename = "s")]
    pub sections: Vec<WorkbookSectionDeltaJson>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffLineJson {
    #[serde(rename = "t")]
    pub line_type: String,
    #[serde(rename = "b", skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(rename = "m", skip_serializing_if = "Option::is_none")]
    pub mine: Option<String>,
    #[serde(rename = "bl", skip_serializing_if = "Option::is_none")]
    pub base_line_no: Option<usize>,
    #[serde(rename = "ml", skip_serializing_if = "Option::is_none")]
    pub mine_line_no: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookDiffOutputJson {
    #[serde(rename = "d")]
    pub diff_lines: Vec<DiffLineJson>,
    #[serde(rename = "w", skip_serializing_if = "Option::is_none")]
    pub workbook_delta: Option<WorkbookPrecomputedDeltaJson>,
    #[serde(rename = "mb", skip_serializing_if = "Option::is_none")]
    pub base_metadata: Option<WorkbookMetadataMap>,
    #[serde(rename = "mm", skip_serializing_if = "Option::is_none")]
    pub mine_metadata: Option<WorkbookMetadataMap>,
    #[serde(rename = "p", skip_serializing_if = "Option::is_none")]
    pub perf: Option<WorkbookDiffPerfJson>,
}

#[derive(Debug, Serialize)]
pub struct WorkbookDiffBothOutputJson {
    #[serde(rename = "s")]
    pub strict: WorkbookDiffOutputJson,
    #[serde(rename = "c")]
    pub content: WorkbookDiffOutputJson,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkbookDiffPerfJson {
    #[serde(rename = "md")]
    pub metadata_ms: f64,
}

pub fn normalize_field(value: &str) -> String {
    let Some(first_special) = value
        .bytes()
        .position(|byte| matches!(byte, b'\r' | b'\n' | b'\t' | 0x1F))
    else {
        return value.to_owned();
    };

    let mut normalized = String::with_capacity(value.len());
    normalized.push_str(&value[..first_special]);
    let mut remaining = value[first_special..].chars().peekable();
    while let Some(character) = remaining.next() {
        match character {
            '\r' => {
                if remaining.peek() == Some(&'\n') {
                    remaining.next();
                }
                normalized.push_str(" / ");
            }
            '\n' => normalized.push_str(" / "),
            '\t' => normalized.push_str("    "),
            FORMULA_SEPARATOR => normalized.push(' '),
            _ => normalized.push(character),
        }
    }
    normalized
}

pub fn format_cell(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(value) => normalize_field(value),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                format!("{}", *value as i64)
            } else {
                value.to_string()
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => {
            if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        Data::Error(value) => format!("#{}", value),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) => normalize_field(value),
        Data::DurationIso(value) => normalize_field(value),
    }
}

pub fn encode_cell(value: &str, formula: Option<&str>) -> String {
    let normalized_value = normalize_field(value);
    let normalized_formula = formula
        .map(normalize_field)
        .filter(|text| !text.trim().is_empty());

    match normalized_formula {
        Some(formula_text) => {
            format!("{normalized_value}{FORMULA_SEPARATOR}{formula_text}")
        }
        None => normalized_value,
    }
}

pub fn encode_cell_owned(mut value: String, formula: Option<String>) -> String {
    if value.contains('\r')
        || value.contains('\n')
        || value.contains('\t')
        || value.contains(FORMULA_SEPARATOR)
    {
        value = normalize_field(&value);
    }
    let normalized_formula = formula
        .map(|formula_text| {
            if formula_text.contains('\r')
                || formula_text.contains('\n')
                || formula_text.contains('\t')
                || formula_text.contains(FORMULA_SEPARATOR)
            {
                normalize_field(&formula_text)
            } else {
                formula_text
            }
        })
        .filter(|text| !text.trim().is_empty());

    match normalized_formula {
        Some(formula_text) => {
            value.push(FORMULA_SEPARATOR);
            value.push_str(&formula_text);
            value
        }
        None => value,
    }
}

pub fn has_workbook_cell_content(cell: &WorkbookCellSnapshotJson, compare_mode: &str) -> bool {
    let normalized_value = if compare_mode == "content" && cell.value.trim().is_empty() {
        ""
    } else {
        cell.value.as_str()
    };
    !normalized_value.is_empty() || !cell.formula.is_empty()
}

pub fn get_formula_for_position(
    formulas: &Range<String>,
    abs_row: u32,
    abs_col: u32,
) -> Option<&str> {
    let (start_row, start_col) = formulas.start()?;
    if abs_row < start_row || abs_col < start_col {
        return None;
    }

    formulas
        .get((
            (abs_row - start_row) as usize,
            (abs_col - start_col) as usize,
        ))
        .map(|formula| formula.trim())
        .filter(|formula| !formula.is_empty())
}

pub fn try_get_column_index(cell_ref: &str) -> Option<usize> {
    let letters = cell_ref
        .as_bytes()
        .iter()
        .take_while(|byte| byte.is_ascii_alphabetic());
    let mut value = 0usize;
    let mut found_letter = false;
    for byte in letters {
        found_letter = true;
        let upper = byte.to_ascii_uppercase();
        value = value
            .checked_mul(26)?
            .checked_add((upper - b'A' + 1) as usize)?;
        if value > MAX_WORKBOOK_COLUMN_COUNT {
            return None;
        }
    }
    found_letter.then_some(value - 1)
}

pub fn try_get_row_number(cell_ref: &str) -> Option<usize> {
    let mut value = 0usize;
    let mut found_digit = false;
    for byte in cell_ref.as_bytes() {
        if !byte.is_ascii_digit() {
            continue;
        }
        found_digit = true;
        value = value.checked_mul(10)?.checked_add((byte - b'0') as usize)?;
        if value > MAX_WORKBOOK_ROW_NUMBER {
            return None;
        }
    }
    (found_digit && value > 0).then_some(value)
}

pub fn parse_merge_range(range_ref: &str) -> Option<WorkbookMergeRange> {
    let mut parts = range_ref.split(':');
    let start_ref = parts.next()?.trim();
    let end_ref = parts.next().unwrap_or(start_ref).trim();

    let start_row = try_get_row_number(start_ref)?;
    let end_row = try_get_row_number(end_ref)?;
    let start_col = try_get_column_index(start_ref)?;
    let end_col = try_get_column_index(end_ref)?;
    if start_row > end_row || start_col > end_col {
        return None;
    }

    Some(WorkbookMergeRange {
        start_row,
        end_row,
        start_col,
        end_col,
    })
}

pub fn is_truthy_flag(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn original_normalize_field(value: &str) -> String {
        value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', " / ")
            .replace('\t', "    ")
            .replace(FORMULA_SEPARATOR, " ")
    }

    #[test]
    fn normalization_preserves_mixed_unicode_and_adjacent_control_characters() {
        for value in [
            "",
            "普通内容 🧮 + SUM(A1:A2)",
            "中文\r\n下一行\r末行\n\t\u{1F}🧮",
            "\r\r\n\n\t\t\u{1F}\u{1F}",
            "  \t \r\n \u{1F} ",
        ] {
            assert_eq!(normalize_field(value), original_normalize_field(value));
        }
    }

    #[test]
    fn normalization_matches_original_for_all_short_control_character_sequences() {
        let alphabet = ['a', '中', '🧮', '\r', '\n', '\t', FORMULA_SEPARATOR];
        let mut sequences = vec![String::new()];
        for _ in 0..5 {
            let mut next = Vec::new();
            for sequence in sequences {
                for character in alphabet {
                    let mut value = sequence.clone();
                    value.push(character);
                    assert_eq!(normalize_field(&value), original_normalize_field(&value));
                    next.push(value);
                }
            }
            sequences = next;
        }
    }
}

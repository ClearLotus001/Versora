use super::rows::{build_row_line_and_signature, build_row_line_and_signature_owned};
use super::*;

#[derive(Clone, Copy)]
pub(super) enum TextCellType {
    SharedString,
    InlineString,
    Bool,
    Error,
    Other,
}

pub(super) struct FastTextSheetScan {
    pub rows: Vec<WorkbookTextRowEntry>,
    pub shared_string_indices: HashSet<usize>,
}

pub(super) trait EncodedSheetRowSink {
    type Output;

    fn observe_shared_string_index(&mut self, _index: usize) {}
    fn push_empty_row(&mut self, row_number: usize);
    fn start_row(&mut self, row_number: usize);
    fn push_cell(&mut self, column: usize, encoded: &str);
    fn finish_row(&mut self, row_number: usize);
    fn finish(self) -> Self::Output;
}

#[derive(Default)]
pub(super) struct TextOnlyRowsSink {
    rows: Vec<WorkbookTextRowEntry>,
    current_row_line: String,
    current_row_number: usize,
    last_written_column: usize,
}

impl EncodedSheetRowSink for TextOnlyRowsSink {
    type Output = Vec<WorkbookTextRowEntry>;

    fn push_empty_row(&mut self, row_number: usize) {
        self.rows.push(WorkbookTextRowEntry {
            raw_line: format!("{}\t{}", ROW_PREFIX, row_number),
            row_number,
        });
    }

    fn start_row(&mut self, row_number: usize) {
        self.current_row_line.clear();
        self.current_row_line.push_str(ROW_PREFIX);
        self.current_row_line.push('\t');
        self.current_row_line.push_str(&row_number.to_string());
        self.current_row_number = row_number;
        self.last_written_column = 0;
    }

    fn push_cell(&mut self, column: usize, encoded: &str) {
        let missing_columns = column.saturating_sub(self.last_written_column);
        for _ in 0..missing_columns {
            self.current_row_line.push('\t');
        }
        self.current_row_line.push_str(encoded);
        self.last_written_column = column;
    }

    fn finish_row(&mut self, row_number: usize) {
        self.rows.push(WorkbookTextRowEntry {
            raw_line: std::mem::take(&mut self.current_row_line),
            row_number,
        });
        self.current_row_number = 0;
        self.last_written_column = 0;
    }

    fn finish(self) -> Self::Output {
        self.rows
    }
}

#[derive(Default)]
pub(super) struct SemanticFingerprintSink {
    row_count: usize,
    hasher: DefaultHasher,
}

pub(super) struct FullRowsSink {
    rows: Vec<WorkbookRowEntry>,
    current_row_cells: Vec<WorkbookCellSnapshotJson>,
}

pub(super) struct SemanticFingerprintAndTextRows {
    pub fingerprint: SheetSemanticFingerprint,
    pub rows: Vec<WorkbookTextRowEntry>,
}

#[derive(Default)]
pub(super) struct SemanticFingerprintWithTextRowsSink {
    fingerprint_sink: SemanticFingerprintSink,
    text_sink: TextOnlyRowsSink,
}

impl EncodedSheetRowSink for SemanticFingerprintSink {
    type Output = SheetSemanticFingerprint;

    fn push_empty_row(&mut self, row_number: usize) {
        self.row_count += 1;
        row_number.hash(&mut self.hasher);
        0usize.hash(&mut self.hasher);
        0x1Fu8.hash(&mut self.hasher);
    }

    fn start_row(&mut self, row_number: usize) {
        self.row_count += 1;
        row_number.hash(&mut self.hasher);
    }

    fn push_cell(&mut self, column: usize, encoded: &str) {
        column.hash(&mut self.hasher);
        encoded.hash(&mut self.hasher);
        0x1Eu8.hash(&mut self.hasher);
    }

    fn finish_row(&mut self, _row_number: usize) {
        0x1Fu8.hash(&mut self.hasher);
    }

    fn finish(self) -> Self::Output {
        SheetSemanticFingerprint {
            row_count: self.row_count,
            digest: self.hasher.finish(),
        }
    }
}

impl FullRowsSink {
    pub(super) fn new() -> Self {
        Self {
            rows: Vec::new(),
            current_row_cells: Vec::new(),
        }
    }
}

pub(super) trait FullSheetRowSink {
    type Output;

    fn push_empty_row(&mut self, row_number: usize);
    fn start_row(&mut self, row_number: usize);
    fn push_cell(&mut self, column: usize, snapshot: WorkbookCellSnapshotJson);
    fn finish_row(&mut self, row_number: usize);
    fn finish(self) -> Self::Output;
}

impl FullSheetRowSink for FullRowsSink {
    type Output = Vec<WorkbookRowEntry>;

    fn push_empty_row(&mut self, row_number: usize) {
        self.rows
            .push(build_row_line_and_signature(row_number, &[]));
    }

    fn start_row(&mut self, _row_number: usize) {
        self.current_row_cells.clear();
    }

    fn push_cell(&mut self, column: usize, snapshot: WorkbookCellSnapshotJson) {
        while self.current_row_cells.len() + 1 < column {
            self.current_row_cells.push(WorkbookCellSnapshotJson {
                value: String::new(),
                formula: String::new(),
            });
        }
        self.current_row_cells.push(snapshot);
    }

    fn finish_row(&mut self, row_number: usize) {
        self.rows.push(build_row_line_and_signature_owned(
            row_number,
            std::mem::take(&mut self.current_row_cells),
        ));
    }

    fn finish(self) -> Self::Output {
        self.rows
    }
}

impl EncodedSheetRowSink for SemanticFingerprintWithTextRowsSink {
    type Output = SemanticFingerprintAndTextRows;

    fn push_empty_row(&mut self, row_number: usize) {
        self.fingerprint_sink.push_empty_row(row_number);
        self.text_sink.push_empty_row(row_number);
    }

    fn start_row(&mut self, row_number: usize) {
        self.fingerprint_sink.start_row(row_number);
        self.text_sink.start_row(row_number);
    }

    fn push_cell(&mut self, column: usize, encoded: &str) {
        self.fingerprint_sink.push_cell(column, encoded);
        self.text_sink.push_cell(column, encoded);
    }

    fn finish_row(&mut self, row_number: usize) {
        self.fingerprint_sink.finish_row(row_number);
        self.text_sink.finish_row(row_number);
    }

    fn finish(self) -> Self::Output {
        SemanticFingerprintAndTextRows {
            fingerprint: self.fingerprint_sink.finish(),
            rows: self.text_sink.finish(),
        }
    }
}

pub(super) fn parse_column_number_from_ref_bytes(bytes: &[u8]) -> Option<usize> {
    let mut value = 0usize;
    let mut found_letter = false;
    for byte in bytes {
        let upper = byte.to_ascii_uppercase();
        if !upper.is_ascii_alphabetic() {
            break;
        }
        found_letter = true;
        value = value
            .checked_mul(26)?
            .checked_add(upper as usize - b'A' as usize + 1)?;
        if value > MAX_WORKBOOK_COLUMN_COUNT {
            return None;
        }
    }
    found_letter.then_some(value)
}

pub(super) fn parse_row_number_from_attr_bytes(bytes: &[u8], fallback_row_number: usize) -> usize {
    let mut value = 0usize;
    let mut found_digit = false;
    for byte in bytes {
        if byte.is_ascii_digit() {
            found_digit = true;
            value = value
                .saturating_mul(10)
                .saturating_add((byte - b'0') as usize);
        }
    }
    if found_digit && value > 0 && value <= MAX_WORKBOOK_ROW_NUMBER {
        return value;
    }
    fallback_row_number.clamp(1, MAX_WORKBOOK_ROW_NUMBER)
}

pub(super) fn parse_row_number_attr(event: &BytesStart<'_>, fallback_row_number: usize) -> usize {
    for attribute in event.attributes().flatten() {
        if attribute.key.as_ref() == b"r" {
            return parse_row_number_from_attr_bytes(attribute.value.as_ref(), fallback_row_number);
        }
    }
    fallback_row_number.max(1)
}

pub(super) fn parse_text_cell_attrs(
    event: &BytesStart<'_>,
    fallback_column: usize,
) -> (Option<usize>, TextCellType) {
    parse_text_cell_attrs_checked(event, fallback_column).unwrap_or((None, TextCellType::Other))
}

pub(super) fn parse_text_cell_attrs_checked(
    event: &BytesStart<'_>,
    fallback_column: usize,
) -> io::Result<(Option<usize>, TextCellType)> {
    let mut column = Some(fallback_column.clamp(1, MAX_WORKBOOK_COLUMN_COUNT));
    let mut cell_type = TextCellType::Other;

    for attribute in event.attributes() {
        let attribute = attribute.map_err(io::Error::other)?;
        let decoded;
        let value = if attribute.value.contains(&b'&') {
            decoded = quick_xml::escape::unescape(
                std::str::from_utf8(attribute.value.as_ref()).map_err(io::Error::other)?,
            )
            .map_err(io::Error::other)?;
            decoded.as_bytes()
        } else {
            attribute.value.as_ref()
        };
        match attribute.key.as_ref() {
            b"r" => {
                column = parse_column_number_from_ref_bytes(value);
            }
            b"t" => {
                cell_type = match value {
                    b"s" => TextCellType::SharedString,
                    b"inlineStr" => TextCellType::InlineString,
                    b"b" => TextCellType::Bool,
                    b"e" => TextCellType::Error,
                    _ => TextCellType::Other,
                };
            }
            _ => {}
        }
    }

    Ok((column, cell_type))
}

pub(super) fn build_scanned_cell_snapshot(
    current_cell_type: TextCellType,
    current_cell_value: &str,
    current_cell_formula: &str,
    shared_strings: &SharedStringsStore,
) -> Option<WorkbookCellSnapshotJson> {
    let mut value = match current_cell_type {
        TextCellType::SharedString => current_cell_value
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(index))
            .unwrap_or_else(|| current_cell_value.to_string()),
        TextCellType::InlineString => current_cell_value.to_string(),
        TextCellType::Bool => {
            if current_cell_value == "1" {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        TextCellType::Error => {
            if current_cell_value.is_empty() {
                "#ERROR".to_string()
            } else {
                format!("#{}", current_cell_value)
            }
        }
        TextCellType::Other => current_cell_value.to_string(),
    };

    if matches!(
        current_cell_type,
        TextCellType::SharedString | TextCellType::InlineString
    ) {
        value = normalize_field(&value);
    }

    if value.is_empty() && current_cell_formula.is_empty() {
        return None;
    }

    Some(WorkbookCellSnapshotJson {
        value,
        formula: if current_cell_formula.is_empty() {
            String::new()
        } else {
            format!("={}", current_cell_formula)
        },
    })
}

pub(super) fn build_encoded_scanned_cell(
    current_cell_type: TextCellType,
    current_cell_value: &str,
    current_cell_formula: &str,
    shared_strings: &SharedStringsStore,
) -> Option<String> {
    let mut value = match current_cell_type {
        TextCellType::SharedString => current_cell_value
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|index| shared_strings.get(index))
            .unwrap_or_else(|| current_cell_value.to_string()),
        TextCellType::InlineString => current_cell_value.to_string(),
        TextCellType::Bool => {
            if current_cell_value == "1" {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        TextCellType::Error => {
            if current_cell_value.is_empty() {
                "#ERROR".to_string()
            } else {
                format!("#{}", current_cell_value)
            }
        }
        TextCellType::Other => current_cell_value.to_string(),
    };

    if matches!(
        current_cell_type,
        TextCellType::SharedString | TextCellType::InlineString
    ) {
        value = normalize_field(&value);
    }

    if value.is_empty() && current_cell_formula.is_empty() {
        return None;
    }

    Some(encode_cell_owned(
        value,
        (!current_cell_formula.is_empty()).then_some(format!("={}", current_cell_formula)),
    ))
}

pub(super) fn push_normalized_fragment(target: &mut String, value: &str) {
    if value.contains('\r')
        || value.contains('\n')
        || value.contains('\t')
        || value.contains(FORMULA_SEPARATOR)
    {
        target.push_str(&normalize_field(value));
    } else {
        target.push_str(value);
    }
}

pub(super) fn append_encoded_cell_to_row_line(
    row_line: &mut String,
    last_written_column: &mut usize,
    column: usize,
    value: &str,
    formula_raw: Option<&str>,
) {
    let missing_columns = column.saturating_sub(*last_written_column);
    for _ in 0..missing_columns {
        row_line.push('\t');
    }
    push_normalized_fragment(row_line, value);
    if let Some(formula_raw) = formula_raw.filter(|formula| !formula.is_empty()) {
        row_line.push(FORMULA_SEPARATOR);
        row_line.push('=');
        push_normalized_fragment(row_line, formula_raw);
    }
    *last_written_column = column;
}

pub(super) fn scan_text_sheet_rows_fast(
    sheet_xml: &str,
    shared_strings: &SharedStringsStore,
) -> FastTextSheetScan {
    #[derive(Clone, Copy)]
    enum CaptureTarget {
        Value,
        Formula,
        InlineString,
    }

    let mut reader = XmlReader::from_str(sheet_xml);
    let mut rows = Vec::new();
    let mut shared_string_indices = HashSet::new();
    let mut next_row_number = 1usize;
    let mut current_row_number = 0usize;
    let mut current_cell_column = Some(1usize);
    let mut current_cell_type = TextCellType::Other;
    let mut current_cell_value = String::new();
    let mut current_cell_formula = String::new();
    let mut current_row_line = String::new();
    let mut last_written_column = 0usize;
    let mut capture_target: Option<CaptureTarget> = None;
    let mut row_open = false;

    let finalize_cell = |current_cell_column: Option<usize>,
                         current_cell_type: TextCellType,
                         current_cell_value: &str,
                         current_cell_formula: &str,
                         current_row_line: &mut String,
                         last_written_column: &mut usize,
                         shared_string_indices: &mut HashSet<usize>| {
        let Some(current_cell_column) = current_cell_column else {
            return;
        };
        match current_cell_type {
            TextCellType::SharedString => {
                let Some(index) = current_cell_value.trim().parse::<usize>().ok() else {
                    return;
                };
                shared_string_indices.insert(index);
                let _ = shared_strings.with_value(index, |value| {
                    if value.is_empty() && current_cell_formula.is_empty() {
                        return;
                    }
                    let column = current_cell_column.max(last_written_column.saturating_add(1));
                    append_encoded_cell_to_row_line(
                        current_row_line,
                        last_written_column,
                        column,
                        value,
                        (!current_cell_formula.is_empty()).then_some(current_cell_formula),
                    );
                });
            }
            TextCellType::InlineString => {
                if current_cell_value.is_empty() && current_cell_formula.is_empty() {
                    return;
                }
                let column = current_cell_column.max(last_written_column.saturating_add(1));
                append_encoded_cell_to_row_line(
                    current_row_line,
                    last_written_column,
                    column,
                    current_cell_value,
                    (!current_cell_formula.is_empty()).then_some(current_cell_formula),
                );
            }
            TextCellType::Bool => {
                let value = if current_cell_value == "1" {
                    "TRUE"
                } else {
                    "FALSE"
                };
                if value.is_empty() && current_cell_formula.is_empty() {
                    return;
                }
                let column = current_cell_column.max(last_written_column.saturating_add(1));
                append_encoded_cell_to_row_line(
                    current_row_line,
                    last_written_column,
                    column,
                    value,
                    (!current_cell_formula.is_empty()).then_some(current_cell_formula),
                );
            }
            TextCellType::Error => {
                let value = if current_cell_value.is_empty() {
                    "#ERROR".to_string()
                } else {
                    format!("#{}", current_cell_value)
                };
                let column = current_cell_column.max(last_written_column.saturating_add(1));
                append_encoded_cell_to_row_line(
                    current_row_line,
                    last_written_column,
                    column,
                    &value,
                    (!current_cell_formula.is_empty()).then_some(current_cell_formula),
                );
            }
            TextCellType::Other => {
                if current_cell_value.is_empty() && current_cell_formula.is_empty() {
                    return;
                }
                let column = current_cell_column.max(last_written_column.saturating_add(1));
                append_encoded_cell_to_row_line(
                    current_row_line,
                    last_written_column,
                    column,
                    current_cell_value,
                    (!current_cell_formula.is_empty()).then_some(current_cell_formula),
                );
            }
        }
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => match event.name().as_ref() {
                b"row" => {
                    current_row_number = parse_row_number_attr(&event, next_row_number);
                    current_row_line.clear();
                    current_row_line.push_str(ROW_PREFIX);
                    current_row_line.push('\t');
                    current_row_line.push_str(&current_row_number.to_string());
                    last_written_column = 0;
                    row_open = true;
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                }
                b"v" => {
                    capture_target = Some(CaptureTarget::Value);
                }
                b"f" => {
                    capture_target = Some(CaptureTarget::Formula);
                }
                b"t" if matches!(current_cell_type, TextCellType::InlineString) => {
                    capture_target = Some(CaptureTarget::InlineString);
                }
                _ => {}
            },
            Ok(Event::Empty(event)) => match event.name().as_ref() {
                b"row" => {
                    let row_number = parse_row_number_attr(&event, next_row_number);
                    rows.push(WorkbookTextRowEntry {
                        raw_line: format!("{}\t{}", ROW_PREFIX, row_number),
                        row_number,
                    });
                    next_row_number = row_number.saturating_add(1);
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut current_row_line,
                        &mut last_written_column,
                        &mut shared_string_indices,
                    );
                }
                _ => {}
            },
            Ok(Event::End(event)) => match event.name().as_ref() {
                b"v" | b"f" | b"t" => {
                    capture_target = None;
                }
                b"c" => {
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut current_row_line,
                        &mut last_written_column,
                        &mut shared_string_indices,
                    );
                }
                b"row" if row_open => {
                    rows.push(WorkbookTextRowEntry {
                        raw_line: std::mem::take(&mut current_row_line),
                        row_number: current_row_number,
                    });
                    next_row_number = current_row_number.saturating_add(1);
                    row_open = false;
                }
                _ => {}
            },
            Ok(Event::Text(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                if let Ok(value) = text.decode() {
                    match target {
                        CaptureTarget::Value | CaptureTarget::InlineString => {
                            current_cell_value.push_str(value.as_ref())
                        }
                        CaptureTarget::Formula => current_cell_formula.push_str(value.as_ref()),
                    }
                }
            }
            Ok(Event::CData(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                let value = decode_xml_text(text.as_ref());
                match target {
                    CaptureTarget::Value | CaptureTarget::InlineString => {
                        current_cell_value.push_str(&value)
                    }
                    CaptureTarget::Formula => current_cell_formula.push_str(&value),
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    FastTextSheetScan {
        rows,
        shared_string_indices,
    }
}

pub(super) fn scan_encoded_sheet_rows<S: EncodedSheetRowSink>(
    sheet_xml: &str,
    shared_strings: &SharedStringsStore,
    mut sink: S,
) -> S::Output {
    #[derive(Clone, Copy)]
    enum CaptureTarget {
        Value,
        Formula,
        InlineString,
    }

    let mut reader = XmlReader::from_str(sheet_xml);
    let mut next_row_number = 1usize;
    let mut current_row_number = 0usize;
    let mut current_cell_column = Some(1usize);
    let mut current_cell_type = TextCellType::Other;
    let mut current_cell_value = String::new();
    let mut current_cell_formula = String::new();
    let mut last_written_column = 0usize;
    let mut capture_target: Option<CaptureTarget> = None;
    let mut row_open = false;

    let finalize_cell = |current_cell_column: Option<usize>,
                         current_cell_type: TextCellType,
                         current_cell_value: &str,
                         current_cell_formula: &str,
                         sink: &mut S,
                         last_written_column: &mut usize| {
        let Some(current_cell_column) = current_cell_column else {
            return;
        };
        if matches!(current_cell_type, TextCellType::SharedString) {
            if let Ok(index) = current_cell_value.trim().parse::<usize>() {
                sink.observe_shared_string_index(index);
            }
        }
        let Some(encoded) = build_encoded_scanned_cell(
            current_cell_type,
            current_cell_value,
            current_cell_formula,
            shared_strings,
        ) else {
            return;
        };

        let column = current_cell_column.max(last_written_column.saturating_add(1));
        sink.push_cell(column, &encoded);
        *last_written_column = column;
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => match event.name().as_ref() {
                b"row" => {
                    current_row_number = parse_row_number_attr(&event, next_row_number);
                    last_written_column = 0;
                    sink.start_row(current_row_number);
                    row_open = true;
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                }
                b"v" => {
                    capture_target = Some(CaptureTarget::Value);
                }
                b"f" => {
                    capture_target = Some(CaptureTarget::Formula);
                }
                b"t" if matches!(current_cell_type, TextCellType::InlineString) => {
                    capture_target = Some(CaptureTarget::InlineString);
                }
                _ => {}
            },
            Ok(Event::Empty(event)) => match event.name().as_ref() {
                b"row" => {
                    let row_number = parse_row_number_attr(&event, next_row_number);
                    sink.push_empty_row(row_number);
                    next_row_number = row_number.saturating_add(1);
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut sink,
                        &mut last_written_column,
                    );
                }
                _ => {}
            },
            Ok(Event::End(event)) => match event.name().as_ref() {
                b"v" | b"f" | b"t" => {
                    capture_target = None;
                }
                b"c" => {
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut sink,
                        &mut last_written_column,
                    );
                }
                b"row" if row_open => {
                    sink.finish_row(current_row_number);
                    next_row_number = current_row_number.saturating_add(1);
                    row_open = false;
                }
                _ => {}
            },
            Ok(Event::Text(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                if let Ok(value) = text.decode() {
                    match target {
                        CaptureTarget::Value | CaptureTarget::InlineString => {
                            current_cell_value.push_str(value.as_ref())
                        }
                        CaptureTarget::Formula => current_cell_formula.push_str(value.as_ref()),
                    }
                }
            }
            Ok(Event::CData(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                let value = decode_xml_text(text.as_ref());
                match target {
                    CaptureTarget::Value | CaptureTarget::InlineString => {
                        current_cell_value.push_str(&value)
                    }
                    CaptureTarget::Formula => current_cell_formula.push_str(&value),
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    sink.finish()
}

pub(super) fn scan_full_sheet_rows<S: FullSheetRowSink>(
    sheet_xml: &str,
    shared_strings: &SharedStringsStore,
    mut sink: S,
) -> S::Output {
    #[derive(Clone, Copy)]
    enum CaptureTarget {
        Value,
        Formula,
        InlineString,
    }

    let mut reader = XmlReader::from_str(sheet_xml);
    let mut next_row_number = 1usize;
    let mut current_row_number = 0usize;
    let mut current_cell_column = Some(1usize);
    let mut current_cell_type = TextCellType::Other;
    let mut current_cell_value = String::new();
    let mut current_cell_formula = String::new();
    let mut last_written_column = 0usize;
    let mut capture_target: Option<CaptureTarget> = None;
    let mut row_open = false;

    let finalize_cell = |current_cell_column: Option<usize>,
                         current_cell_type: TextCellType,
                         current_cell_value: &str,
                         current_cell_formula: &str,
                         sink: &mut S,
                         last_written_column: &mut usize| {
        let Some(current_cell_column) = current_cell_column else {
            return;
        };
        let Some(snapshot) = build_scanned_cell_snapshot(
            current_cell_type,
            current_cell_value,
            current_cell_formula,
            shared_strings,
        ) else {
            return;
        };

        let column = current_cell_column.max(last_written_column.saturating_add(1));
        sink.push_cell(column, snapshot);
        *last_written_column = column;
    };

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => match event.name().as_ref() {
                b"row" => {
                    current_row_number = parse_row_number_attr(&event, next_row_number);
                    last_written_column = 0;
                    sink.start_row(current_row_number);
                    row_open = true;
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                }
                b"v" => {
                    capture_target = Some(CaptureTarget::Value);
                }
                b"f" => {
                    capture_target = Some(CaptureTarget::Formula);
                }
                b"t" if matches!(current_cell_type, TextCellType::InlineString) => {
                    capture_target = Some(CaptureTarget::InlineString);
                }
                _ => {}
            },
            Ok(Event::Empty(event)) => match event.name().as_ref() {
                b"row" => {
                    let row_number = parse_row_number_attr(&event, next_row_number);
                    sink.push_empty_row(row_number);
                    next_row_number = row_number.saturating_add(1);
                }
                b"c" => {
                    (current_cell_column, current_cell_type) =
                        parse_text_cell_attrs(&event, last_written_column + 1);
                    current_cell_value.clear();
                    current_cell_formula.clear();
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut sink,
                        &mut last_written_column,
                    );
                }
                _ => {}
            },
            Ok(Event::End(event)) => match event.name().as_ref() {
                b"v" | b"f" | b"t" => {
                    capture_target = None;
                }
                b"c" => {
                    finalize_cell(
                        current_cell_column,
                        current_cell_type,
                        &current_cell_value,
                        &current_cell_formula,
                        &mut sink,
                        &mut last_written_column,
                    );
                }
                b"row" if row_open => {
                    sink.finish_row(current_row_number);
                    next_row_number = current_row_number.saturating_add(1);
                    row_open = false;
                }
                _ => {}
            },
            Ok(Event::Text(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                if let Ok(value) = text.decode() {
                    match target {
                        CaptureTarget::Value | CaptureTarget::InlineString => {
                            current_cell_value.push_str(value.as_ref())
                        }
                        CaptureTarget::Formula => current_cell_formula.push_str(value.as_ref()),
                    }
                }
            }
            Ok(Event::CData(text)) => {
                let Some(target) = capture_target else {
                    continue;
                };
                let value = decode_xml_text(text.as_ref());
                match target {
                    CaptureTarget::Value | CaptureTarget::InlineString => {
                        current_cell_value.push_str(&value)
                    }
                    CaptureTarget::Formula => current_cell_formula.push_str(&value),
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }

    sink.finish()
}

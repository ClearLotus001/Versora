use super::super::scan::{parse_row_number_attr, parse_text_cell_attrs_checked, TextCellType};
use super::strings::DiskStrings;
use super::*;
use std::io::BufReader;

fn xml_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("Invalid workbook XML: {error}"))
}

fn validate_attributes<R: BufRead>(
    reader: &XmlReader<R>,
    event: &BytesStart<'_>,
) -> io::Result<()> {
    for attr in event.attributes() {
        let attr = attr.map_err(xml_error)?;
        if attr.value.contains(&b'&') {
            attr.decode_and_unescape_value(reader.decoder())
                .map_err(xml_error)?;
        }
    }
    Ok(())
}

fn worksheet_path(target: &str) -> io::Result<String> {
    let value = target.replace('\\', "/");
    let value = value.trim().trim_start_matches("./");
    let absolute = if value.starts_with('/') {
        value.trim_start_matches('/').to_owned()
    } else if value.starts_with("xl/") {
        value.to_owned()
    } else {
        format!("xl/{value}")
    };
    let mut parts = Vec::new();
    for part in absolute.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(xml_error("Relationship target escapes package"));
                }
            }
            _ => parts.push(part),
        }
    }
    if parts.is_empty() {
        return Err(xml_error("Empty relationship target"));
    }
    Ok(parts.join("/"))
}

fn reference_text(reference: &quick_xml::events::BytesRef<'_>) -> io::Result<String> {
    if let Some(character) = reference.resolve_char_ref().map_err(xml_error)? {
        return Ok(character.to_string());
    }
    let name = reference.decode().map_err(xml_error)?;
    quick_xml::escape::resolve_predefined_entity(&name)
        .map(str::to_owned)
        .ok_or_else(|| xml_error(format!("Unknown entity &{name};")))
}

fn zip_sheet_infos(archive: &mut ZipArchive<File>) -> io::Result<Vec<(String, String)>> {
    let mut relationships = HashMap::new();
    {
        let entry = archive
            .by_name("xl/_rels/workbook.xml.rels")
            .map_err(xml_error)?;
        let mut reader = XmlReader::from_reader(BufReader::new(entry));
        let mut buffer = Vec::new();
        let mut depth = 0usize;
        let mut saw_root = false;
        loop {
            let event = reader.read_event_into(&mut buffer).map_err(xml_error)?;
            if let Event::Start(start) | Event::Empty(start) = &event {
                validate_attributes(&reader, start)?;
            }
            match &event {
                Event::Start(start) => {
                    if depth == 0 {
                        if saw_root || start.local_name().as_ref() != b"Relationships" {
                            return Err(xml_error("Invalid relationships root"));
                        }
                        saw_root = true;
                    }
                    depth += 1;
                }
                Event::Empty(start) if depth == 0 => {
                    if saw_root || start.local_name().as_ref() != b"Relationships" {
                        return Err(xml_error("Invalid relationships root"));
                    }
                    saw_root = true;
                }
                Event::End(_) => {
                    depth = depth
                        .checked_sub(1)
                        .ok_or_else(|| xml_error("Unexpected closing tag"))?
                }
                _ => {}
            }
            match event {
                Event::Start(event) | Event::Empty(event)
                    if event.local_name().as_ref() == b"Relationship" =>
                {
                    let id = decode_attr_value(&reader, &event, b"Id").unwrap_or_default();
                    let target = decode_attr_value(&reader, &event, b"Target").unwrap_or_default();
                    if decode_attr_value(&reader, &event, b"TargetMode").as_deref()
                        != Some("External")
                    {
                        relationships.insert(id, worksheet_path(&target)?);
                    }
                }
                Event::Eof => {
                    if depth != 0 || !saw_root {
                        return Err(xml_error("Empty or truncated relationships"));
                    }
                    break;
                }
                _ => {}
            }
            buffer.clear();
        }
    }
    let entry = archive.by_name("xl/workbook.xml").map_err(xml_error)?;
    let mut reader = XmlReader::from_reader(BufReader::new(entry));
    let mut buffer = Vec::new();
    let mut sheets = Vec::new();
    let mut index = 0;
    let mut depth = 0usize;
    let mut saw_root = false;
    let mut namespace_stack = vec![HashSet::<Vec<u8>>::new()];
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(xml_error)?;
        let mut event_prefixes = namespace_stack.last().unwrap().clone();
        if let Event::Start(start) | Event::Empty(start) = &event {
            validate_attributes(&reader, start)?;
            if depth == 0 {
                if saw_root || start.local_name().as_ref() != b"workbook" {
                    return Err(xml_error("Invalid workbook root"));
                }
                saw_root = true;
            }
            for attr in start.attributes() {
                let attr = attr.map_err(xml_error)?;
                if let Some(prefix) = attr.key.as_ref().strip_prefix(b"xmlns:") {
                    let value = attr
                        .decode_and_unescape_value(reader.decoder())
                        .map_err(xml_error)?;
                    if value
                        == "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
                        || value == "http://purl.oclc.org/ooxml/officeDocument/relationships"
                    {
                        event_prefixes.insert(prefix.to_vec());
                    } else {
                        event_prefixes.remove(prefix);
                    }
                }
            }
        }
        match &event {
            Event::Start(_) => {
                depth += 1;
                namespace_stack.push(event_prefixes.clone());
            }
            Event::End(_) => {
                namespace_stack.pop();
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| xml_error("Unexpected closing tag"))?
            }
            _ => {}
        }
        match event {
            Event::Start(event) | Event::Empty(event)
                if event.local_name().as_ref() == b"sheet" =>
            {
                let name = decode_attr_value(&reader, &event, b"name")
                    .unwrap_or_else(|| format!("Sheet{}", index + 1));
                let state = decode_attr_value(&reader, &event, b"state")
                    .unwrap_or_default()
                    .trim()
                    .to_ascii_lowercase();
                let mut rel = String::new();
                for attr in event.attributes() {
                    let attr = attr.map_err(xml_error)?;
                    let key = attr.key.as_ref();
                    if let Some(prefix) = key.strip_suffix(b":id") {
                        if event_prefixes.contains(prefix) {
                            rel = attr
                                .decode_and_unescape_value(reader.decoder())
                                .map_err(xml_error)?
                                .into_owned();
                        }
                    }
                }
                if state != "hidden" && state != "veryhidden" {
                    let path = if rel.is_empty() {
                        format!("xl/worksheets/sheet{}.xml", index + 1)
                    } else {
                        relationships.get(&rel).cloned().ok_or_else(|| {
                            xml_error(format!("Missing worksheet relationship {rel}"))
                        })?
                    };
                    sheets.push((name, path));
                }
                index += 1;
            }
            Event::Eof => {
                if depth != 0 || !saw_root {
                    return Err(xml_error("Empty or truncated workbook"));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(sheets)
}

impl DiskStrings {
    fn open(archive: &mut ZipArchive<File>, dir: &Path, side: &str) -> io::Result<Self> {
        let mut strings = DiskStrings::new(dir, side)?;
        match archive.by_name("xl/sharedStrings.xml") {
            Ok(entry) => {
                let mut reader = XmlReader::from_reader(BufReader::new(entry));
                let mut buffer = Vec::new();
                let mut value = String::new();
                let mut capture = false;
                let mut item_open = false;
                let mut depth = 0usize;
                let mut saw_root = false;
                let mut phonetic_depth = 0usize;
                loop {
                    match reader.read_event_into(&mut buffer).map_err(xml_error)? {
                        Event::Start(event) => {
                            if depth == 0 {
                                if saw_root || event.local_name().as_ref() != b"sst" {
                                    return Err(xml_error("Invalid shared strings root"));
                                }
                                saw_root = true;
                            }
                            depth += 1;
                            match event.local_name().as_ref() {
                                b"si" => {
                                    value.clear();
                                    item_open = true;
                                }
                                b"rPh" => phonetic_depth += 1,
                                b"t" if item_open && phonetic_depth == 0 => capture = true,
                                _ => {}
                            }
                        }
                        Event::Empty(event) if depth == 0 => {
                            if saw_root || event.local_name().as_ref() != b"sst" {
                                return Err(xml_error("Invalid shared strings root"));
                            }
                            saw_root = true;
                        }
                        Event::Empty(event) if event.local_name().as_ref() == b"si" => {
                            strings.append("")?;
                        }
                        Event::End(event) => {
                            depth = depth
                                .checked_sub(1)
                                .ok_or_else(|| xml_error("Unexpected closing tag"))?;
                            match event.local_name().as_ref() {
                                b"t" => capture = false,
                                b"rPh" => phonetic_depth = phonetic_depth.saturating_sub(1),
                                b"si" => {
                                    strings.append(&value)?;
                                    item_open = false;
                                }
                                _ => {}
                            }
                        }
                        Event::Text(text) if capture => {
                            value.push_str(text.decode().map_err(xml_error)?.as_ref())
                        }
                        Event::CData(text) if capture => {
                            value.push_str(text.decode().map_err(xml_error)?.as_ref())
                        }
                        Event::GeneralRef(reference) if capture => {
                            value.push_str(&reference_text(&reference)?)
                        }
                        Event::Eof => {
                            if depth != 0 || item_open || !saw_root {
                                return Err(xml_error("Empty or truncated shared strings"));
                            }
                            break;
                        }
                        _ => {}
                    }
                    buffer.clear();
                }
            }
            Err(zip::result::ZipError::FileNotFound) => {}
            Err(error) => return Err(xml_error(error)),
        }
        strings.seal()?;
        Ok(strings)
    }
}

fn cell_snapshot(
    kind: TextCellType,
    raw_value: &str,
    raw_formula: &str,
    strings: &mut DiskStrings,
) -> io::Result<Option<WorkbookCellSnapshotJson>> {
    let mut value = match kind {
        TextCellType::SharedString => match raw_value.trim().parse::<usize>() {
            Ok(id) => strings.get(id)?.unwrap_or_else(|| raw_value.to_owned()),
            Err(_) => raw_value.to_owned(),
        },
        TextCellType::Bool => {
            if raw_value == "1" {
                "TRUE".to_owned()
            } else {
                "FALSE".to_owned()
            }
        }
        TextCellType::Error => {
            if raw_value.is_empty() {
                "#ERROR".to_owned()
            } else {
                format!("#{raw_value}")
            }
        }
        _ => raw_value.to_owned(),
    };
    if matches!(
        kind,
        TextCellType::SharedString | TextCellType::InlineString
    ) {
        value = normalize_field(&value);
    }
    if value.is_empty() && raw_formula.is_empty() {
        return Ok(None);
    }
    Ok(Some(WorkbookCellSnapshotJson {
        value,
        formula: if raw_formula.is_empty() {
            String::new()
        } else {
            format!("={raw_formula}")
        },
    }))
}

fn push_cell(
    cells: &mut Vec<WorkbookCellSnapshotJson>,
    column: Option<usize>,
    kind: TextCellType,
    value: &str,
    formula: &str,
    strings: &mut DiskStrings,
) -> io::Result<()> {
    let Some(column) = column else {
        return Ok(());
    };
    let Some(cell) = cell_snapshot(kind, value, formula, strings)? else {
        return Ok(());
    };
    let column = column.max(cells.len() + 1);
    while cells.len() + 1 < column {
        cells.push(WorkbookCellSnapshotJson {
            value: String::new(),
            formula: String::new(),
        });
    }
    cells.push(cell);
    Ok(())
}

fn read_sheet<R: BufRead>(
    input: R,
    sheet_id: u32,
    strings: &mut DiskStrings,
    writer: &mut RowWriter,
) -> io::Result<WorkbookSheetMetadata> {
    let mut reader = XmlReader::from_reader(input);
    let mut buffer = Vec::new();
    let mut hidden = BTreeSet::new();
    let mut merges = Vec::new();
    let mut row_count = 0usize;
    let mut max_columns = 0usize;
    let mut depth = 0usize;
    let mut saw_root = false;
    let mut row_open = false;
    let mut next_row = 1;
    let mut row_number = 0;
    let mut cells = Vec::new();
    let mut column = Some(1);
    let mut kind = TextCellType::Other;
    let mut value = String::new();
    let mut formula = String::new();
    let mut capture = 0u8;
    let mut phonetic_depth = 0usize;
    loop {
        let event = reader.read_event_into(&mut buffer).map_err(xml_error)?;
        if let Event::Start(ref event) | Event::Empty(ref event) = event {
            if event.local_name().as_ref() != b"c" {
                validate_attributes(&reader, event)?;
            }
            if depth == 0 {
                if saw_root || !matches!(event.local_name().as_ref(), b"worksheet" | b"chartsheet")
                {
                    return Err(xml_error("Multiple worksheet roots"));
                }
                saw_root = true;
            }
            match event.local_name().as_ref() {
                b"dimension" => {
                    if let Some(range_ref) = decode_attr_value(&reader, event, b"ref") {
                        let last = range_ref.split(':').next_back().unwrap_or_default();
                        row_count = row_count.max(try_get_row_number(last).unwrap_or(0));
                        max_columns = max_columns.max(
                            try_get_column_index(last)
                                .map(|column| column + 1)
                                .unwrap_or(0),
                        );
                    }
                }
                b"col" => {
                    if decode_attr_value(&reader, event, b"hidden")
                        .map(|value| is_truthy_flag(&value))
                        .unwrap_or(false)
                    {
                        let min = decode_attr_value(&reader, event, b"min")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(1)
                            .max(1);
                        let max = decode_attr_value(&reader, event, b"max")
                            .and_then(|value| value.parse::<usize>().ok())
                            .unwrap_or(min)
                            .max(min)
                            .min(MAX_WORKBOOK_COLUMN_COUNT);
                        if min <= max {
                            hidden.extend(min - 1..max);
                        }
                    }
                }
                b"mergeCell" => {
                    if let Some(range) = decode_attr_value(&reader, event, b"ref")
                        .and_then(|value| parse_merge_range(&value))
                    {
                        row_count = row_count.max(range.end_row);
                        max_columns = max_columns.max(range.end_col + 1);
                        merges.push(range);
                    }
                }
                _ => {}
            }
        }
        match event {
            Event::Start(event) => {
                depth += 1;
                match event.local_name().as_ref() {
                    b"row" => {
                        if row_open {
                            return Err(xml_error("Nested worksheet row"));
                        }
                        row_number = parse_row_number_attr(&event, next_row);
                        cells.clear();
                        row_open = true;
                        row_count = row_count.max(row_number);
                    }
                    b"c" => {
                        (column, kind) = parse_text_cell_attrs_checked(&event, cells.len() + 1)?;
                        value.clear();
                        formula.clear();
                        max_columns = max_columns.max(column.unwrap_or(0));
                    }
                    b"v" => capture = 1,
                    b"f" => capture = 2,
                    b"rPh" => phonetic_depth += 1,
                    b"t" if matches!(kind, TextCellType::InlineString) && phonetic_depth == 0 => {
                        capture = 1
                    }
                    _ => {}
                }
            }
            Event::Empty(event) => match event.local_name().as_ref() {
                b"row" => {
                    let number = parse_row_number_attr(&event, next_row);
                    writer.write_row(sheet_id, number, Vec::new())?;
                    next_row = number + 1;
                    row_count = row_count.max(number);
                }
                b"c" => {
                    (column, kind) = parse_text_cell_attrs_checked(&event, cells.len() + 1)?;
                    value.clear();
                    formula.clear();
                    push_cell(&mut cells, column, kind, &value, &formula, strings)?;
                }
                _ => {}
            },
            Event::End(event) => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| xml_error("Unexpected closing tag"))?;
                match event.local_name().as_ref() {
                    b"v" | b"f" | b"t" => capture = 0,
                    b"rPh" => phonetic_depth = phonetic_depth.saturating_sub(1),
                    b"c" if row_open => {
                        push_cell(&mut cells, column, kind, &value, &formula, strings)?
                    }
                    b"row" if row_open => {
                        writer.write_row(sheet_id, row_number, std::mem::take(&mut cells))?;
                        next_row = row_number + 1;
                        row_open = false;
                    }
                    _ => {}
                }
            }
            Event::Text(text) if capture > 0 => {
                let decoded = text.decode().map_err(xml_error)?;
                if capture == 2 {
                    formula.push_str(decoded.as_ref());
                } else {
                    value.push_str(decoded.as_ref());
                }
            }
            Event::CData(text) if capture > 0 => {
                let decoded = text.decode().map_err(xml_error)?;
                if capture == 2 {
                    formula.push_str(decoded.as_ref());
                } else {
                    value.push_str(decoded.as_ref());
                }
            }
            Event::GeneralRef(reference) if capture > 0 => {
                let decoded = reference_text(&reference)?;
                if capture == 2 {
                    formula.push_str(&decoded);
                } else {
                    value.push_str(&decoded);
                }
            }
            Event::Eof => {
                if depth != 0 || row_open || !saw_root {
                    return Err(xml_error("Empty or truncated worksheet"));
                }
                break;
            }
            _ => {}
        }
        buffer.clear();
    }
    Ok(WorkbookSheetMetadata {
        hidden_columns: hidden.into_iter().collect(),
        merge_ranges: merges,
        row_count: (row_count > 0).then_some(row_count),
        max_columns: (max_columns > 0).then_some(max_columns),
    })
}

pub(super) fn register_sheet(sheets: &mut Vec<ArtifactSheet>, name: &str, side: &str) -> u32 {
    let id = sheets
        .iter()
        .position(|sheet| sheet.name == name)
        .unwrap_or_else(|| {
            sheets.push(ArtifactSheet {
                id: sheets.len() as u32,
                name: name.to_owned(),
                has_base_side: false,
                has_mine_side: false,
                base_used_columns: Vec::new(),
                mine_used_columns: Vec::new(),
                base_row_count: 0,
                mine_row_count: 0,
                base_cell_count: 0,
                mine_cell_count: 0,
                change_type: "equal".to_owned(),
                rename_peer_name: None,
                rename_role: None,
            });
            sheets.len() - 1
        });
    if side == "base" {
        sheets[id].has_base_side = true;
    } else {
        sheets[id].has_mine_side = true;
    }
    id as u32
}

pub(super) fn ingest(
    path: &str,
    dir: &Path,
    side: &str,
    sheets: &mut Vec<ArtifactSheet>,
) -> io::Result<StoredWorkbook> {
    let mut writer = RowWriter::new(dir, side)?;
    let mut metadata = WorkbookMetadataMap {
        sheets: BTreeMap::new(),
    };
    if fs::metadata(path)?.len() == 0 {
        return writer.finish(dir, side, metadata);
    }
    if is_zip_workbook(path) {
        let mut archive = ZipArchive::new(File::open(path)?).map_err(xml_error)?;
        let infos = zip_sheet_infos(&mut archive)?;
        let mut strings = DiskStrings::open(&mut archive, dir, side)?;
        for (name, path) in infos {
            let id = register_sheet(sheets, &name, side);
            let entry = archive.by_name(&path).map_err(xml_error)?;
            metadata.sheets.insert(
                name,
                read_sheet(
                    BufReader::with_capacity(64 * 1024, entry),
                    id,
                    &mut strings,
                    &mut writer,
                )?,
            );
        }
    } else {
        binary::ingest(path, dir, side, sheets, &mut writer, &mut metadata)?;
    }
    writer.finish(dir, side, metadata)
}

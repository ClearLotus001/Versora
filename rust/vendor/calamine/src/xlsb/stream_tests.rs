use std::fs::File;
use std::io::{self, BufReader, Cursor, Read, Write};
use std::path::PathBuf;

use super::{Xlsb, XlsbCellValue, XlsbError, XlsbStream};
use crate::stream::SharedStrings;
use crate::{Cell, Data, Range, Reader};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Default)]
struct MemoryStrings {
    values: Vec<String>,
    lookups: usize,
}

impl SharedStrings for MemoryStrings {
    fn push(&mut self, value: String) -> io::Result<()> {
        self.values.push(value);
        Ok(())
    }

    fn get(&mut self, id: usize) -> io::Result<Option<String>> {
        self.lookups += 1;
        Ok(self.values.get(id).cloned())
    }

    fn len(&self) -> usize {
        self.values.len()
    }
}

fn fixture(name: &str) -> BufReader<File> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/binary")
        .join(name);
    BufReader::new(File::open(path).unwrap())
}

fn compare_fixture(name: &str) {
    let mut oracle = Xlsb::new(fixture(name)).unwrap();
    let mut strings = MemoryStrings::default();
    let mut stream = XlsbStream::new(fixture(name), &mut strings).unwrap();
    assert_eq!(
        strings.lookups, 0,
        "initialization must only append strings"
    );
    assert!(stream.workbook.strings.is_empty());
    assert_eq!(strings.values, oracle.strings);
    assert_eq!(stream.string_count, oracle.strings.len());
    assert_eq!(stream.metadata().sheets, oracle.metadata().sheets);
    assert_eq!(stream.metadata().names, oracle.metadata().names);
    let names = oracle.sheet_names();
    for name in names {
        let expected = oracle.worksheet_range(&name).unwrap();
        let mut reader = stream.worksheet_cells_reader(&name).unwrap();
        let mut values = Vec::new();
        while let Some(cell) = reader.next_cell().unwrap() {
            let value = match cell.val {
                XlsbCellValue::Value(value) => value,
                XlsbCellValue::SharedStringId(id) => {
                    Data::String(strings.get(id).unwrap().unwrap())
                }
            };
            values.push(Cell::new(cell.pos, value));
        }
        assert_eq!(Range::from_sparse(values), expected, "values in {name}");
        drop(reader);
        let expected = oracle.worksheet_formula(&name).unwrap();
        let mut reader = stream.worksheet_cells_reader(&name).unwrap();
        let mut formulas = Vec::new();
        while let Some(cell) = reader.next_formula().unwrap() {
            if !cell.val.is_empty() {
                formulas.push(cell);
            }
        }
        assert_eq!(Range::from_sparse(formulas), expected, "formulas in {name}");
    }
}

#[test]
fn stream_matches_1900_date_values_and_formulas() {
    compare_fixture("date.xlsb");
}

#[test]
fn stream_matches_1904_date_values_and_formulas() {
    compare_fixture("date_1904.xlsb");
}

#[test]
fn stream_matches_strings_errors_and_sheet_metadata() {
    compare_fixture("issues.xlsb");
}

#[derive(Default)]
struct WriteOnlyStrings {
    count: usize,
}

impl SharedStrings for WriteOnlyStrings {
    fn push(&mut self, _: String) -> io::Result<()> {
        self.count += 1;
        Ok(())
    }

    fn get(&mut self, _: usize) -> io::Result<Option<String>> {
        panic!("ID event iteration must not fetch string contents")
    }

    fn len(&self) -> usize {
        self.count
    }
}

#[test]
fn id_iteration_does_not_fetch_or_retain_shared_strings() {
    let mut strings = WriteOnlyStrings::default();
    let mut stream = XlsbStream::new(fixture("issues.xlsb"), &mut strings).unwrap();
    assert!(strings.count > 0);
    assert!(stream.workbook.strings.is_empty());
    let names: Vec<_> = stream
        .metadata()
        .sheets
        .iter()
        .map(|sheet| sheet.name.clone())
        .collect();
    let mut string_cells = 0;
    for name in names {
        let mut reader = stream.worksheet_cells_reader(&name).unwrap();
        while let Some(cell) = reader.next_cell().unwrap() {
            if let XlsbCellValue::SharedStringId(id) = cell.val {
                assert!(id < strings.count);
                string_cells += 1;
            }
        }
    }
    assert!(string_cells > 0);
}

struct FailingStrings;

impl SharedStrings for FailingStrings {
    fn push(&mut self, _: String) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::StorageFull,
            "test storage full",
        ))
    }

    fn get(&mut self, _: usize) -> io::Result<Option<String>> {
        panic!("initialization must not fetch strings")
    }

    fn len(&self) -> usize {
        0
    }
}

#[test]
fn storage_write_failure_aborts_initialization() {
    let result = XlsbStream::new(fixture("issues.xlsb"), &mut FailingStrings);
    assert!(matches!(
        result,
        Err(XlsbError::Io(error)) if error.kind() == io::ErrorKind::StorageFull
    ));
}

#[test]
fn existing_storage_cannot_shift_source_string_ids() {
    let mut strings = MemoryStrings {
        values: vec!["existing".into()],
        lookups: 0,
    };
    let result = XlsbStream::new(fixture("issues.xlsb"), &mut strings);
    assert!(matches!(
        result,
        Err(XlsbError::Io(error)) if error.kind() == io::ErrorKind::InvalidInput
    ));
    assert_eq!(strings.values, ["existing"]);
}

#[test]
fn stream_preserves_unsupported_sheet_error() {
    let mut strings = MemoryStrings::default();
    let result = XlsbStream::new(fixture("any_sheets.xlsb"), &mut strings);
    let oracle = Xlsb::new(fixture("any_sheets.xlsb"));
    match (result, oracle) {
        (Err(actual), Err(expected)) => assert_eq!(actual.to_string(), expected.to_string()),
        (Ok(mut stream), Ok(mut oracle)) => {
            let names = oracle.sheet_names();
            for name in names {
                let actual = stream.worksheet_cells_reader(&name);
                let expected = oracle.worksheet_cells_reader(&name);
                match (actual, expected) {
                    (Err(actual), Err(expected)) => {
                        assert_eq!(actual.to_string(), expected.to_string());
                        return;
                    }
                    (Ok(_), Ok(_)) => (),
                    _ => panic!("stream and oracle disagree on sheet {name}"),
                }
            }
            panic!("fixture must exercise an unsupported sheet");
        }
        _ => panic!("stream and oracle disagree on workbook initialization"),
    }
}

fn append_record(bytes: &mut Vec<u8>, kind: u16, body: &[u8]) {
    if kind < 0x80 {
        bytes.push(kind as u8);
    } else {
        bytes.push((kind as u8 & 0x7f) | 0x80);
        bytes.push((kind >> 7) as u8);
    }
    let mut length = body.len();
    while length >= 0x80 {
        bytes.push((length as u8 & 0x7f) | 0x80);
        length >>= 7;
    }
    bytes.push(length as u8);
    bytes.extend_from_slice(body);
}

fn shared_strings(values: &[&str]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut counts = Vec::new();
    counts.extend_from_slice(&(values.len() as u32).to_le_bytes());
    counts.extend_from_slice(&(values.len() as u32).to_le_bytes());
    append_record(&mut bytes, 0x9f, &counts);
    for value in values {
        let utf16: Vec<_> = value.encode_utf16().collect();
        let mut body = vec![0]; // Plain RichStr, without formatting runs.
        body.extend_from_slice(&(utf16.len() as u32).to_le_bytes());
        for unit in utf16 {
            body.extend_from_slice(&unit.to_le_bytes());
        }
        append_record(&mut bytes, 0x13, &body);
    }
    append_record(&mut bytes, 0xa0, &[]);
    bytes
}

fn string_sheet(cells: &[(u32, u32, u32)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    append_record(&mut bytes, 0x81, &[]);
    let mut dimensions = Vec::new();
    for value in [0u32, 10, 0, 10] {
        dimensions.extend_from_slice(&value.to_le_bytes());
    }
    append_record(&mut bytes, 0x94, &dimensions);
    append_record(&mut bytes, 0x91, &[]);
    let mut previous_row = None;
    for &(row, column, id) in cells {
        if previous_row != Some(row) {
            let mut header = vec![0; 25];
            header[..4].copy_from_slice(&row.to_le_bytes());
            append_record(&mut bytes, 0, &header);
            previous_row = Some(row);
        }
        let mut body = Vec::new();
        body.extend_from_slice(&column.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&id.to_le_bytes());
        append_record(&mut bytes, 7, &body);
    }
    append_record(&mut bytes, 0x92, &[]);
    append_record(&mut bytes, 0x82, &[]);
    bytes
}

fn add_xml_part(member: &mut impl Read, end_tag: &str, declaration: &str) -> Vec<u8> {
    let mut xml = String::new();
    member.read_to_string(&mut xml).unwrap();
    let offset = xml.rfind(end_tag).expect("fixture XML root closing tag");
    xml.insert_str(offset, declaration);
    xml.into_bytes()
}

// Test packages retain original styles and workbook metadata. The numeric
// template has no SST, so add its part and package declarations when needed.
fn package_with_members(sst: &[u8], sheet: &[u8]) -> Vec<u8> {
    let mut source = ZipArchive::new(fixture("date.xlsb")).unwrap();
    let mut destination = ZipWriter::new(Cursor::new(Vec::new()));
    let mut replaced_sst = false;
    let mut replaced_sheet = false;
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for index in 0..source.len() {
        let mut member = source.by_index(index).unwrap();
        destination.start_file(member.name(), options).unwrap();
        match member.name() {
            "xl/sharedStrings.bin" => {
                destination.write_all(sst).unwrap();
                replaced_sst = true;
            }
            "xl/worksheets/sheet1.bin" => {
                destination.write_all(sheet).unwrap();
                replaced_sheet = true;
            }
            "[Content_Types].xml" => {
                let xml = add_xml_part(
                    &mut member,
                    "</Types>",
                    "<Override PartName=\"/xl/sharedStrings.bin\" ContentType=\"application/vnd.ms-excel.sharedStrings\"/>",
                );
                destination.write_all(&xml).unwrap();
            }
            "xl/_rels/workbook.bin.rels" => {
                let xml = add_xml_part(
                    &mut member,
                    "</Relationships>",
                    "<Relationship Id=\"rIdVersoraStreamSst\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.bin\"/>",
                );
                destination.write_all(&xml).unwrap();
            }
            _ => {
                io::copy(&mut member, &mut destination).unwrap();
            }
        }
    }
    if !replaced_sst {
        destination
            .start_file("xl/sharedStrings.bin", options)
            .unwrap();
        destination.write_all(sst).unwrap();
    }
    assert!(replaced_sheet);
    destination.finish().unwrap().into_inner()
}

fn stream_init_error(package: Vec<u8>) -> XlsbError {
    match XlsbStream::new(Cursor::new(package), &mut MemoryStrings::default()) {
        Err(error) => error,
        Ok(_) => panic!("damaged workbook must fail initialization"),
    }
}

#[test]
fn empty_duplicate_and_unicode_sst_preserve_ids_values_and_actual_bounds() {
    let values = ["", "repeat", "repeat", "中文\t换行\n", "𝄞e\u{301}😀"];
    let cells = [
        (2, 3, 0),
        (2, 4, 1),
        (5, 3, 2),
        (5, 4, 3),
        (5, 5, 4),
        (5, 7, 1),
        (6, 8, 0),
    ];
    let package = package_with_members(&shared_strings(&values), &string_sheet(&cells));
    let mut oracle = Xlsb::new(Cursor::new(package.clone())).unwrap();
    let mut strings = MemoryStrings::default();
    let mut stream = XlsbStream::new(Cursor::new(package), &mut strings).unwrap();
    assert_eq!(strings.values, values);
    assert_eq!(strings.values, oracle.strings);
    let name = stream.sheets_metadata()[0].name.clone();
    let expected = oracle.worksheet_range(&name).unwrap();
    let mut reader = stream.worksheet_cells_reader(&name).unwrap();
    let mut actual = Vec::new();
    let mut ids = Vec::new();
    while let Some(cell) = reader.next_cell().unwrap() {
        let XlsbCellValue::SharedStringId(id) = cell.val else {
            panic!("sheet must contain only shared-string events");
        };
        ids.push(id);
        actual.push(Cell::new(
            cell.pos,
            Data::String(strings.get(id).unwrap().unwrap()),
        ));
    }
    assert_eq!(ids, [0, 1, 2, 3, 4, 1, 0]);
    assert_eq!(Range::from_sparse(actual), expected);
    assert_eq!(expected.start(), Some((2, 3)));
    assert_eq!(expected.end(), Some((6, 8)));
    assert_eq!(
        expected.get_value((6, 8)),
        Some(&Data::String(String::new()))
    );
}

#[test]
fn invalid_sst_id_is_a_controlled_error_in_both_readers() {
    let package = package_with_members(&shared_strings(&["valid"]), &string_sheet(&[(0, 0, 1)]));
    let mut strings = MemoryStrings::default();
    let mut stream = XlsbStream::new(Cursor::new(package.clone()), &mut strings).unwrap();
    let name = stream.sheets_metadata()[0].name.clone();
    let mut reader = stream.worksheet_cells_reader(&name).unwrap();
    assert!(matches!(
        reader.next_cell(),
        Err(XlsbError::SharedStringId { id: 1, len: 1 })
    ));
    let mut oracle = Xlsb::new(Cursor::new(package)).unwrap();
    assert!(matches!(
        oracle.worksheet_range(&name),
        Err(XlsbError::SharedStringId { id: 1, len: 1 })
    ));
}

#[test]
fn short_sst_counts_and_item_headers_fail_without_panicking() {
    let mut short_begin = Vec::new();
    append_record(&mut short_begin, 0x9f, &[0; 7]);
    let mut short_item = Vec::new();
    append_record(&mut short_item, 0x9f, &[1, 0, 0, 0, 1, 0, 0, 0]);
    append_record(&mut short_item, 0x13, &[0; 4]);
    for sst in [short_begin, short_item] {
        let package = package_with_members(&sst, &string_sheet(&[]));
        let error = stream_init_error(package.clone());
        assert!(matches!(
            error,
            XlsbError::Io(error) if error.kind() == io::ErrorKind::InvalidData
        ));
        assert!(matches!(
            Xlsb::new(Cursor::new(package)),
            Err(XlsbError::Io(error)) if error.kind() == io::ErrorKind::InvalidData
        ));
    }
}

#[test]
fn truncated_sst_body_and_declared_missing_item_fail() {
    let complete = shared_strings(&["text"]);
    let mut truncated_body = complete.clone();
    truncated_body.truncate(complete.len() - 8);
    let mut missing_item = complete;
    // BrtBeginSst's two counts start after its two-byte type and length.
    missing_item[3..7].copy_from_slice(&2u32.to_le_bytes());
    missing_item[7..11].copy_from_slice(&2u32.to_le_bytes());
    for sst in [truncated_body, missing_item] {
        let package = package_with_members(&sst, &string_sheet(&[]));
        assert!(matches!(
            stream_init_error(package),
            XlsbError::Io(error) if error.kind() == io::ErrorKind::UnexpectedEof
        ));
    }
}

fn member_offsets(package: &[u8], name: &str) -> (usize, usize) {
    let mut zip = ZipArchive::new(Cursor::new(package)).unwrap();
    let member = zip.by_name(name).unwrap();
    (member.header_start() as usize, member.data_start() as usize)
}

#[test]
fn damaged_sst_local_zip_header_is_not_treated_as_a_missing_optional_member() {
    let mut package = package_with_members(&shared_strings(&["text"]), &string_sheet(&[]));
    let (header, _) = member_offsets(&package, "xl/sharedStrings.bin");
    package[header] ^= 1; // Corrupt the real local ZIP header signature.
    assert!(matches!(stream_init_error(package), XlsbError::Zip(_)));
}

#[test]
fn sst_crc_error_propagates_even_when_its_biff_records_remain_valid() {
    let sst = shared_strings(&["text"]);
    let text = [b't', 0, b'e', 0, b'x', 0, b't', 0];
    let text_offset = sst
        .windows(text.len())
        .position(|item| item == text)
        .unwrap();
    let mut package = package_with_members(&sst, &string_sheet(&[(0, 0, 0)]));
    let (_, data) = member_offsets(&package, "xl/sharedStrings.bin");
    package[data + text_offset] = b'n'; // Valid UTF16; retain the old ZIP CRC.
                                        // Independently confirm that the archive's checksum, not its BIFF layout,
                                        // is damaged before exercising the workbook decoder.
    let mut zip = ZipArchive::new(Cursor::new(&package)).unwrap();
    let mut member = zip.by_name("xl/sharedStrings.bin").unwrap();
    let error = member.read_to_end(&mut Vec::new()).unwrap_err();
    assert!(error.to_string().contains("Invalid checksum"));
    drop(member);
    drop(zip);
    assert!(matches!(
        stream_init_error(package),
        XlsbError::Io(error) if error.kind() == io::ErrorKind::InvalidData
            && error.to_string().contains("Invalid checksum")
    ));
}

#[test]
fn worksheet_crc_error_propagates_from_value_and_formula_completion() {
    let sheet = string_sheet(&[(0, 0, 0)]);
    let mut package = package_with_members(&shared_strings(&["text"]), &sheet);
    let (_, data) = member_offsets(&package, "xl/worksheets/sheet1.bin");
    // Corrupt BrtEndSheet after the logical cell section, retaining its ZIP CRC.
    package[data + sheet.len() - 1] ^= 1;
    let mut strings = MemoryStrings::default();
    let mut stream = XlsbStream::new(Cursor::new(package), &mut strings).unwrap();
    let name = stream.sheets_metadata()[0].name.clone();
    let mut reader = stream.worksheet_cells_reader(&name).unwrap();
    assert!(reader.next_cell().unwrap().is_some());
    assert!(matches!(
        reader.next_cell(),
        Err(XlsbError::Io(error)) if error.to_string().contains("Invalid checksum")
    ));
    drop(reader);
    let mut reader = stream.worksheet_cells_reader(&name).unwrap();
    assert!(matches!(
        reader.next_formula(),
        Err(XlsbError::Io(error)) if error.to_string().contains("Invalid checksum")
    ));
}

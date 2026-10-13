// SPDX-License-Identifier: MIT
// Copyright 2016-2025, Johann Tuffe.
// Versora extension: seekable XLS globals and worksheet event decoding.

use std::io::{self, BufReader, Read, Seek, SeekFrom};

use super::*;
use crate::stream::SharedStrings;

/// Receives worksheet records in their original order.
///
/// Values and formulas are independent channels. Consumers must preserve the
/// last record for each coordinate in each channel, including empty values,
/// and derive value bounds before filtering empty cells. The decoder does not
/// assume sorted coordinates and does not allocate a worksheet rectangle.
pub trait XlsSheetSink {
    /// A decoded value record, including a formula's cached result.
    fn value(&mut self, cell: Cell<Data>) -> io::Result<()>;
    /// A decoded formula record.
    fn formula(&mut self, cell: Cell<String>) -> io::Result<()>;
    /// A merged cell region.
    fn merge(&mut self, dimensions: Dimensions) -> io::Result<()>;
}

/// An XLS reader that retains globals but no Workbook payload or cell ranges.
///
/// The compound container owns the underlying seekable reader throughout each
/// stream's lifetime. Its directory/FAT metadata, styles, names and sheet
/// metadata still scale with the corresponding file structures. SST text is
/// stored exclusively in the supplied `SharedStrings` implementation.
pub struct XlsStream<RS: Read + Seek> {
    compound: ::cfb::CompoundFile<RS>,
    workbook_path: &'static str,
    metadata: Metadata,
    sheet_offsets: Vec<u64>,
    formula_sheet_names: Vec<String>,
    xtis: Vec<Xti>,
    formats: Vec<CellFormat>,
    encoding: XlsEncoding,
    biff: Biff,
    is_1904: bool,
    sst_start: usize,
    sst_len: usize,
}

impl<RS: Read + Seek> XlsStream<RS> {
    /// Reads workbook globals and writes SST items directly into `strings`.
    pub fn new<S: SharedStrings + ?Sized>(reader: RS, strings: &mut S) -> Result<Self, XlsError> {
        Self::new_with_options(reader, strings, XlsOptions::default())
    }

    /// Creates a streaming reader, preserving the original codepage override.
    /// Header row selection belongs to the consuming sink because there is no
    /// Range in this interface; every decoded source record is emitted.
    pub fn new_with_options<S: SharedStrings + ?Sized>(
        reader: RS,
        strings: &mut S,
        options: XlsOptions,
    ) -> Result<Self, XlsError> {
        let mut compound = ::cfb::CompoundFile::open(reader)?;
        // Both names are part of the XLS format, not a decoder fallback.
        let workbook_path = if compound.is_stream("/Workbook") {
            "/Workbook"
        } else {
            "/Book"
        };
        let workbook = compound.open_stream(workbook_path)?;
        let mut records = StreamRecords::new(BufReader::with_capacity(64 * 1024, workbook));
        let mut metadata = Metadata::default();
        let mut sheet_offsets = Vec::new();
        let mut defined_names = Vec::new();
        let mut xtis = Vec::new();
        let mut custom_formats = BTreeMap::new();
        let mut xfs = Vec::new();
        let mut biff = Biff::Biff8;
        let mut encoding = XlsEncoding::from_codepage(options.force_codepage.unwrap_or(1200))?;
        let mut is_1904 = false;
        let mut sst_start = strings.len();
        let mut sst_len = 0;

        while let Some(typ) = records.next_record()? {
            if typ == 0x00FC {
                // The old decoder replaces its SST at every SST record. A
                // segment offset preserves that behavior without a store reset.
                sst_start = strings.len();
                parse_sst_into(&mut records, &encoding, |value| {
                    strings.push(value).map_err(XlsError::Io)
                })?;
                sst_len = strings.len().checked_sub(sst_start).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "SST store length decreased")
                })?;
                continue;
            }
            let mut record = Record {
                typ,
                data: records.data(),
                cont: None,
            };
            match typ {
                0x002F => {
                    require_len(record.data, 2, "FilePass")?;
                    if read_u16(record.data) != 0 {
                        return Err(XlsError::Password);
                    }
                }
                0x0042 if options.force_codepage.is_none() => {
                    require_len(record.data, 2, "CodePage")?;
                    encoding = XlsEncoding::from_codepage(read_u16(record.data))?;
                }
                0x0022 => {
                    require_len(record.data, 2, "Date1904")?;
                    if read_u16(record.data) == 1 {
                        is_1904 = true;
                    }
                }
                0x041E => match parse_format(&mut record, &encoding, biff) {
                    Ok((index, format)) => {
                        custom_formats.insert(index, format);
                    }
                    Err(error) => log::warn!("{error}"),
                },
                0x00E0 => xfs.push(parse_xf(&record)?),
                0x0085 => {
                    require_len(record.data, 8, "BoundSheet")?;
                    let (offset, sheet) = parse_sheet_metadata(&mut record, &encoding, biff)?;
                    metadata.sheets.push(sheet);
                    sheet_offsets.push(offset as u64);
                }
                0x0809 => {
                    require_len(record.data, 2, "BOF")?;
                    biff = parse_bof(&mut record)?.biff;
                }
                0x0018 => {
                    require_len(record.data, 14, "Lbl")?;
                    let cch = record.data[3] as usize;
                    let cce = read_u16(&record.data[4..]) as usize;
                    require_len(record.data, 14 + cch + 1, "Lbl name")?;
                    require_len(record.data, cce, "Lbl formula")?;
                    let mut name = String::new();
                    read_unicode_string_no_cch(&encoding, &record.data[14..], &cch, &mut name);
                    let formula = parse_defined_names(&record.data[record.data.len() - cce..])?;
                    defined_names.push((name, formula));
                }
                0x0017 => {
                    require_len(record.data, 2, "ExternSheet")?;
                    let count = read_u16(record.data) as usize;
                    require_len(record.data, 2 + count * 6, "ExternSheet")?;
                    for xti in record.data[2..].chunks_exact(6).take(count) {
                        xtis.push(Xti {
                            _isup_book: read_u16(&xti[..2]),
                            itab_first: read_i16(&xti[2..4]),
                            _itab_last: read_i16(&xti[4..]),
                        });
                    }
                }
                0x000A => break,
                _ => (),
            }
        }

        let formula_sheet_names = metadata
            .sheets
            .iter()
            .map(|sheet| sheet.name.clone())
            .collect::<Vec<_>>();
        metadata.names = defined_names
            .into_iter()
            .map(|(name, (index, mut formula))| {
                if let Some(index) = index {
                    let sheet = xtis
                        .get(index)
                        .and_then(|xti| formula_sheet_names.get(xti.itab_first as usize))
                        .map_or("#REF", String::as_str);
                    formula = format!("{sheet}!{formula}");
                }
                (name, formula)
            })
            .collect();
        let formats = xfs
            .into_iter()
            .map(|format| {
                custom_formats
                    .get(&format)
                    .copied()
                    .unwrap_or_else(|| builtin_format_by_code(format))
            })
            .collect();
        drop(records);
        Ok(Self {
            compound,
            workbook_path,
            metadata,
            sheet_offsets,
            formula_sheet_names,
            xtis,
            formats,
            encoding,
            biff,
            is_1904,
            sst_start,
            sst_len,
        })
    }

    /// Workbook metadata and defined names in their original order.
    pub fn metadata(&self) -> &Metadata {
        &self.metadata
    }

    /// Sheet names, types and visibility in BoundSheet record order.
    pub fn sheets_metadata(&self) -> &[Sheet] {
        &self.metadata.sheets
    }

    /// Emits the indexed sheet's values, formulas and merged regions.
    /// The string store must be the same store populated during construction.
    pub fn read_sheet<S: SharedStrings + ?Sized, T: XlsSheetSink + ?Sized>(
        &mut self,
        index: usize,
        strings: &mut S,
        sink: &mut T,
    ) -> Result<(), XlsError> {
        let offset = *self
            .sheet_offsets
            .get(index)
            .ok_or_else(|| XlsError::WorksheetNotFound(index.to_string()))?;
        let mut workbook = self.compound.open_stream(self.workbook_path)?;
        workbook.seek(SeekFrom::Start(offset))?;
        let mut records = StreamRecords::new(BufReader::with_capacity(64 * 1024, workbook));
        let mut formula_position = (0, 0);
        let mut batch_values = Vec::new();
        let mut batch_merges = Vec::new();
        while let Some(typ) = records.next_record()? {
            let data = records.data();
            match typ {
                // Validate DIMENSIONS as before, but never reserve its rectangle.
                0x0200 => {
                    parse_dimensions(data)?;
                }
                // BLANK records are ignored by the original decoder.
                0x0203 => sink.value(parse_number(data, &self.formats, self.is_1904)?)?,
                0x0204 => sink.value(parse_label(data, &self.encoding, self.biff)?)?,
                0x0205 => sink.value(parse_bool_err(data)?)?,
                0x0207 => sink.value(Cell::new(
                    formula_position,
                    Data::String(parse_string(data, &self.encoding, self.biff)?),
                ))?,
                0x027E => sink.value(parse_rk(data, &self.formats, self.is_1904)?)?,
                0x00FD => {
                    let value = parse_label_sst_with(data, |id| {
                        if id >= self.sst_len {
                            return Ok(None);
                        }
                        let store_id = self.sst_start.checked_add(id).ok_or_else(|| {
                            io::Error::new(io::ErrorKind::InvalidData, "SST ID overflow")
                        })?;
                        // A missing item within a valid source ID is store
                        // corruption; an out-of-range source ID is ignored.
                        strings.get(store_id)?.map(Some).ok_or_else(|| {
                            XlsError::Io(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "missing stored XLS shared string",
                            ))
                        })
                    })?;
                    if let Some(value) = value {
                        sink.value(value)?;
                    }
                }
                0x00BD => {
                    batch_values.clear();
                    parse_mul_rk(data, &mut batch_values, &self.formats, self.is_1904)?;
                    for value in batch_values.drain(..) {
                        sink.value(value)?;
                    }
                }
                0x00E5 => {
                    require_len(data, 2, "MergeCells")?;
                    require_len(data, 2 + read_u16(data) as usize * 8, "MergeCells")?;
                    batch_merges.clear();
                    parse_merge_cells(data, &mut batch_merges)?;
                    for dimensions in batch_merges.drain(..) {
                        sink.merge(dimensions)?;
                    }
                }
                0x0006 => {
                    let decoded = parse_formula_cell(
                        data,
                        &self.formula_sheet_names,
                        &self.metadata.names,
                        &self.xtis,
                        &self.encoding,
                    )?;
                    formula_position = decoded.position;
                    if let Some(value) = decoded.value {
                        sink.value(Cell::new(formula_position, value))?;
                    }
                    sink.formula(Cell::new(formula_position, decoded.formula))?;
                }
                0x000A => break,
                _ => (),
            }
        }
        Ok(())
    }
}

fn require_len(data: &[u8], expected: usize, typ: &'static str) -> Result<(), XlsError> {
    if data.len() < expected {
        Err(XlsError::Len {
            expected,
            found: data.len(),
            typ,
        })
    } else {
        Ok(())
    }
}

/// Holds one record payload (at most a u16 record length), never a chain of
/// CONTINUE payloads. A single pending header preserves the next record while
/// SST decoding consumes continuation bytes on demand.
struct StreamRecords<R: Read> {
    reader: R,
    payload: Vec<u8>,
    offset: usize,
    pending: Option<[u8; 4]>,
    active: bool,
}

impl<R: Read> StreamRecords<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            payload: Vec::new(),
            offset: 0,
            pending: None,
            active: false,
        }
    }

    fn header(&mut self) -> Result<Option<[u8; 4]>, XlsError> {
        if let Some(header) = self.pending.take() {
            return Ok(Some(header));
        }
        let mut header = [0u8; 4];
        loop {
            match self.reader.read(&mut header[..1]) {
                Ok(0) => return Ok(None),
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
        self.reader
            .read_exact(&mut header[1..])
            .map_err(|error| match error.kind() {
                io::ErrorKind::UnexpectedEof => XlsError::EoStream("record type and length"),
                _ => error.into(),
            })?;
        Ok(Some(header))
    }

    fn load(&mut self, header: [u8; 4]) -> Result<(), XlsError> {
        self.payload.resize(read_u16(&header[2..]) as usize, 0);
        self.offset = 0;
        self.reader
            .read_exact(&mut self.payload)
            .map_err(|error| match error.kind() {
                io::ErrorKind::UnexpectedEof => XlsError::EoStream("record length"),
                _ => error.into(),
            })
    }

    fn next_record(&mut self) -> Result<Option<u16>, XlsError> {
        if self.active {
            while self.continue_record()? {}
        }
        let Some(header) = self.header()? else {
            self.active = false;
            return Ok(None);
        };
        self.load(header)?;
        self.active = true;
        Ok(Some(read_u16(&header)))
    }
}

impl<R: Read> RecordPayload for StreamRecords<R> {
    fn data(&self) -> &[u8] {
        &self.payload[self.offset..]
    }

    fn advance(&mut self, len: usize) {
        self.offset += len;
    }

    fn continue_record(&mut self) -> Result<bool, XlsError> {
        let Some(header) = self.header()? else {
            return Ok(false);
        };
        if read_u16(&header) != 0x003C {
            self.pending = Some(header);
            return Ok(false);
        }
        self.load(header)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    #[derive(Default)]
    struct Strings(Vec<String>);

    impl SharedStrings for Strings {
        fn push(&mut self, value: String) -> io::Result<()> {
            self.0.push(value);
            Ok(())
        }
        fn get(&mut self, id: usize) -> io::Result<Option<String>> {
            Ok(self.0.get(id).cloned())
        }
        fn len(&self) -> usize {
            self.0.len()
        }
    }

    #[derive(Default)]
    struct Sink {
        values: Vec<Cell<Data>>,
        formulas: Vec<Cell<String>>,
        merges: Vec<Dimensions>,
    }

    impl XlsSheetSink for Sink {
        fn value(&mut self, cell: Cell<Data>) -> io::Result<()> {
            self.values.push(cell);
            Ok(())
        }
        fn formula(&mut self, cell: Cell<String>) -> io::Result<()> {
            self.formulas.push(cell);
            Ok(())
        }
        fn merge(&mut self, dimensions: Dimensions) -> io::Result<()> {
            self.merges.push(dimensions);
            Ok(())
        }
    }

    fn append_record(target: &mut Vec<u8>, kind: u16, payload: &[u8]) {
        target.extend(kind.to_le_bytes());
        target.extend(u16::try_from(payload.len()).unwrap().to_le_bytes());
        target.extend(payload);
    }

    fn append_number(target: &mut Vec<u8>, row: u16, column: u16, value: f64) {
        let mut payload = Vec::new();
        payload.extend(row.to_le_bytes());
        payload.extend(column.to_le_bytes());
        payload.extend(0u16.to_le_bytes());
        payload.extend(value.to_le_bytes());
        append_record(target, 0x0203, &payload);
    }

    fn append_sst_cell(target: &mut Vec<u8>, row: u16, column: u16, id: u32) {
        let mut payload = Vec::new();
        payload.extend(row.to_le_bytes());
        payload.extend(column.to_le_bytes());
        payload.extend(0u16.to_le_bytes());
        payload.extend(id.to_le_bytes());
        append_record(target, 0x00FD, &payload);
    }

    fn append_formula(target: &mut Vec<u8>, row: u16, column: u16, cache: [u8; 8]) {
        let mut payload = Vec::new();
        payload.extend(row.to_le_bytes());
        payload.extend(column.to_le_bytes());
        payload.extend(0u16.to_le_bytes());
        payload.extend(cache);
        payload.extend([0; 6]);
        // Formula token stream: literal integer 7.
        payload.extend([3, 0, 0x1e, 7, 0]);
        append_record(target, 0x0006, &payload);
    }

    fn globals() -> Vec<u8> {
        let mut globals = Vec::new();
        append_record(&mut globals, 0x0809, &[0, 6, 5, 0]);
        append_record(&mut globals, 0x0042, &1200u16.to_le_bytes());
        globals
    }

    fn container(
        version: ::cfb::Version,
        path: &str,
        mut globals: Vec<u8>,
        sheets: Vec<(&str, Vec<u8>)>,
    ) -> Vec<u8> {
        let biff5 = read_u16(&globals[4..]) == 0x0500;
        let boundsheet_header = if biff5 { 11 } else { 12 };
        let mut offset = globals.len()
            + sheets
                .iter()
                .map(|(name, _)| boundsheet_header + name.len())
                .sum::<usize>()
            + 4;
        for (name, data) in &sheets {
            let mut payload = Vec::new();
            payload.extend((offset as u32).to_le_bytes());
            payload.extend([0, 0, name.len() as u8]);
            if !biff5 {
                payload.push(0);
            }
            payload.extend(name.as_bytes());
            append_record(&mut globals, 0x0085, &payload);
            offset += data.len();
        }
        append_record(&mut globals, 0x000A, &[]);
        for (_, data) in sheets {
            globals.extend(data);
        }
        let mut compound =
            ::cfb::CompoundFile::create_with_version(version, Cursor::new(Vec::new())).unwrap();
        compound
            .create_stream(path)
            .unwrap()
            .write_all(&globals)
            .unwrap();
        compound.into_inner().into_inner()
    }

    fn assert_same(bytes: &[u8]) {
        let mut old = Xls::new(Cursor::new(bytes)).unwrap();
        let mut strings = Strings::default();
        let mut new = XlsStream::new(Cursor::new(bytes), &mut strings).unwrap();
        assert_eq!(new.sheets_metadata(), old.metadata().sheets);
        assert_eq!(new.metadata().names, old.metadata().names);
        for index in 0..new.sheets_metadata().len() {
            let name = new.sheets_metadata()[index].name.clone();
            let mut sink = Sink::default();
            new.read_sheet(index, &mut strings, &mut sink).unwrap();
            let values = Range::from_sparse(sink.values);
            let formulas = Range::from_sparse(sink.formulas);
            let expected_values = old.worksheet_range(&name).unwrap();
            let expected_formulas = old.worksheet_formula(&name).unwrap();
            assert_eq!(values.start(), expected_values.start());
            assert_eq!(values.end(), expected_values.end());
            assert_eq!(
                values.rows().collect::<Vec<_>>(),
                expected_values.rows().collect::<Vec<_>>()
            );
            assert_eq!(formulas.start(), expected_formulas.start());
            assert_eq!(formulas.end(), expected_formulas.end());
            assert_eq!(
                formulas.rows().collect::<Vec<_>>(),
                expected_formulas.rows().collect::<Vec<_>>()
            );
            assert_eq!(sink.merges, old.worksheet_merge_cells(&name).unwrap());
        }
    }

    type SheetEvents = (
        Vec<((u32, u32), Data)>,
        Vec<((u32, u32), String)>,
        Vec<Dimensions>,
    );

    fn event_snapshot(bytes: &[u8]) -> Vec<SheetEvents> {
        let mut strings = Strings::default();
        let mut workbook = XlsStream::new(Cursor::new(bytes), &mut strings).unwrap();
        (0..workbook.sheets_metadata().len())
            .map(|index| {
                let mut sink = Sink::default();
                workbook.read_sheet(index, &mut strings, &mut sink).unwrap();
                (
                    sink.values
                        .into_iter()
                        .map(|cell| (cell.pos, cell.val))
                        .collect(),
                    sink.formulas
                        .into_iter()
                        .map(|cell| (cell.pos, cell.val))
                        .collect(),
                    sink.merges,
                )
            })
            .collect()
    }

    #[test]
    fn sst_continues_encoding_rich_runs_and_extension_share_oracle() {
        let mut globals = globals();
        let mut sst = Vec::new();
        // XLS 0.31 ignores the two advertised counts.
        sst.extend(999u32.to_le_bytes());
        sst.extend(999u32.to_le_bytes());
        sst.extend(5u16.to_le_bytes());
        sst.push(0x0d); // UTF-16, rich text, extension.
        sst.extend(1u16.to_le_bytes());
        sst.extend(3u32.to_le_bytes());
        sst.extend(('A' as u16).to_le_bytes());
        append_record(&mut globals, 0x00FC, &sst);
        append_record(&mut globals, 0x003C, &[0, b'B', b'C']);
        let mut continuation = vec![1];
        continuation.extend(('中' as u16).to_le_bytes());
        continuation.extend(('D' as u16).to_le_bytes());
        continuation.extend([0; 2]); // First half of a rich run.
        append_record(&mut globals, 0x003C, &continuation);
        // Rich/ext continuation has no Unicode compression flag.
        append_record(&mut globals, 0x003C, &[0, 0, 9, 8, 7, 0, 0, 0]);
        let mut sheet = Vec::new();
        append_number(&mut sheet, 8, 2, 9.0);
        append_sst_cell(&mut sheet, 3, 1, 0);
        append_sst_cell(&mut sheet, 8, 2, 1); // Empty SST does not erase 9.
        append_sst_cell(&mut sheet, 8, 2, 50); // Invalid source ID ignored.
        append_record(&mut sheet, 0x0201, &[8, 0, 2, 0, 0, 0]);
        append_record(&mut sheet, 0x000A, &[]);
        let bytes = container(
            ::cfb::Version::V3,
            "/Workbook",
            globals,
            vec![("Data", sheet)],
        );
        let mut strings = Strings::default();
        let mut new = XlsStream::new(Cursor::new(&bytes), &mut strings).unwrap();
        assert_eq!(strings.0, ["ABC中D", ""]);
        let mut sink = Sink::default();
        new.read_sheet(0, &mut strings, &mut sink).unwrap();
        assert_eq!(sink.values.len(), 2);
        assert_same(&bytes);
    }

    #[test]
    fn unordered_duplicate_values_and_formula_string_match_in_both_cfb_versions() {
        for version in [::cfb::Version::V3, ::cfb::Version::V4] {
            for path in ["/Workbook", "/Book"] {
                let mut first = Vec::new();
                append_number(&mut first, 9, 5, 3.0);
                append_number(&mut first, 2, 1, 2.0);
                append_number(&mut first, 9, 5, 4.0);
                // An empty LABEL is an actual overwrite event and participates
                // in value bounds, unlike a BLANK or an empty LabelSst.
                append_record(&mut first, 0x0204, &[9, 0, 5, 0, 0, 0, 0, 0, 0]);
                append_formula(&mut first, 3, 2, [0, 0, 0, 0, 0, 0, 255, 255]);
                append_record(&mut first, 0x0207, &[2, 0, 0, b'O', b'K']);
                append_formula(&mut first, 9, 5, [3, 0, 0, 0, 0, 0, 255, 255]);
                append_formula(&mut first, 20, 8, [0, 0, 0, 0, 0, 0, 255, 255]);
                append_record(&mut first, 0x00E5, &[1, 0, 2, 0, 4, 0, 1, 0, 3, 0]);
                // Ensure the Workbook is a regular stream rather than only a
                // mini-stream; ignored payload never grows with total size.
                append_record(&mut first, 0x00FF, &[0; 8192]);
                append_record(&mut first, 0x000A, &[]);
                let mut second = Vec::new();
                append_number(&mut second, 0, 0, 42.0);
                append_record(&mut second, 0x000A, &[]);
                let reference = container(
                    ::cfb::Version::V3,
                    path,
                    globals(),
                    vec![("One", first.clone()), ("Two", second.clone())],
                );
                assert_same(&reference);
                let bytes = container(
                    version,
                    path,
                    globals(),
                    vec![("One", first), ("Two", second)],
                );
                // The original CFB decoder rejects this legal V4 fixture with
                // EmptyRootDir; compare the same BIFF payload's exact events.
                assert_eq!(event_snapshot(&bytes), event_snapshot(&reference));
            }
        }
    }

    #[test]
    fn malformed_continuation_and_missing_store_entries_are_errors() {
        let mut source = Vec::new();
        append_record(
            &mut source,
            0x00FC,
            &[1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, b'A'],
        );
        append_record(&mut source, 0x003C, &[]);
        let mut cursor = StreamRecords::new(Cursor::new(source));
        cursor.next_record().unwrap();
        assert!(matches!(
            parse_sst_into(
                &mut cursor,
                &XlsEncoding::from_codepage(1200).unwrap(),
                |_| Ok(())
            ),
            Err(XlsError::ContinueRecordTooShort)
        ));

        let mut globals = globals();
        append_record(
            &mut globals,
            0x00FC,
            &[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, b'A'],
        );
        let mut sheet = Vec::new();
        append_sst_cell(&mut sheet, 0, 0, 0);
        append_record(&mut sheet, 0x000A, &[]);
        let bytes = container(
            ::cfb::Version::V3,
            "/Workbook",
            globals,
            vec![("Data", sheet)],
        );
        let mut strings = Strings::default();
        let mut new = XlsStream::new(Cursor::new(bytes), &mut strings).unwrap();
        strings.0.clear();
        assert!(matches!(
            new.read_sheet(0, &mut strings, &mut Sink::default()),
            Err(XlsError::Io(_))
        ));
    }

    #[test]
    fn repeated_sst_uses_last_segment_and_store_write_failure_propagates() {
        let mut globals = globals();
        append_record(
            &mut globals,
            0x00FC,
            &[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, b'A'],
        );
        append_record(
            &mut globals,
            0x00FC,
            &[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, b'B'],
        );
        let mut sheet = Vec::new();
        append_sst_cell(&mut sheet, 0, 0, 0);
        append_record(&mut sheet, 0x000A, &[]);
        let bytes = container(::cfb::Version::V3, "/Book", globals, vec![("Data", sheet)]);
        assert_same(&bytes);
        struct FailingStore;
        impl SharedStrings for FailingStore {
            fn push(&mut self, _: String) -> io::Result<()> {
                Err(io::Error::new(
                    io::ErrorKind::StorageFull,
                    "injected store failure",
                ))
            }
            fn get(&mut self, _: usize) -> io::Result<Option<String>> {
                unreachable!()
            }
            fn len(&self) -> usize {
                0
            }
        }
        assert!(matches!(
            XlsStream::new(Cursor::new(bytes), &mut FailingStore),
            Err(XlsError::Io(_))
        ));
    }

    #[test]
    fn biff5_codepage_dates_cached_types_and_formula_fallback_match_oracle() {
        let mut globals = Vec::new();
        append_record(&mut globals, 0x0809, &[0, 5, 5, 0]);
        append_record(&mut globals, 0x0042, &1252u16.to_le_bytes());
        append_record(&mut globals, 0x0022, &[1, 0]);
        append_record(&mut globals, 0x00E0, &[0, 0, 14, 0]);
        let mut sheet = Vec::new();
        append_record(
            &mut sheet,
            0x0204,
            &[0, 0, 0, 0, 0, 0, 4, 0, b'C', b'a', b'f', 0xe9],
        );
        append_number(&mut sheet, 1, 1, 1.25);
        append_formula(&mut sheet, 2, 1, [1, 0, 1, 0, 0, 0, 255, 255]);
        append_formula(&mut sheet, 3, 1, [2, 0, 0x07, 0, 0, 0, 255, 255]);
        append_formula(&mut sheet, 4, 1, [3, 0, 0, 0, 0, 0, 255, 255]);
        append_formula(&mut sheet, 5, 1, 12.0f64.to_le_bytes());
        // Replace the final valid formula token with a deliberately unknown
        // one. Invalid XLS formula text remains a value, not a fatal error.
        let end = sheet.len();
        sheet[end - 3] = 0xff;
        append_record(&mut sheet, 0x000A, &[]);
        let bytes = container(::cfb::Version::V3, "/Book", globals, vec![("Data", sheet)]);
        assert_same(&bytes);
        let mut strings = Strings::default();
        let mut workbook = XlsStream::new(Cursor::new(bytes), &mut strings).unwrap();
        assert_eq!(workbook.sheets_metadata()[0].name, "Data");
        let mut sink = Sink::default();
        workbook.read_sheet(0, &mut strings, &mut sink).unwrap();
        assert_eq!(sink.values[0].val, Data::String("Café".to_string()));
        assert!(matches!(sink.values[1].val, Data::DateTime(_)));
        assert_eq!(sink.values[2].val, Data::Bool(true));
        assert_eq!(sink.values[3].val, Data::Error(CellErrorType::Div0));
        assert_eq!(sink.values[4].val, Data::String(String::new()));
        // Numeric formula caches retain 0.31's Float behavior, even on a
        // date-formatted cell in a 1904 workbook.
        assert_eq!(sink.values[5].val, Data::Float(12.0));
        assert!(sink
            .formulas
            .last()
            .unwrap()
            .val
            .starts_with("Unrecognised formula for cell (5, 1):"));
    }
}

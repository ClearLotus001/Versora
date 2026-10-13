use super::cell_sort::CellSorter;
use super::strings::DiskStrings;
use super::*;
use calamine::{Cell, Dimensions, XlsSheetSink, XlsStream, XlsbCellValue, XlsbStream};
use std::io::BufReader;
use std::path::PathBuf;

#[cfg(test)]
#[path = "binary_tests.rs"]
mod tests;

fn binary_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("Invalid binary workbook: {error}"))
}

type FormulaRecord = (u32, u32, String);

// XLSB values and formulas have separate streaming passes. Keep formulas in an
// ordered, sparse disk stream and merge them into each current value row.
struct FormulaScratch {
    path: PathBuf,
    reader: Option<BufReader<File>>,
    next: Option<FormulaRecord>,
}

impl Drop for FormulaScratch {
    fn drop(&mut self) {
        self.reader.take();
        let _ = fs::remove_file(&self.path);
    }
}

impl FormulaScratch {
    fn write(
        dir: &Path,
        side: &str,
        records: impl Iterator<Item = io::Result<FormulaRecord>>,
    ) -> io::Result<Self> {
        let path = dir.join(format!("{side}.formulas.bin"));
        let mut scratch = Self {
            path,
            reader: None,
            next: None,
        };
        {
            let mut output = BufWriter::with_capacity(64 * 1024, File::create(&scratch.path)?);
            let mut row_number = None;
            let mut columns = BTreeMap::new();
            for record in records {
                let (row, column, formula) = record?;
                validate_position(row, column)?;
                if row_number.is_some_and(|previous| row < previous) {
                    return Err(binary_error("Formula rows are out of order"));
                }
                if row_number.is_some_and(|previous| row != previous) {
                    Self::write_row(&mut output, row_number.unwrap(), &columns)?;
                    columns.clear();
                }
                row_number = Some(row);
                columns.insert(column, formula);
            }
            if let Some(row) = row_number {
                Self::write_row(&mut output, row, &columns)?;
            }
            output.flush()?;
        }
        scratch.reader = Some(BufReader::with_capacity(
            64 * 1024,
            File::open(&scratch.path)?,
        ));
        scratch.advance()?;
        Ok(scratch)
    }

    fn write_row(
        output: &mut impl Write,
        row: u32,
        columns: &BTreeMap<u32, String>,
    ) -> io::Result<()> {
        for (&column, formula) in columns {
            let formula = formula.trim();
            if formula.is_empty() {
                continue;
            }
            let length = u32::try_from(formula.len())
                .map_err(|_| binary_error("Formula exceeds binary record size"))?;
            output.write_all(&row.to_le_bytes())?;
            output.write_all(&column.to_le_bytes())?;
            output.write_all(&length.to_le_bytes())?;
            output.write_all(formula.as_bytes())?;
        }
        Ok(())
    }

    fn advance(&mut self) -> io::Result<()> {
        let reader = self.reader.as_mut().unwrap();
        let mut header = [0; 12];
        if reader.read(&mut header[..1])? == 0 {
            self.next = None;
            return Ok(());
        }
        reader.read_exact(&mut header[1..])?;
        let row = u32::from_le_bytes(header[..4].try_into().unwrap());
        let column = u32::from_le_bytes(header[4..8].try_into().unwrap());
        let length = u32::from_le_bytes(header[8..].try_into().unwrap()) as usize;
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes)?;
        self.next = Some((row, column, String::from_utf8(bytes).map_err(binary_error)?));
        Ok(())
    }

    fn apply_row(
        &mut self,
        row: u32,
        bounds: Dimensions,
        cells: &mut Vec<WorkbookCellSnapshotJson>,
    ) -> io::Result<()> {
        while self.next.as_ref().is_some_and(|record| record.0 < row) {
            self.advance()?;
        }
        while self.next.as_ref().is_some_and(|record| record.0 == row) {
            let (_, column, formula) = self.next.take().unwrap();
            if column >= bounds.start.1 && column <= bounds.end.1 {
                let column = column as usize;
                if cells.len() <= column {
                    cells.resize_with(column + 1, empty_cell);
                }
                cells[column].formula = format!("={formula}");
            }
            self.advance()?;
        }
        Ok(())
    }
}

fn validate_position(row: u32, column: u32) -> io::Result<()> {
    if row as usize >= MAX_WORKBOOK_ROW_NUMBER || column as usize >= MAX_WORKBOOK_COLUMN_COUNT {
        return Err(binary_error("Cell position is outside worksheet bounds"));
    }
    Ok(())
}

fn empty_cell() -> WorkbookCellSnapshotJson {
    WorkbookCellSnapshotJson {
        value: String::new(),
        formula: String::new(),
    }
}

fn write_values(
    writer: &mut RowWriter,
    sheet_id: u32,
    bounds: Option<Dimensions>,
    mut values: impl Iterator<Item = io::Result<(u32, u32, String)>>,
    formulas: &mut FormulaScratch,
) -> io::Result<()> {
    let Some(bounds) = bounds else {
        return Ok(());
    };
    let mut next = values.next().transpose()?;
    for row in bounds.start.0..=bounds.end.0 {
        let mut cells = Vec::new();
        while next.as_ref().is_some_and(|cell| cell.0 == row) {
            let (_, column, value) = next.take().unwrap();
            validate_position(row, column)?;
            let column = column as usize;
            if cells.len() <= column {
                cells.resize_with(column + 1, empty_cell);
            }
            cells[column].value = value;
            next = values.next().transpose()?;
        }
        if next.as_ref().is_some_and(|cell| cell.0 < row) {
            return Err(binary_error("Value rows are out of order"));
        }
        formulas.apply_row(row, bounds, &mut cells)?;
        while cells
            .last()
            .is_some_and(|cell| cell.value.is_empty() && cell.formula.is_empty())
        {
            cells.pop();
        }
        writer.write_row(sheet_id, row as usize + 1, cells)?;
    }
    if next.is_some() {
        return Err(binary_error(
            "Cell position exceeds observed worksheet bounds",
        ));
    }
    Ok(())
}

fn stream_xlsb(
    workbook: &mut XlsbStream<BufReader<File>>,
    strings: &mut DiskStrings,
    name: &str,
    dir: &Path,
    side: &str,
    writer: &mut RowWriter,
    sheet_id: u32,
) -> io::Result<Option<Dimensions>> {
    let mut bounds: Option<Dimensions> = None;
    {
        let mut reader = workbook
            .worksheet_cells_reader(name)
            .map_err(binary_error)?;
        while let Some(cell) = reader.next_cell().map_err(binary_error)? {
            if matches!(cell.get_value(), XlsbCellValue::Value(Data::Empty)) {
                continue;
            }
            let (row, column) = cell.get_position();
            validate_position(row, column)?;
            match &mut bounds {
                Some(bounds) => {
                    bounds.start.0 = bounds.start.0.min(row);
                    bounds.start.1 = bounds.start.1.min(column);
                    bounds.end.0 = bounds.end.0.max(row);
                    bounds.end.1 = bounds.end.1.max(column);
                }
                None => bounds = Some(Dimensions::new((row, column), (row, column))),
            }
        }
    }
    let mut formulas = {
        let mut reader = workbook
            .worksheet_cells_reader(name)
            .map_err(binary_error)?;
        FormulaScratch::write(
            dir,
            side,
            std::iter::from_fn(|| match reader.next_formula() {
                Ok(Some(cell)) => {
                    let (row, column) = cell.get_position();
                    Some(Ok((row, column, cell.get_value().clone())))
                }
                Ok(None) => None,
                Err(error) => Some(Err(binary_error(error))),
            }),
        )?
    };
    let mut reader = workbook
        .worksheet_cells_reader(name)
        .map_err(binary_error)?;
    write_values(
        writer,
        sheet_id,
        bounds,
        std::iter::from_fn(|| match reader.next_cell() {
            Ok(Some(cell)) => {
                let (row, column) = cell.get_position();
                let value = match cell.get_value() {
                    XlsbCellValue::Value(value) => format_cell(value),
                    XlsbCellValue::SharedStringId(id) => match strings.get(*id) {
                        Ok(Some(value)) => normalize_field(&value),
                        Ok(None) => return Some(Err(binary_error("Missing shared string"))),
                        Err(error) => return Some(Err(error)),
                    },
                };
                Some(Ok((row, column, value)))
            }
            Ok(None) => None,
            Err(error) => Some(Err(binary_error(error))),
        }),
        &mut formulas,
    )?;
    Ok(bounds)
}

fn observe(bounds: &mut Option<Dimensions>, row: u32, column: u32) {
    match bounds {
        Some(bounds) => {
            bounds.start.0 = bounds.start.0.min(row);
            bounds.start.1 = bounds.start.1.min(column);
            bounds.end.0 = bounds.end.0.max(row);
            bounds.end.1 = bounds.end.1.max(column);
        }
        None => *bounds = Some(Dimensions::new((row, column), (row, column))),
    }
}

struct XlsSink {
    sorter: CellSorter,
    bounds: Option<Dimensions>,
    merges: Vec<Dimensions>,
}

impl XlsSheetSink for XlsSink {
    fn value(&mut self, cell: Cell<Data>) -> io::Result<()> {
        let (row, column) = cell.get_position();
        validate_position(row, column)?;
        observe(&mut self.bounds, row, column);
        self.sorter
            .push(row, column, false, format_cell(cell.get_value()))
    }
    fn formula(&mut self, cell: Cell<String>) -> io::Result<()> {
        let (row, column) = cell.get_position();
        validate_position(row, column)?;
        self.sorter
            .push(row, column, true, cell.get_value().clone())
    }
    fn merge(&mut self, dimensions: Dimensions) -> io::Result<()> {
        self.merges.push(dimensions);
        Ok(())
    }
}

fn write_xls_sheet(
    writer: &mut RowWriter,
    sheet_id: u32,
    sink: XlsSink,
) -> io::Result<(Option<Dimensions>, Vec<Dimensions>)> {
    let XlsSink {
        sorter,
        bounds,
        merges,
    } = sink;
    let mut records = sorter.finish()?;
    if let Some(bounds) = bounds {
        let mut next = records.next()?;
        // Formula events outside value bounds never expand the Range oracle.
        while next
            .as_ref()
            .is_some_and(|record| record.row < bounds.start.0)
        {
            next = records.next()?;
        }
        for row in bounds.start.0..=bounds.end.0 {
            let mut cells = Vec::new();
            while next.as_ref().is_some_and(|record| record.row == row) {
                let record = next.take().unwrap();
                if !record.formula || bounds.contains(row, record.column) {
                    let column = record.column as usize;
                    if cells.len() <= column {
                        cells.resize_with(column + 1, empty_cell);
                    }
                    if record.formula {
                        let formula = record.text.trim();
                        cells[column].formula = if formula.is_empty() {
                            String::new()
                        } else {
                            format!("={formula}")
                        };
                    } else {
                        cells[column].value = record.text;
                    }
                }
                next = records.next()?;
            }
            while cells
                .last()
                .is_some_and(|cell| cell.value.is_empty() && cell.formula.is_empty())
            {
                cells.pop();
            }
            writer.write_row(sheet_id, row as usize + 1, cells)?;
        }
    }
    Ok((bounds, merges))
}

fn sheet_metadata(
    bounds: Option<Dimensions>,
    dimensions: Vec<Dimensions>,
) -> WorkbookSheetMetadata {
    let merge_ranges = dimensions
        .into_iter()
        .map(|dimensions| crate::model::WorkbookMergeRange {
            start_row: dimensions.start.0 as usize + 1,
            end_row: dimensions.end.0 as usize + 1,
            start_col: dimensions.start.1 as usize,
            end_col: dimensions.end.1 as usize,
        })
        .collect::<Vec<_>>();
    let row_count = bounds
        .map(|bounds| bounds.end.0 as usize + 1)
        .into_iter()
        .chain(merge_ranges.iter().map(|range| range.end_row))
        .max();
    let max_columns = bounds
        .map(|bounds| bounds.end.1 as usize + 1)
        .into_iter()
        .chain(merge_ranges.iter().map(|range| range.end_col + 1))
        .max();
    WorkbookSheetMetadata {
        hidden_columns: Vec::new(),
        merge_ranges,
        row_count,
        max_columns,
    }
}

pub(super) fn ingest(
    path: &str,
    dir: &Path,
    side: &str,
    sheets: &mut Vec<ArtifactSheet>,
    writer: &mut RowWriter,
    metadata: &mut WorkbookMetadataMap,
) -> io::Result<()> {
    let mut strings = DiskStrings::new(dir, side)?;
    let reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "xlsb" => {
            let mut workbook = XlsbStream::new(reader, &mut strings).map_err(binary_error)?;
            strings.seal()?;
            let names = workbook
                .sheets_metadata()
                .iter()
                .map(|sheet| sheet.name.clone())
                .collect::<Vec<_>>();
            for name in names {
                let sheet_id = xml::register_sheet(sheets, &name, side);
                let bounds = stream_xlsb(
                    &mut workbook,
                    &mut strings,
                    &name,
                    dir,
                    side,
                    writer,
                    sheet_id,
                )?;
                metadata
                    .sheets
                    .insert(name, sheet_metadata(bounds, Vec::new()));
            }
        }
        "xls" => {
            let mut workbook = XlsStream::new(reader, &mut strings).map_err(binary_error)?;
            strings.seal()?;
            let names = workbook
                .sheets_metadata()
                .iter()
                .map(|sheet| sheet.name.clone())
                .collect::<Vec<_>>();
            for (index, name) in names.into_iter().enumerate() {
                let sheet_id = xml::register_sheet(sheets, &name, side);
                let mut sink = XlsSink {
                    sorter: CellSorter::new(dir, side),
                    bounds: None,
                    merges: Vec::new(),
                };
                workbook
                    .read_sheet(index, &mut strings, &mut sink)
                    .map_err(binary_error)?;
                let (bounds, merges) = write_xls_sheet(writer, sheet_id, sink)?;
                metadata.sheets.insert(name, sheet_metadata(bounds, merges));
            }
        }
        _ => return Err(binary_error("Unsupported binary workbook extension")),
    }
    Ok(())
}

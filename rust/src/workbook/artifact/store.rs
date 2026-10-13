use super::*;
use std::io::{Seek, SeekFrom};

#[derive(Clone)]
pub(super) struct RowRef {
    pub sheet_id: u32,
    pub row_number: u32,
    pub offset: u64,
    pub length: u32,
    pub max_columns: u32,
    pub strict_hash: u64,
    pub content_hash: u64,
    pub strict_class: u32,
    pub content_class: u32,
    pub signatures_match: bool,
    pub strict_nonempty: bool,
    pub content_nonempty: bool,
}

pub(super) struct StoredWorkbook {
    pub rows: Vec<RowRef>,
    pub sheet_rows: HashMap<u32, Vec<usize>>,
    pub metadata: WorkbookMetadataMap,
    pub used_columns: HashMap<u32, BTreeSet<usize>>,
    pub cell_count: u64,
    pub sheet_cell_counts: HashMap<u32, u64>,
    pub reader: File,
}

pub(super) struct RowWriter {
    data: BufWriter<File>,
    index: BufWriter<File>,
    offset: u64,
    pub rows: Vec<RowRef>,
    pub sheet_rows: HashMap<u32, Vec<usize>>,
    pub used_columns: HashMap<u32, BTreeSet<usize>>,
    pub cell_count: u64,
    pub sheet_cell_counts: HashMap<u32, u64>,
}

fn hash_signature(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

impl RowWriter {
    pub fn new(dir: &Path, side: &str) -> io::Result<Self> {
        let mut data = BufWriter::with_capacity(
            1024 * 1024,
            File::create(dir.join(format!("{side}.rows.bin")))?,
        );
        let mut index = BufWriter::with_capacity(
            64 * 1024,
            File::create(dir.join(format!("{side}.rows.idx")))?,
        );
        data.write_all(b"VWRROW01")?;
        index.write_all(b"VWRIDX01")?;
        index.write_all(&0u64.to_le_bytes())?;
        Ok(Self {
            data,
            index,
            offset: 8,
            rows: Vec::new(),
            sheet_rows: HashMap::new(),
            used_columns: HashMap::new(),
            cell_count: 0,
            sheet_cell_counts: HashMap::new(),
        })
    }

    pub fn write_row(
        &mut self,
        sheet_id: u32,
        row_number: usize,
        cells: Vec<WorkbookCellSnapshotJson>,
    ) -> io::Result<()> {
        let row = super::super::rows::build_row_line_and_signature_owned(row_number, cells);
        let nonempty = row
            .cells
            .iter()
            .enumerate()
            .filter(|(_, cell)| !cell.value.is_empty() || !cell.formula.is_empty())
            .collect::<Vec<_>>();
        let length = nonempty.iter().try_fold(8u64, |length, (_, cell)| {
            length
                .checked_add(12 + cell.value.len() as u64 + cell.formula.len() as u64)
                .ok_or_else(|| io::Error::other("Row record size overflow"))
        })?;
        let length = u32::try_from(length)
            .map_err(|_| io::Error::other("Row record exceeds binary format size"))?;
        let max_columns = nonempty.last().map(|(column, _)| column + 1).unwrap_or(0) as u32;
        self.data.write_all(&(row_number as u32).to_le_bytes())?;
        self.data
            .write_all(&(nonempty.len() as u32).to_le_bytes())?;
        for (column, cell) in &nonempty {
            self.data.write_all(&(*column as u32).to_le_bytes())?;
            self.data
                .write_all(&(cell.value.len() as u32).to_le_bytes())?;
            self.data
                .write_all(&(cell.formula.len() as u32).to_le_bytes())?;
            self.data.write_all(cell.value.as_bytes())?;
            self.data.write_all(cell.formula.as_bytes())?;
            self.used_columns
                .entry(sheet_id)
                .or_default()
                .insert(*column);
        }
        self.cell_count += nonempty.len() as u64;
        *self.sheet_cell_counts.entry(sheet_id).or_default() += nonempty.len() as u64;
        let reference = RowRef {
            sheet_id,
            row_number: row_number as u32,
            offset: self.offset,
            length,
            max_columns,
            strict_hash: hash_signature(&row.strict_signature),
            content_hash: hash_signature(&row.content_signature),
            strict_class: u32::MAX,
            content_class: u32::MAX,
            signatures_match: row.strict_signature == row.content_signature,
            strict_nonempty: !row.strict_signature.is_empty(),
            content_nonempty: !row.content_signature.is_empty(),
        };
        self.index.write_all(&sheet_id.to_le_bytes())?;
        self.index.write_all(&reference.row_number.to_le_bytes())?;
        self.index.write_all(&reference.offset.to_le_bytes())?;
        self.index.write_all(&length.to_le_bytes())?;
        self.index.write_all(&max_columns.to_le_bytes())?;
        self.sheet_rows
            .entry(sheet_id)
            .or_default()
            .push(self.rows.len());
        self.rows.push(reference);
        self.offset += u64::from(length);
        Ok(())
    }

    pub fn finish(
        mut self,
        dir: &Path,
        side: &str,
        metadata: WorkbookMetadataMap,
    ) -> io::Result<StoredWorkbook> {
        self.data.flush()?;
        self.index.flush()?;
        self.index.seek(SeekFrom::Start(8))?;
        self.index
            .write_all(&(self.rows.len() as u64).to_le_bytes())?;
        self.index.flush()?;
        Ok(StoredWorkbook {
            rows: self.rows,
            sheet_rows: self.sheet_rows,
            metadata,
            used_columns: self.used_columns,
            cell_count: self.cell_count,
            sheet_cell_counts: self.sheet_cell_counts,
            reader: File::open(dir.join(format!("{side}.rows.bin")))?,
        })
    }
}

impl StoredWorkbook {
    pub fn read_row(&mut self, ordinal: usize) -> io::Result<WorkbookRowEntry> {
        let reference = &self.rows[ordinal];
        self.reader.seek(SeekFrom::Start(reference.offset))?;
        let mut bytes = vec![0; reference.length as usize];
        self.reader.read_exact(&mut bytes)?;
        let row_number = read_u32(&bytes, 0)? as usize;
        let cell_count = read_u32(&bytes, 4)? as usize;
        let mut cells = Vec::with_capacity(reference.max_columns as usize);
        let mut cursor = 8;
        for _ in 0..cell_count {
            let column = read_u32(&bytes, cursor)? as usize;
            let value_length = read_u32(&bytes, cursor + 4)? as usize;
            let formula_length = read_u32(&bytes, cursor + 8)? as usize;
            cursor += 12;
            let value = read_utf8(&bytes, &mut cursor, value_length)?;
            let formula = read_utf8(&bytes, &mut cursor, formula_length)?;
            while cells.len() < column {
                cells.push(WorkbookCellSnapshotJson {
                    value: String::new(),
                    formula: String::new(),
                });
            }
            cells.push(WorkbookCellSnapshotJson { value, formula });
        }
        if cursor != bytes.len() {
            return Err(io::Error::other("Invalid row record length"));
        }
        Ok(super::super::rows::build_row_line_and_signature_owned(
            row_number, cells,
        ))
    }
}

pub(super) fn read_u32(bytes: &[u8], offset: usize) -> io::Result<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| io::Error::other("Truncated row record"))?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

fn read_utf8(bytes: &[u8], cursor: &mut usize, length: usize) -> io::Result<String> {
    let end = cursor
        .checked_add(length)
        .ok_or_else(|| io::Error::other("Invalid row string length"))?;
    let value = std::str::from_utf8(
        bytes
            .get(*cursor..end)
            .ok_or_else(|| io::Error::other("Truncated row string"))?,
    )
    .map_err(io::Error::other)?
    .to_owned();
    *cursor = end;
    Ok(value)
}

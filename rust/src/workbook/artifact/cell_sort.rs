use super::*;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::io::BufReader;
use std::path::PathBuf;

const RECORD_LIMIT: usize = 65536;
const TEXT_BUDGET: usize = 16 * 1024 * 1024;
const FAN_IN: usize = 16;

pub(super) struct CellRecord {
    pub row: u32,
    pub column: u32,
    pub formula: bool,
    ordinal: u64,
    pub text: String,
}

impl CellRecord {
    fn key(&self) -> (u32, u32, bool, u64) {
        (self.row, self.column, self.formula, self.ordinal)
    }
    fn coordinate(&self) -> (u32, u32, bool) {
        (self.row, self.column, self.formula)
    }

    fn write(&self, output: &mut impl Write) -> io::Result<()> {
        let length = u32::try_from(self.text.len())
            .map_err(|_| io::Error::other("Cell scratch value is too large"))?;
        output.write_all(&self.row.to_le_bytes())?;
        output.write_all(&self.column.to_le_bytes())?;
        output.write_all(&[u8::from(self.formula)])?;
        output.write_all(&self.ordinal.to_le_bytes())?;
        output.write_all(&length.to_le_bytes())?;
        output.write_all(self.text.as_bytes())
    }

    fn read(input: &mut impl Read) -> io::Result<Option<Self>> {
        let mut header = [0; 21];
        if input.read(&mut header[..1])? == 0 {
            return Ok(None);
        }
        input.read_exact(&mut header[1..])?;
        if header[8] > 1 {
            return Err(io::Error::other("Invalid cell scratch channel"));
        }
        let length = u32::from_le_bytes(header[17..].try_into().unwrap()) as usize;
        let mut text = vec![0; length];
        input.read_exact(&mut text)?;
        Ok(Some(Self {
            row: u32::from_le_bytes(header[..4].try_into().unwrap()),
            column: u32::from_le_bytes(header[4..8].try_into().unwrap()),
            formula: header[8] != 0,
            ordinal: u64::from_le_bytes(header[9..17].try_into().unwrap()),
            text: String::from_utf8(text).map_err(io::Error::other)?,
        }))
    }
}

struct Head {
    record: CellRecord,
    source: usize,
}
impl PartialEq for Head {
    fn eq(&self, other: &Self) -> bool {
        self.record.key() == other.record.key() && self.source == other.source
    }
}
impl Eq for Head {}
impl PartialOrd for Head {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Head {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .record
            .key()
            .cmp(&self.record.key())
            .then_with(|| other.source.cmp(&self.source))
    }
}

fn merge(paths: &[PathBuf], destination: &Path) -> io::Result<()> {
    let mut readers = paths
        .iter()
        .map(|path| File::open(path).map(|file| BufReader::with_capacity(64 * 1024, file)))
        .collect::<io::Result<Vec<_>>>()?;
    let mut heads = BinaryHeap::new();
    for (source, reader) in readers.iter_mut().enumerate() {
        if let Some(record) = CellRecord::read(reader)? {
            heads.push(Head { record, source });
        }
    }
    let mut output = BufWriter::with_capacity(1024 * 1024, File::create(destination)?);
    let mut pending: Option<CellRecord> = None;
    while let Some(Head { record, source }) = heads.pop() {
        if pending
            .as_ref()
            .is_some_and(|previous| previous.coordinate() != record.coordinate())
        {
            pending.take().unwrap().write(&mut output)?;
        }
        // Sorted event ordinals preserve the final write, including empty text.
        pending = Some(record);
        if let Some(record) = CellRecord::read(&mut readers[source])? {
            heads.push(Head { record, source });
        }
    }
    if let Some(record) = pending {
        record.write(&mut output)?;
    }
    output.flush()
}

/// Incrementally compact runs. At most FAN_IN paths per level remain live;
/// there is no unbounded list of all runs or all cell offsets.
pub(super) struct CellSorter {
    dir: PathBuf,
    prefix: String,
    next_file: u64,
    next_ordinal: u64,
    pending: Vec<CellRecord>,
    text_bytes: usize,
    levels: Vec<Vec<PathBuf>>,
    live: HashSet<PathBuf>,
}

impl Drop for CellSorter {
    fn drop(&mut self) {
        for path in &self.live {
            let _ = fs::remove_file(path);
        }
    }
}

impl CellSorter {
    pub(super) fn new(dir: &Path, side: &str) -> Self {
        Self {
            dir: dir.to_owned(),
            prefix: side.to_owned(),
            next_file: 0,
            next_ordinal: 0,
            pending: Vec::with_capacity(RECORD_LIMIT),
            text_bytes: 0,
            levels: Vec::new(),
            live: HashSet::new(),
        }
    }

    fn path(&mut self) -> PathBuf {
        let path = self
            .dir
            .join(format!("{}.cells-{}.scratch", self.prefix, self.next_file));
        self.next_file += 1;
        self.live.insert(path.clone());
        path
    }

    pub(super) fn push(
        &mut self,
        row: u32,
        column: u32,
        formula: bool,
        text: String,
    ) -> io::Result<()> {
        if !self.pending.is_empty()
            && (self.pending.len() == RECORD_LIMIT
                || self.text_bytes.saturating_add(text.capacity()) > TEXT_BUDGET)
        {
            self.flush()?;
        }
        self.text_bytes = self.text_bytes.saturating_add(text.capacity());
        let ordinal = self.next_ordinal;
        self.next_ordinal = self
            .next_ordinal
            .checked_add(1)
            .ok_or_else(|| io::Error::other("Cell event count overflow"))?;
        self.pending.push(CellRecord {
            row,
            column,
            formula,
            ordinal,
            text,
        });
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.pending.sort_unstable_by_key(CellRecord::key);
        let path = self.path();
        {
            let mut output = BufWriter::with_capacity(1024 * 1024, File::create(&path)?);
            for record in &self.pending {
                record.write(&mut output)?;
            }
            output.flush()?;
        }
        self.pending.clear();
        self.text_bytes = 0;
        self.add_run(path, 0)
    }

    fn combine(&mut self, paths: &[PathBuf]) -> io::Result<PathBuf> {
        let path = self.path();
        merge(paths, &path)?;
        for old in paths {
            fs::remove_file(old)?;
            self.live.remove(old);
        }
        Ok(path)
    }

    fn add_run(&mut self, mut path: PathBuf, mut level: usize) -> io::Result<()> {
        loop {
            if self.levels.len() <= level {
                self.levels.push(Vec::with_capacity(FAN_IN));
            }
            self.levels[level].push(path);
            if self.levels[level].len() < FAN_IN {
                return Ok(());
            }
            let runs = std::mem::take(&mut self.levels[level]);
            path = self.combine(&runs)?;
            level += 1;
        }
    }

    pub(super) fn finish(mut self) -> io::Result<SortedCells> {
        self.flush()?;
        let mut paths = std::mem::take(&mut self.levels)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Ok(SortedCells {
                reader: None,
                path: None,
            });
        }
        while paths.len() > 1 {
            let mut combined = Vec::with_capacity(paths.len().div_ceil(FAN_IN));
            for group in paths.chunks(FAN_IN) {
                if group.len() == 1 {
                    combined.push(group[0].clone());
                } else {
                    combined.push(self.combine(group)?);
                }
            }
            paths = combined;
        }
        let path = paths.pop().unwrap();
        // In a single run the consumer assigns records in ordinal order to the
        // current row, coalescing duplicates without another disk pass.
        let reader = BufReader::with_capacity(1024 * 1024, File::open(&path)?);
        self.live.remove(&path);
        Ok(SortedCells {
            reader: Some(reader),
            path: Some(path),
        })
    }
}

pub(super) struct SortedCells {
    reader: Option<BufReader<File>>,
    path: Option<PathBuf>,
}
impl Drop for SortedCells {
    fn drop(&mut self) {
        self.reader.take();
        if let Some(path) = &self.path {
            let _ = fs::remove_file(path);
        }
    }
}
impl SortedCells {
    pub(super) fn next(&mut self) -> io::Result<Option<CellRecord>> {
        match &mut self.reader {
            Some(reader) => CellRecord::read(reader),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TestDir;
    use super::*;

    #[test]
    fn multi_level_sort_keeps_independent_last_writes_and_empty_tombstones() {
        let dir = TestDir::new();
        let mut sorter = CellSorter::new(&dir.0, "base");
        // Force FAN_IN compaction and a final merge with a later empty value.
        for run in 0..17 {
            sorter.push(2, 1, false, format!("old{run}")).unwrap();
            sorter.push(0, 4, true, format!("formula{run}")).unwrap();
            sorter.flush().unwrap();
        }
        sorter.push(2, 1, false, String::new()).unwrap();
        sorter.push(0, 4, false, "cached".to_owned()).unwrap();
        let mut sorted = sorter.finish().unwrap();
        let mut records = Vec::new();
        while let Some(record) = sorted.next().unwrap() {
            records.push((record.row, record.column, record.formula, record.text));
        }
        assert_eq!(
            records,
            vec![
                (0, 4, false, "cached".to_owned()),
                (0, 4, true, "formula16".to_owned()),
                (2, 1, false, String::new())
            ]
        );
        drop(sorted);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn abandoned_sorter_removes_every_live_run() {
        let dir = TestDir::new();
        {
            let mut sorter = CellSorter::new(&dir.0, "mine");
            sorter.push(7, 1, false, "value".to_owned()).unwrap();
            sorter.flush().unwrap();
        }
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }
}

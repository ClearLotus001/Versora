use super::*;
use calamine::stream::SharedStrings;
use std::collections::VecDeque;
use std::path::PathBuf;

fn read_exact_at(file: &File, mut offset: u64, mut bytes: &mut [u8]) -> io::Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::FileExt;
    #[cfg(windows)]
    use std::os::windows::fs::FileExt;
    while !bytes.is_empty() {
        #[cfg(windows)]
        let result = file.seek_read(bytes, offset);
        #[cfg(unix)]
        let result = file.read_at(bytes, offset);
        match result {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
            Ok(count) => {
                offset += count as u64;
                bytes = &mut bytes[count..];
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Prefetch {
    Always,
    Sequential,
}

struct ScratchFiles([PathBuf; 2]);

impl Drop for ScratchFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

// Fixed page counts bound resident backing allocations, including index pages.
struct Pages {
    file: File,
    length: u64,
    size: usize,
    limit: usize,
    prefetch: Prefetch,
    previous_end: u64,
    entries: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
}

impl Pages {
    fn new(file: File, size: usize, limit: usize, prefetch: Prefetch) -> Self {
        Self {
            file,
            length: 0,
            size,
            limit,
            prefetch,
            previous_end: 0,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn read_into(&mut self, mut offset: u64, mut target: &mut [u8]) -> io::Result<()> {
        let end = offset
            .checked_add(target.len() as u64)
            .filter(|end| *end <= self.length)
            .ok_or_else(|| io::Error::other("Truncated shared-string storage"))?;
        let nearby = offset >= self.previous_end && offset - self.previous_end <= self.size as u64;
        self.previous_end = end;
        while !target.is_empty() {
            let page = offset / self.size as u64;
            if !self.entries.contains_key(&page)
                && matches!(self.prefetch, Prefetch::Sequential)
                && (!nearby || target.len() >= self.size)
            {
                // Random short strings should read their bytes, not a whole
                // page. Sequential IDs still benefit from bounded prefetch.
                return read_exact_at(&self.file, offset, target);
            }
            if !self.entries.contains_key(&page) {
                if self.entries.len() == self.limit {
                    if let Some(old) = self.order.pop_front() {
                        self.entries.remove(&old);
                    }
                }
                let start = page * self.size as u64;
                let length = (self.length - start).min(self.size as u64) as usize;
                let mut bytes = vec![0; length];
                read_exact_at(&self.file, start, &mut bytes)?;
                self.entries.insert(page, bytes);
                self.order.push_back(page);
            }
            let bytes = &self.entries[&page];
            let within = (offset % self.size as u64) as usize;
            let count = target.len().min(bytes.len() - within);
            target[..count].copy_from_slice(&bytes[within..within + count]);
            target = &mut target[count..];
            offset += count as u64;
        }
        Ok(())
    }
}

/// Format-independent append/seal/resolve store. Both data and IDs stay on disk.
pub(super) struct DiskStrings {
    data_writer: Option<BufWriter<File>>,
    index_writer: Option<BufWriter<File>>,
    data: Pages,
    index: Pages,
    count: usize,
    offset: u64,
    cache: HashMap<usize, String>,
    order: VecDeque<usize>,
    cache_bytes: usize,
    // All open handles above drop before the Windows scratch cleanup guard.
    _scratch: ScratchFiles,
}

impl DiskStrings {
    pub(super) fn new(dir: &Path, side: &str) -> io::Result<Self> {
        let data_path = dir.join(format!("{side}.sst.bin"));
        let index_path = dir.join(format!("{side}.sst.idx"));
        let scratch = ScratchFiles([data_path.clone(), index_path.clone()]);
        let data_writer = BufWriter::with_capacity(1024 * 1024, File::create(&data_path)?);
        let index_writer = BufWriter::with_capacity(64 * 1024, File::create(&index_path)?);
        Ok(Self {
            data_writer: Some(data_writer),
            index_writer: Some(index_writer),
            data: Pages::new(File::open(data_path)?, 16 * 1024, 256, Prefetch::Sequential),
            // Index pages stay bounded even beyond a million unique IDs.
            index: Pages::new(File::open(index_path)?, 16 * 1024, 1024, Prefetch::Always),
            count: 0,
            offset: 0,
            cache: HashMap::new(),
            order: VecDeque::new(),
            cache_bytes: 0,
            _scratch: scratch,
        })
    }

    pub(super) fn append(&mut self, value: &str) -> io::Result<()> {
        let length = u32::try_from(value.len())
            .map_err(|_| io::Error::other("Shared string exceeds storage record size"))?;
        let end = self
            .offset
            .checked_add(u64::from(length))
            .ok_or_else(|| io::Error::other("Shared-string offset overflow"))?;
        let data = self
            .data_writer
            .as_mut()
            .ok_or_else(|| io::Error::other("Shared-string store is sealed"))?;
        let index = self
            .index_writer
            .as_mut()
            .ok_or_else(|| io::Error::other("Shared-string store is sealed"))?;
        index.write_all(&self.offset.to_le_bytes())?;
        index.write_all(&length.to_le_bytes())?;
        data.write_all(value.as_bytes())?;
        self.offset = end;
        self.count = self
            .count
            .checked_add(1)
            .ok_or_else(|| io::Error::other("Shared-string count overflow"))?;
        Ok(())
    }

    pub(super) fn seal(&mut self) -> io::Result<()> {
        if let Some(mut output) = self.data_writer.take() {
            output.flush()?;
        }
        if let Some(mut output) = self.index_writer.take() {
            output.flush()?;
        }
        self.data.length = self.offset;
        self.index.length = (self.count as u64)
            .checked_mul(12)
            .ok_or_else(|| io::Error::other("Shared-string index overflow"))?;
        Ok(())
    }

    pub(super) fn get(&mut self, id: usize) -> io::Result<Option<String>> {
        if id >= self.count {
            return Ok(None);
        }
        if self.data_writer.is_some() {
            self.seal()?;
        }
        if let Some(value) = self.cache.get(&id) {
            return Ok(Some(value.clone()));
        }
        let mut entry = [0; 12];
        self.index.read_into(id as u64 * 12, &mut entry)?;
        let offset = u64::from_le_bytes(entry[..8].try_into().unwrap());
        let length = u32::from_le_bytes(entry[8..].try_into().unwrap()) as usize;
        // Validate the persisted extent before allocating a string buffer.
        if offset
            .checked_add(length as u64)
            .is_none_or(|end| end > self.offset)
        {
            return Err(io::Error::other("Invalid shared-string extent"));
        }
        let mut bytes = vec![0; length];
        self.data.read_into(offset, &mut bytes)?;
        let value = String::from_utf8(bytes).map_err(io::Error::other)?;
        const BUDGET: usize = 16 * 1024 * 1024;
        if value.len() <= BUDGET {
            let cost = value.len();
            while self.cache_bytes + cost > BUDGET || self.cache.len() >= 4096 {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                if let Some(old) = self.cache.remove(&oldest) {
                    self.cache_bytes -= old.capacity();
                }
            }
            self.cache_bytes += cost;
            self.order.push_back(id);
            self.cache.insert(id, value.clone());
        }
        Ok(Some(value))
    }
}

impl SharedStrings for DiskStrings {
    fn push(&mut self, value: String) -> io::Result<()> {
        self.append(&value)
    }
    fn get(&mut self, id: usize) -> io::Result<Option<String>> {
        DiskStrings::get(self, id)
    }
    fn len(&self) -> usize {
        self.count
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::TestDir;
    use super::*;

    #[test]
    fn mixed_reads_preserve_exact_bytes_and_report_physical_truncation() {
        let dir = TestDir::new();
        let path = dir.0.join("pages.bin");
        let source = (0..65547)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(&path, &source).unwrap();
        for prefetch in [Prefetch::Always, Prefetch::Sequential] {
            let mut pages = Pages::new(File::open(&path).unwrap(), 32, 2, prefetch);
            pages.length = source.len() as u64;
            for (offset, length) in [
                (0, 0),
                (0, 21),
                (21, 25),
                (9001, 13),
                (12, 33),
                (40000, 20000),
                (60000, 15),
                (60015, 15),
                (65540, 7),
            ] {
                let mut actual = vec![0; length];
                pages.read_into(offset as u64, &mut actual).unwrap();
                assert_eq!(actual, source[offset..offset + length]);
                assert!(pages.entries.len() <= pages.limit);
            }
            assert!(pages.read_into(source.len() as u64, &mut [0]).is_err());
        }
        let mut pages = Pages::new(File::open(&path).unwrap(), 32, 2, Prefetch::Sequential);
        pages.length = source.len() as u64;
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(10)
            .unwrap();
        assert_eq!(
            pages.read_into(50000, &mut [0; 128]).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn shared_strings_span_pages_keep_empty_unicode_ids_and_cleanup() {
        let dir = TestDir::new();
        {
            let mut strings = DiskStrings::new(&dir.0, "base").unwrap();
            strings.append("").unwrap();
            strings.append(" 中文😀 ").unwrap();
            let large = "λ".repeat(600000);
            strings.append(&large).unwrap();
            for i in 0..90000 {
                strings.append(&format!("id{i}")).unwrap();
            }
            strings.seal().unwrap();
            assert_eq!(strings.get(0).unwrap().as_deref(), Some(""));
            assert_eq!(strings.get(1).unwrap().as_deref(), Some(" 中文😀 "));
            assert_eq!(strings.get(2).unwrap(), Some(large));
            for i in (0..90000).step_by(197) {
                assert_eq!(strings.get(i + 3).unwrap(), Some(format!("id{i}")));
            }
            assert!(strings.get(strings.len()).unwrap().is_none());
            assert!(
                strings.data.entries.len() <= strings.data.limit
                    && strings.index.entries.len() <= strings.index.limit
            );
            assert!(strings.append("late").is_err());
        }
        assert!(!dir.0.join("base.sst.bin").exists());
        assert!(!dir.0.join("base.sst.idx").exists());
    }

    #[test]
    fn corrupt_extent_and_failed_builder_are_not_empty_string_fallbacks() {
        let dir = TestDir::new();
        {
            let mut strings = DiskStrings::new(&dir.0, "base").unwrap();
            strings.append("value").unwrap();
            strings.seal().unwrap();
            let mut index = File::options()
                .write(true)
                .open(dir.0.join("base.sst.idx"))
                .unwrap();
            index.write_all(&u64::MAX.to_le_bytes()).unwrap();
            assert!(strings.get(0).is_err());
        }
        assert!(!dir.0.join("base.sst.idx").exists());
        {
            let mut strings = DiskStrings::new(&dir.0, "mine").unwrap();
            strings.append("unsealed").unwrap();
        }
        assert!(!dir.0.join("mine.sst.bin").exists());
    }
}

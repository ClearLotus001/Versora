use super::*;
use crate::diff::{build_workbook_row_delta_json, patience_lcs, MergeRangeIndex};
use crate::model::{RowSignature, WorkbookMergeRange};
use std::io::{BufReader, Seek, SeekFrom};

struct KeyRow(String);
impl RowSignature for KeyRow {
    fn signature(&self, _: &str) -> &str {
        &self.0
    }
}

struct Representative {
    mine: bool,
    ordinal: usize,
    class: u32,
    mode: &'static str,
}

// Hashes narrow the candidates; equality is always checked using the complete
// normalized signature. A collision must never alter row alignment.
pub(super) fn prepare_keys(base: &mut StoredWorkbook, mine: &mut StoredWorkbook) -> io::Result<()> {
    let mut groups: HashMap<u64, Vec<Representative>> = HashMap::new();
    let mut next_class = 0u32;
    for is_mine in [false, true] {
        let count = if is_mine {
            mine.rows.len()
        } else {
            base.rows.len()
        };
        for ordinal in 0..count {
            let reference = if is_mine {
                mine.rows[ordinal].clone()
            } else {
                base.rows[ordinal].clone()
            };
            let mut incoming = None;
            let mut classes = [u32::MAX; 2];
            for (index, mode, hash) in [
                (0, "strict", reference.strict_hash),
                (1, "content", reference.content_hash),
            ] {
                if index == 1 && reference.signatures_match {
                    classes[1] = classes[0];
                    break;
                }
                let group = groups.entry(hash).or_default();
                let mut found = None;
                if !group.is_empty() {
                    if incoming.is_none() {
                        incoming = Some(if is_mine {
                            mine.read_row(ordinal)?
                        } else {
                            base.read_row(ordinal)?
                        });
                    }
                    for representative in group.iter() {
                        let candidate = if representative.mine {
                            mine.read_row(representative.ordinal)?
                        } else {
                            base.read_row(representative.ordinal)?
                        };
                        if incoming.as_ref().unwrap().signature(mode)
                            == candidate.signature(representative.mode)
                        {
                            found = Some(representative.class);
                            break;
                        }
                    }
                }
                classes[index] = if let Some(class) = found {
                    class
                } else {
                    let class = next_class;
                    next_class = next_class
                        .checked_add(1)
                        .ok_or_else(|| io::Error::other("Too many canonical row signatures"))?;
                    group.push(Representative {
                        mine: is_mine,
                        ordinal,
                        class,
                        mode,
                    });
                    class
                };
            }
            let reference = if is_mine {
                &mut mine.rows[ordinal]
            } else {
                &mut base.rows[ordinal]
            };
            reference.strict_class = classes[0];
            reference.content_class = classes[1];
        }
    }
    Ok(())
}

fn alignment_keys(workbook: &StoredWorkbook, ordinals: &[usize], mode: &str) -> Vec<KeyRow> {
    ordinals
        .iter()
        .map(|&ordinal| {
            let row = &workbook.rows[ordinal];
            KeyRow(
                if mode == "content" {
                    row.content_class
                } else {
                    row.strict_class
                }
                .to_string(),
            )
        })
        .collect()
}

#[derive(Clone, Copy)]
struct Run {
    start: u32,
    end: u32,
    flags: u32,
    component: u32,
}

#[derive(Clone, Copy)]
struct Region {
    sheet: u32,
    start_pair: u32,
    end_pair: u32,
    start_column: u32,
    end_column: u32,
    anchor_pair: u32,
    anchor_column: u32,
    cells: u64,
}

#[derive(Clone, Copy)]
struct VisualRect {
    start_pair: u32,
    end_pair: u32,
    start_column: u32,
    end_column: u32,
    component: u32,
}
struct MergeFootprint {
    pair: u32,
    column: u32,
    component: u32,
    base: Option<WorkbookMergeRange>,
    mine: Option<WorkbookMergeRange>,
}

#[derive(Default)]
struct Regions {
    parents: Vec<u32>,
    summaries: Vec<Region>,
    previous: Vec<Run>,
}

impl Regions {
    fn root(&mut self, mut id: u32) -> u32 {
        let mut root = id;
        while self.parents[root as usize] != root {
            root = self.parents[root as usize];
        }
        while id != root {
            let next = self.parents[id as usize];
            self.parents[id as usize] = root;
            id = next;
        }
        root
    }
    fn union(&mut self, a: u32, b: u32) -> u32 {
        let a = self.root(a);
        let b = self.root(b);
        if a == b {
            return a;
        }
        // The oldest component keeps the anchor and deterministically orders IDs.
        let (keep, remove) = if a < b { (a, b) } else { (b, a) };
        self.parents[remove as usize] = keep;
        let other = self.summaries[remove as usize];
        let summary = &mut self.summaries[keep as usize];
        summary.start_pair = summary.start_pair.min(other.start_pair);
        summary.end_pair = summary.end_pair.max(other.end_pair);
        summary.start_column = summary.start_column.min(other.start_column);
        summary.end_column = summary.end_column.max(other.end_column);
        summary.cells += other.cells;
        keep
    }
    fn row(&mut self, sheet: u32, pair: u32, runs: &mut [Run]) -> io::Result<()> {
        let mut first_previous = 0;
        for index in 0..runs.len() {
            let run = runs[index];
            while first_previous < self.previous.len()
                && self.previous[first_previous].end < run.start
            {
                first_previous += 1;
            }
            let mut component = None;
            if index > 0 && runs[index - 1].end == run.start {
                component = Some(self.root(runs[index - 1].component));
            }
            let mut candidate = first_previous;
            while candidate < self.previous.len() && self.previous[candidate].start <= run.end {
                let previous = self.previous[candidate];
                component = Some(match component {
                    Some(id) => self.union(id, previous.component),
                    None => self.root(previous.component),
                });
                candidate += 1;
            }
            let component = if let Some(id) = component {
                let id = self.root(id);
                let summary = &mut self.summaries[id as usize];
                summary.end_pair = pair + 1;
                summary.start_column = summary.start_column.min(run.start);
                summary.end_column = summary.end_column.max(run.end);
                summary.cells += u64::from(run.end - run.start);
                id
            } else {
                let id = u32::try_from(self.parents.len())
                    .map_err(|_| io::Error::other("Too many change regions"))?;
                self.parents.push(id);
                self.summaries.push(Region {
                    sheet,
                    start_pair: pair,
                    end_pair: pair + 1,
                    start_column: run.start,
                    end_column: run.end,
                    anchor_pair: pair,
                    anchor_column: run.start,
                    cells: u64::from(run.end - run.start),
                });
                id
            };
            runs[index].component = component;
        }
        self.previous.clear();
        self.previous.extend_from_slice(runs);
        Ok(())
    }
    fn finish(mut self, dir: &Path, runs_file: &str, regions_file: &str) -> io::Result<u64> {
        let mut ids = vec![u32::MAX; self.parents.len()];
        let mut roots: Vec<_> = self
            .parents
            .iter()
            .enumerate()
            .filter(|(index, parent)| **parent == *index as u32)
            .map(|(index, _)| index)
            .collect();
        roots.sort_unstable_by_key(|&index| {
            let summary = &self.summaries[index];
            (
                summary.sheet,
                summary.start_pair,
                summary.start_column,
                summary.end_pair,
                summary.end_column,
            )
        });
        let count =
            u32::try_from(roots.len()).map_err(|_| io::Error::other("Too many change regions"))?;
        for (id, &index) in roots.iter().enumerate() {
            ids[index] = id as u32;
        }
        for index in 0..ids.len() {
            let root = self.root(index as u32);
            ids[index] = ids[root as usize];
        }
        let mut writer =
            BufWriter::with_capacity(1024 * 1024, File::create(dir.join(regions_file))?);
        writer.write_all(b"VWRREG01")?;
        writer.write_all(&u64::from(count).to_le_bytes())?;
        for index in roots {
            let summary = &self.summaries[index];
            for value in [
                summary.sheet,
                ids[index],
                summary.start_pair,
                summary.end_pair,
                summary.start_column,
                summary.end_column,
                summary.anchor_pair,
                summary.anchor_column,
            ] {
                writer.write_all(&value.to_le_bytes())?;
            }
            writer.write_all(&summary.cells.to_le_bytes())?;
        }
        writer.flush()?;
        let source_path = dir.join(runs_file);
        let patched_path = dir.join(format!("{runs_file}.final"));
        {
            let mut reader = BufReader::with_capacity(1024 * 1024, File::open(&source_path)?);
            let mut patched = BufWriter::with_capacity(1024 * 1024, File::create(&patched_path)?);
            let mut header = [0; 8];
            reader.read_exact(&mut header)?;
            patched.write_all(&header)?;
            let mut record = [0; 16];
            loop {
                match reader.read(&mut record[..1])? {
                    0 => break,
                    _ => reader.read_exact(&mut record[1..])?,
                }
                let old = u32::from_le_bytes(record[12..16].try_into().unwrap()) as usize;
                record[12..16].copy_from_slice(&ids[old].to_le_bytes());
                patched.write_all(&record)?;
            }
            patched.flush()?;
        }
        fs::remove_file(source_path)?;
        fs::rename(patched_path, dir.join(runs_file))?;
        Ok(u64::from(count))
    }
}

struct Output {
    pairs: BufWriter<File>,
    runs: BufWriter<File>,
    pair_count: u64,
    run_offset: u64,
    regions: Regions,
    changed_cell_count: u64,
    footprints: Vec<MergeFootprint>,
    base_pairs: HashMap<usize, u32>,
    mine_pairs: HashMap<usize, u32>,
    row_runs: Vec<(u64, u32)>,
}

impl Output {
    #[allow(clippy::too_many_arguments)]
    fn pair(
        &mut self,
        sheet: u32,
        base_ordinal: Option<usize>,
        mine_ordinal: Option<usize>,
        search_both_sides: bool,
        base: &mut StoredWorkbook,
        mine: &mut StoredWorkbook,
        base_merges: &MergeRangeIndex<'_>,
        mine_merges: &MergeRangeIndex<'_>,
        mode: &str,
        summary: &mut SheetSummary,
        columns: &mut BTreeSet<usize>,
    ) -> io::Result<()> {
        let base_row = base_ordinal
            .map(|ordinal| base.read_row(ordinal))
            .transpose()?;
        let mine_row = mine_ordinal
            .map(|ordinal| mine.read_row(ordinal))
            .transpose()?;
        let delta = build_workbook_row_delta_json(
            base_row.as_ref(),
            mine_row.as_ref(),
            base_merges,
            mine_merges,
            None,
            None,
            mode,
        );
        let content_changed = if mode == "strict" && !delta.cell_deltas.is_empty() {
            build_workbook_row_delta_json(
                base_row.as_ref(),
                mine_row.as_ref(),
                base_merges,
                mine_merges,
                None,
                None,
                "content",
            )
            .cell_deltas
            .into_iter()
            .map(|cell| cell.column)
            .collect::<BTreeSet<_>>()
        } else {
            BTreeSet::new()
        };
        let mut runs: Vec<Run> = Vec::new();
        let mut tones = 0u32;
        for cell in &delta.cell_deltas {
            let has_base = has_workbook_cell_content(&cell.base_cell, mode);
            let has_mine = has_workbook_cell_content(&cell.mine_cell, mode);
            let kind = match (has_base, has_mine) {
                (false, true) => 1,
                (true, false) => 2,
                _ => 3,
            };
            let strict_only = mode == "strict" && !content_changed.contains(&cell.column);
            let flags = kind
                | (u32::from(strict_only) << 2)
                | (u32::from(has_base) << 3)
                | (u32::from(has_mine) << 4);
            tones |= if strict_only {
                8
            } else {
                match kind {
                    1 => 1,
                    2 => 2,
                    _ => 4,
                }
            };
            columns.insert(cell.column);
            let column = cell.column as u32;
            if let Some(last) = runs
                .last_mut()
                .filter(|last| last.end == column && last.flags == flags)
            {
                last.end += 1;
            } else {
                runs.push(Run {
                    start: column,
                    end: column + 1,
                    flags,
                    component: 0,
                });
            }
        }
        let kind = match (base_ordinal, mine_ordinal) {
            (None, Some(_)) => 1,
            (Some(_), None) => 2,
            _ if delta.cell_deltas.is_empty() => 0,
            _ => 3,
        };
        match kind {
            0 => summary.equal_rows += 1,
            1 => summary.added_rows += 1,
            2 => summary.deleted_rows += 1,
            _ => summary.modified_rows += 1,
        }
        let changed = delta.cell_deltas.len() as u32;
        summary.changed_cell_count += u64::from(changed);
        self.changed_cell_count += u64::from(changed);
        self.regions.row(
            sheet,
            u32::try_from(self.pair_count)
                .map_err(|_| io::Error::other("Too many aligned rows"))?,
            &mut runs,
        )?;
        let pair = self.pair_count as u32;
        if let Some(row) = &base_row {
            self.base_pairs.insert(row.row_number, pair);
        }
        if let Some(row) = &mine_row {
            self.mine_pairs.insert(row.row_number, pair);
        }
        self.row_runs.push((self.run_offset, runs.len() as u32));
        let mut run_index = 0;
        let mut footprint_shapes = HashSet::new();
        for cell in &delta.cell_deltas {
            while runs[run_index].end <= cell.column as u32 {
                run_index += 1;
            }
            let base_range = base_row
                .as_ref()
                .and_then(|row| base_merges.find(row.row_number, cell.column));
            let mine_range = mine_row
                .as_ref()
                .and_then(|row| mine_merges.find(row.row_number, cell.column));
            if base_range.is_some() || mine_range.is_some() {
                let shape = |range: Option<&WorkbookMergeRange>| {
                    range.map(|range| {
                        (
                            range.start_row,
                            range.end_row,
                            range.start_col,
                            range.end_col,
                        )
                    })
                };
                let key = (
                    shape(base_range),
                    shape(mine_range),
                    runs[run_index].component,
                );
                if !footprint_shapes.insert(key) {
                    continue;
                }
                self.footprints.push(MergeFootprint {
                    pair,
                    column: cell.column as u32,
                    component: runs[run_index].component,
                    base: base_range.cloned(),
                    mine: mine_range.cloned(),
                });
            }
        }
        for value in [
            sheet,
            base_ordinal.map(|value| value as u32).unwrap_or(u32::MAX),
            mine_ordinal.map(|value| value as u32).unwrap_or(u32::MAX),
            base_row
                .as_ref()
                .map(|row| row.row_number as u32)
                .unwrap_or(0),
            mine_row
                .as_ref()
                .map(|row| row.row_number as u32)
                .unwrap_or(0),
            kind | (tones << 8) | (u32::from(search_both_sides) << 16),
            changed,
            runs.len() as u32,
        ] {
            self.pairs.write_all(&value.to_le_bytes())?;
        }
        self.pairs.write_all(&self.run_offset.to_le_bytes())?;
        for run in &runs {
            for value in [run.start, run.end, run.flags, run.component] {
                self.runs.write_all(&value.to_le_bytes())?;
            }
        }
        self.run_offset += runs.len() as u64 * 16;
        self.pair_count += 1;
        summary.pair_count += 1;
        Ok(())
    }

    fn finish_sheet_geometry(
        &mut self,
        dir: &Path,
        runs_file: &str,
        sheet: &ArtifactSheet,
        summary: &SheetSummary,
        base: &StoredWorkbook,
        mine: &StoredWorkbook,
    ) -> io::Result<()> {
        let mut rectangles = Vec::with_capacity(self.footprints.len());
        for footprint in self.footprints.drain(..) {
            let mut rect = VisualRect {
                start_pair: footprint.pair,
                end_pair: footprint.pair + 1,
                start_column: footprint.column,
                end_column: footprint.column + 1,
                component: footprint.component,
            };
            for (range, pairs) in [
                (footprint.base, &self.base_pairs),
                (footprint.mine, &self.mine_pairs),
            ] {
                if let Some(range) = range {
                    rect.start_pair = rect.start_pair.min(
                        pairs
                            .get(&range.start_row)
                            .copied()
                            .unwrap_or(footprint.pair),
                    );
                    rect.end_pair = rect
                        .end_pair
                        .max(pairs.get(&range.end_row).copied().unwrap_or(footprint.pair) + 1);
                    rect.start_column = rect.start_column.min(range.start_col as u32);
                    rect.end_column = rect.end_column.max(range.end_col as u32 + 1);
                }
            }
            let root = self.regions.root(rect.component);
            let region = &mut self.regions.summaries[root as usize];
            region.start_pair = region.start_pair.min(rect.start_pair);
            region.end_pair = region.end_pair.max(rect.end_pair);
            region.start_column = region.start_column.min(rect.start_column);
            region.end_column = region.end_column.max(rect.end_column);
            rectangles.push(rect);
        }
        rectangles.sort_unstable_by_key(|rect| {
            (
                rect.start_pair,
                rect.start_column,
                rect.end_pair,
                rect.end_column,
            )
        });
        let mut active = Vec::<usize>::new();
        for (index, rect) in rectangles.iter().enumerate() {
            active.retain(|&other| rectangles[other].end_pair >= rect.start_pair);
            for &other in &active {
                let other = rectangles[other];
                if other.start_column <= rect.end_column && other.end_column >= rect.start_column {
                    self.regions.union(rect.component, other.component);
                }
            }
            active.push(index);
        }
        if !rectangles.is_empty() {
            self.runs.flush()?;
            let mut reader =
                BufReader::with_capacity(1024 * 1024, File::open(dir.join(runs_file))?);
            let mut next_rect = 0;
            let mut active = Vec::<usize>::new();
            for (row, &(offset, count)) in self.row_runs.iter().enumerate() {
                let pair = summary.pair_start as u32 + row as u32;
                active.retain(|&index| rectangles[index].end_pair >= pair);
                while next_rect < rectangles.len() && rectangles[next_rect].start_pair <= pair + 1 {
                    if rectangles[next_rect].end_pair >= pair {
                        active.push(next_rect);
                    }
                    next_rect += 1;
                }
                if active.is_empty() || count == 0 {
                    continue;
                }
                reader.seek(SeekFrom::Start(offset))?;
                let mut record = [0; 16];
                for _ in 0..count {
                    reader.read_exact(&mut record)?;
                    let start = u32::from_le_bytes(record[0..4].try_into().unwrap());
                    let end = u32::from_le_bytes(record[4..8].try_into().unwrap());
                    let component = u32::from_le_bytes(record[12..16].try_into().unwrap());
                    for &index in &active {
                        let rect = rectangles[index];
                        if start <= rect.end_column && end >= rect.start_column {
                            self.regions.union(component, rect.component);
                        }
                    }
                }
            }
        }
        if !sheet.has_base_side || !sheet.has_mine_side {
            let first_component = self
                .regions
                .summaries
                .iter()
                .position(|region| region.sheet == sheet.id);
            let root = if let Some(first) = first_component {
                let mut root = first as u32;
                for index in first + 1..self.regions.summaries.len() {
                    root = self.regions.union(root, index as u32);
                }
                root
            } else {
                let id = self.regions.parents.len() as u32;
                self.regions.parents.push(id);
                self.regions.summaries.push(Region {
                    sheet: sheet.id,
                    start_pair: summary.pair_start as u32,
                    end_pair: (summary.pair_start + summary.pair_count) as u32,
                    start_column: 0,
                    end_column: 1,
                    anchor_pair: summary.pair_start as u32,
                    anchor_column: 0,
                    cells: 0,
                });
                id
            };
            let region = &mut self.regions.summaries[root as usize];
            region.start_pair = summary.pair_start as u32;
            region.end_pair = (summary.pair_start + summary.pair_count) as u32;
            region.start_column = 0;
            region.anchor_column = 0;
            let columns = [
                base.metadata.sheets.get(&sheet.name),
                mine.metadata.sheets.get(&sheet.name),
            ]
            .into_iter()
            .flatten()
            .filter_map(|metadata| metadata.max_columns)
            .max()
            .unwrap_or(1);
            region.end_column = columns.max(1) as u32;
        }
        self.base_pairs.clear();
        self.mine_pairs.clear();
        self.row_runs.clear();
        Ok(())
    }
}

pub(super) fn build_mode(
    dir: &Path,
    mode: &str,
    sheets: &[ArtifactSheet],
    base: &mut StoredWorkbook,
    mine: &mut StoredWorkbook,
) -> io::Result<ModeSummary> {
    let pairs_file = format!("{mode}.pairs.bin");
    let runs_file = format!("{mode}.runs.bin");
    let regions_file = format!("{mode}.regions.bin");
    let mut pairs = BufWriter::with_capacity(1024 * 1024, File::create(dir.join(&pairs_file))?);
    pairs.write_all(b"VWRPAIR1")?;
    pairs.write_all(&0u64.to_le_bytes())?;
    let mut runs = BufWriter::with_capacity(1024 * 1024, File::create(dir.join(&runs_file))?);
    runs.write_all(b"VWRRUN01")?;
    let mut output = Output {
        pairs,
        runs,
        pair_count: 0,
        run_offset: 8,
        regions: Regions::default(),
        changed_cell_count: 0,
        footprints: Vec::new(),
        base_pairs: HashMap::new(),
        mine_pairs: HashMap::new(),
        row_runs: Vec::new(),
    };
    let mut summaries = Vec::new();
    let mut legacy_line_count = 0u64;
    for sheet in sheets {
        output.regions.previous.clear();
        let base_ordinals = base.sheet_rows.get(&sheet.id).cloned().unwrap_or_default();
        let mine_ordinals = mine.sheet_rows.get(&sheet.id).cloned().unwrap_or_default();
        let base_keys = alignment_keys(base, &base_ordinals, mode);
        let mine_keys = alignment_keys(mine, &mine_ordinals, mode);
        let anchors = patience_lcs(&base_keys, &mine_keys, mode);
        let base_ranges = base
            .metadata
            .sheets
            .get(&sheet.name)
            .map(|metadata| metadata.merge_ranges.clone())
            .unwrap_or_default();
        let mine_ranges = mine
            .metadata
            .sheets
            .get(&sheet.name)
            .map(|metadata| metadata.merge_ranges.clone())
            .unwrap_or_default();
        let base_merges = MergeRangeIndex::from_row_numbers(
            &base_ranges,
            &base_ordinals
                .iter()
                .map(|&ordinal| base.rows[ordinal].row_number as usize)
                .collect::<Vec<_>>(),
        );
        let mine_merges = MergeRangeIndex::from_row_numbers(
            &mine_ranges,
            &mine_ordinals
                .iter()
                .map(|&ordinal| mine.rows[ordinal].row_number as usize)
                .collect::<Vec<_>>(),
        );
        let mut summary = SheetSummary {
            sheet_id: sheet.id,
            pair_start: output.pair_count,
            legacy_line_start: legacy_line_count,
            ..SheetSummary::default()
        };
        legacy_line_count += 1;
        let mut columns = BTreeSet::new();
        let (mut base_cursor, mut mine_cursor) = (0, 0);
        for (base_end, mine_end) in anchors
            .into_iter()
            .chain(std::iter::once((base_ordinals.len(), mine_ordinals.len())))
        {
            for offset in 0..(base_end - base_cursor).max(mine_end - mine_cursor) {
                legacy_line_count +=
                    if base_cursor + offset < base_end && mine_cursor + offset < mine_end {
                        2
                    } else {
                        1
                    };
                output.pair(
                    sheet.id,
                    (base_cursor + offset < base_end).then(|| base_ordinals[base_cursor + offset]),
                    (mine_cursor + offset < mine_end).then(|| mine_ordinals[mine_cursor + offset]),
                    base_cursor + offset < base_end && mine_cursor + offset < mine_end,
                    base,
                    mine,
                    &base_merges,
                    &mine_merges,
                    mode,
                    &mut summary,
                    &mut columns,
                )?;
            }
            if base_end < base_ordinals.len() && mine_end < mine_ordinals.len() {
                legacy_line_count += 1;
                output.pair(
                    sheet.id,
                    Some(base_ordinals[base_end]),
                    Some(mine_ordinals[mine_end]),
                    false,
                    base,
                    mine,
                    &base_merges,
                    &mine_merges,
                    mode,
                    &mut summary,
                    &mut columns,
                )?;
            }
            base_cursor = base_end + 1;
            mine_cursor = mine_end + 1;
        }
        summary.changed_columns = columns.into_iter().collect();
        output.finish_sheet_geometry(dir, &runs_file, sheet, &summary, base, mine)?;
        summaries.push(summary);
    }
    output.pairs.flush()?;
    output.pairs.seek(SeekFrom::Start(8))?;
    output.pairs.write_all(&output.pair_count.to_le_bytes())?;
    output.pairs.flush()?;
    output.runs.flush()?;
    let Output {
        pairs,
        runs,
        pair_count,
        regions,
        changed_cell_count,
        ..
    } = output;
    drop(pairs);
    drop(runs);
    let region_count = regions.finish(dir, &runs_file, &regions_file)?;
    super::rename::annotate(sheets, &mut summaries, base, mine, mode);
    Ok(ModeSummary {
        pairs_file,
        runs_file,
        regions_file,
        pair_count,
        changed_cell_count,
        region_count,
        sheets: summaries,
        run_record_bytes: 16,
    })
}

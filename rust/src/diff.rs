use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{self, Write};
use std::thread;

use crate::model::{
    has_workbook_cell_content, normalize_field, DiffLineJson, RowSignature, WorkbookCellDeltaJson,
    WorkbookCellSnapshotJson, WorkbookDiffBothOutputJson, WorkbookDiffOutputJson,
    WorkbookDiffPerfJson, WorkbookMergeRange, WorkbookMetadataMap, WorkbookPrecomputedDeltaJson,
    WorkbookRowDeltaJson, WorkbookRowEntry, WorkbookSectionDeltaJson, WorkbookSheetDiffEntry,
    WorkbookTextRowEntry, WorkbookTextSheetEntry, FORMULA_SEPARATOR, SHEET_PREFIX,
};
use crate::profile;
use crate::workbook::{
    collect_workbook_metadata, parse_workbook_document, parse_workbook_text_document,
    ZipWorkbookContext,
};

struct LcsNode {
    base_idx: usize,
    mine_idx: usize,
    prev_idx: Option<usize>,
}

const MAX_LCS_CANDIDATE_PAIRS: usize = 4_000_000;
const STREAM_ALTERNATE_DELAY_MS: u64 = 500;

#[derive(Clone, Copy, PartialEq, Eq)]
enum MergeAwareCellRole {
    Single,
    Anchor,
    Covered,
}

pub(crate) struct MergeRangeIndex<'a> {
    ranges_by_row: HashMap<usize, Vec<&'a WorkbookMergeRange>>,
}

impl<'a> MergeRangeIndex<'a> {
    fn empty() -> Self {
        Self {
            ranges_by_row: HashMap::new(),
        }
    }

    pub(crate) fn new(merge_ranges: &'a [WorkbookMergeRange], rows: &[WorkbookRowEntry]) -> Self {
        Self::from_row_numbers(
            merge_ranges,
            &rows.iter().map(|row| row.row_number).collect::<Vec<_>>(),
        )
    }

    pub(crate) fn from_row_numbers(
        merge_ranges: &'a [WorkbookMergeRange],
        row_numbers: &[usize],
    ) -> Self {
        if merge_ranges.is_empty() || row_numbers.is_empty() {
            return Self {
                ranges_by_row: HashMap::new(),
            };
        }

        let mut row_numbers = row_numbers.to_vec();
        row_numbers.sort_unstable();
        row_numbers.dedup();

        let mut sorted_ranges = merge_ranges.iter().collect::<Vec<_>>();
        sorted_ranges.sort_unstable_by_key(|range| (range.start_row, range.start_col));
        let mut next_range_index = 0usize;
        let mut active_ranges: Vec<&WorkbookMergeRange> = Vec::new();
        let mut ranges_by_row = HashMap::with_capacity(row_numbers.len());

        for row_number in row_numbers {
            active_ranges.retain(|range| range.end_row >= row_number);
            while next_range_index < sorted_ranges.len()
                && sorted_ranges[next_range_index].start_row <= row_number
            {
                let range = sorted_ranges[next_range_index];
                if range.end_row >= row_number {
                    active_ranges.push(range);
                }
                next_range_index += 1;
            }
            if !active_ranges.is_empty() {
                let mut row_ranges = active_ranges.clone();
                row_ranges.sort_unstable_by_key(|range| (range.start_col, range.end_col));
                ranges_by_row.insert(row_number, row_ranges);
            }
        }

        Self { ranges_by_row }
    }

    fn ranges_for_row(&self, row_number: usize) -> &[&'a WorkbookMergeRange] {
        self.ranges_by_row
            .get(&row_number)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub(crate) fn find(&self, row_number: usize, column: usize) -> Option<&'a WorkbookMergeRange> {
        self.ranges_for_row(row_number)
            .iter()
            .copied()
            .find(|range| column >= range.start_col && column <= range.end_col)
    }
}

struct MergeAwareCellState<'cell, 'merge_range> {
    snapshot: Option<&'cell WorkbookCellSnapshotJson>,
    role: MergeAwareCellRole,
    range: Option<&'merge_range WorkbookMergeRange>,
}

fn merge_ranges_equal(left: &WorkbookMergeRange, right: &WorkbookMergeRange) -> bool {
    left.start_row == right.start_row
        && left.end_row == right.end_row
        && left.start_col == right.start_col
        && left.end_col == right.end_col
}

fn merge_range_slices_equal(left: &[WorkbookMergeRange], right: &[WorkbookMergeRange]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left_range, right_range)| merge_ranges_equal(left_range, right_range))
}

fn collect_row_merge_signatures(
    merge_index: &MergeRangeIndex<'_>,
    row_number: usize,
) -> Vec<(usize, usize, usize, usize)> {
    let mut signatures = merge_index
        .ranges_for_row(row_number)
        .iter()
        .map(|range| {
            (
                range.start_row,
                range.end_row,
                range.start_col,
                range.end_col,
            )
        })
        .collect::<Vec<_>>();
    signatures.sort_unstable();
    signatures
}

fn row_merge_semantics_match(
    row_number: usize,
    base_merge_index: &MergeRangeIndex<'_>,
    mine_merge_index: &MergeRangeIndex<'_>,
) -> bool {
    if base_merge_index.ranges_for_row(row_number).is_empty()
        && mine_merge_index.ranges_for_row(row_number).is_empty()
    {
        return true;
    }

    collect_row_merge_signatures(base_merge_index, row_number)
        == collect_row_merge_signatures(mine_merge_index, row_number)
}

fn resolve_merge_aware_cell<'cell, 'merge_range>(
    row: Option<&'cell WorkbookRowEntry>,
    row_number: usize,
    column: usize,
    merge_index: &MergeRangeIndex<'merge_range>,
) -> MergeAwareCellState<'cell, 'merge_range> {
    let resolved_range = if row.is_some() {
        merge_index.find(row_number, column)
    } else {
        None
    };
    let role = match &resolved_range {
        Some(range) if range.start_row == row_number && range.start_col == column => {
            MergeAwareCellRole::Anchor
        }
        Some(_) => MergeAwareCellRole::Covered,
        None => MergeAwareCellRole::Single,
    };
    let snapshot = match role {
        MergeAwareCellRole::Covered => None,
        MergeAwareCellRole::Single | MergeAwareCellRole::Anchor => {
            row.and_then(|entry| entry.cells.get(column))
        }
    };

    MergeAwareCellState {
        snapshot,
        role,
        range: resolved_range,
    }
}

fn merge_structure_diff(
    left: &MergeAwareCellState<'_, '_>,
    right: &MergeAwareCellState<'_, '_>,
) -> bool {
    if left.role != right.role {
        return true;
    }

    match (&left.range, &right.range) {
        (Some(left_range), Some(right_range)) => !merge_ranges_equal(left_range, right_range),
        (None, None) => false,
        _ => true,
    }
}

fn collect_row_candidate_columns(
    base_row: Option<&WorkbookRowEntry>,
    mine_row: Option<&WorkbookRowEntry>,
    base_merge_index: &MergeRangeIndex<'_>,
    mine_merge_index: &MergeRangeIndex<'_>,
) -> Vec<usize> {
    let mut columns = BTreeSet::new();
    let max_columns = usize::max(
        base_row.map(|row| row.cells.len()).unwrap_or(0),
        mine_row.map(|row| row.cells.len()).unwrap_or(0),
    );

    for column in 0..max_columns {
        columns.insert(column);
    }

    if let Some(row) = base_row {
        for range in base_merge_index
            .ranges_for_row(row.row_number)
            .iter()
            .filter(|range| range.start_row == row.row_number)
        {
            columns.insert(range.start_col);
        }
    }

    if let Some(row) = mine_row {
        for range in mine_merge_index
            .ranges_for_row(row.row_number)
            .iter()
            .filter(|range| range.start_row == row.row_number)
        {
            columns.insert(range.start_col);
        }
    }

    columns.into_iter().collect()
}

fn merge_aware_cell_value<'a>(cell: &MergeAwareCellState<'a, '_>, compare_mode: &str) -> &'a str {
    let value = cell
        .snapshot
        .map(|snapshot| snapshot.value.as_str())
        .unwrap_or("");
    if compare_mode == "content" && value.trim().is_empty() {
        ""
    } else {
        value
    }
}

fn build_merge_aware_cell_delta_json(
    column: usize,
    base_cell: &MergeAwareCellState<'_, '_>,
    mine_cell: &MergeAwareCellState<'_, '_>,
    compare_mode: &str,
) -> Option<WorkbookCellDeltaJson> {
    let value_changed = merge_aware_cell_value(base_cell, compare_mode)
        != merge_aware_cell_value(mine_cell, compare_mode)
        || base_cell
            .snapshot
            .map(|snapshot| snapshot.formula.as_str())
            .unwrap_or("")
            != mine_cell
                .snapshot
                .map(|snapshot| snapshot.formula.as_str())
                .unwrap_or("");
    let structure_changed = merge_structure_diff(base_cell, mine_cell);

    if !value_changed && !structure_changed {
        return None;
    }

    Some(WorkbookCellDeltaJson {
        column,
        base_cell: base_cell
            .snapshot
            .cloned()
            .unwrap_or_else(|| WorkbookCellSnapshotJson {
                value: String::new(),
                formula: String::new(),
            }),
        mine_cell: mine_cell
            .snapshot
            .cloned()
            .unwrap_or_else(|| WorkbookCellSnapshotJson {
                value: String::new(),
                formula: String::new(),
            }),
    })
}

fn longest_increasing_row_pairs(candidates: &[(usize, usize)]) -> Vec<(usize, usize)> {
    if candidates.is_empty() {
        return Vec::new();
    }

    let mut piles: Vec<usize> = Vec::new();
    let mut previous = vec![None; candidates.len()];
    for (candidate_idx, (_, mine_idx)) in candidates.iter().enumerate() {
        let mut low = 0usize;
        let mut high = piles.len();
        while low < high {
            let mid = (low + high) >> 1;
            if candidates[piles[mid]].1 < *mine_idx {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if low > 0 {
            previous[candidate_idx] = Some(piles[low - 1]);
        }
        if low == piles.len() {
            piles.push(candidate_idx);
        } else {
            piles[low] = candidate_idx;
        }
    }

    let mut result = Vec::with_capacity(piles.len());
    let mut cursor = piles.last().copied();
    while let Some(candidate_idx) = cursor {
        result.push(candidates[candidate_idx]);
        cursor = previous[candidate_idx];
    }
    result.reverse();
    result
}

fn unique_common_row_anchors<R: RowSignature>(
    base_rows: &[R],
    mine_rows: &[R],
    compare_mode: &str,
) -> Vec<(usize, usize)> {
    let mut base_counts: HashMap<&str, usize> = HashMap::new();
    let mut mine_counts: HashMap<&str, (usize, usize)> = HashMap::new();
    for row in base_rows {
        *base_counts.entry(row.signature(compare_mode)).or_default() += 1;
    }
    for (mine_idx, row) in mine_rows.iter().enumerate() {
        let entry = mine_counts
            .entry(row.signature(compare_mode))
            .or_insert((0, mine_idx));
        entry.0 += 1;
        entry.1 = mine_idx;
    }

    let candidates = base_rows
        .iter()
        .enumerate()
        .filter_map(|(base_idx, row)| {
            if base_counts.get(row.signature(compare_mode)) != Some(&1) {
                return None;
            }
            let (count, mine_idx) = mine_counts.get(row.signature(compare_mode)).copied()?;
            (count == 1).then_some((base_idx, mine_idx))
        })
        .collect::<Vec<_>>();
    longest_increasing_row_pairs(&candidates)
}

fn patience_lcs_middle<R: RowSignature>(
    base_rows: &[R],
    mine_rows: &[R],
    compare_mode: &str,
) -> Vec<(usize, usize)> {
    if base_rows.is_empty() || mine_rows.is_empty() {
        return Vec::new();
    }

    let mut mine_index: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, row) in mine_rows.iter().enumerate() {
        mine_index
            .entry(row.signature(compare_mode))
            .or_default()
            .push(index);
    }

    let mut candidate_pairs = 0usize;
    for row in base_rows {
        candidate_pairs = candidate_pairs.saturating_add(
            mine_index
                .get(row.signature(compare_mode))
                .map(Vec::len)
                .unwrap_or(0),
        );
        if candidate_pairs > MAX_LCS_CANDIDATE_PAIRS {
            return unique_common_row_anchors(base_rows, mine_rows, compare_mode);
        }
    }

    let mut nodes: Vec<LcsNode> = Vec::with_capacity(candidate_pairs);
    let mut piles: Vec<usize> = Vec::new();
    let mut tails: Vec<usize> = Vec::new();

    for (base_idx, row) in base_rows.iter().enumerate() {
        let Some(positions) = mine_index.get(row.signature(compare_mode)) else {
            continue;
        };

        // Positions are collected in ascending order. Iterating in reverse
        // prevents one base row from chaining multiple duplicate mine rows.
        for &mine_idx in positions.iter().rev() {
            let mut low = 0usize;
            let mut high = tails.len();
            while low < high {
                let mid = (low + high) >> 1;
                if tails[mid] < mine_idx {
                    low = mid + 1;
                } else {
                    high = mid;
                }
            }
            if low > 0 && tails[low - 1] >= mine_idx {
                continue;
            }

            let node_idx = nodes.len();
            nodes.push(LcsNode {
                base_idx,
                mine_idx,
                prev_idx: if low > 0 { Some(piles[low - 1]) } else { None },
            });

            if low == piles.len() {
                piles.push(node_idx);
                tails.push(mine_idx);
            } else {
                piles[low] = node_idx;
                tails[low] = mine_idx;
            }
        }
    }

    let mut result = Vec::with_capacity(piles.len());
    let mut cursor = piles.last().copied();
    while let Some(node_idx) = cursor {
        let node = &nodes[node_idx];
        result.push((node.base_idx, node.mine_idx));
        cursor = node.prev_idx;
    }
    result.reverse();
    result
}

pub(crate) fn patience_lcs<R: RowSignature>(
    base_rows: &[R],
    mine_rows: &[R],
    compare_mode: &str,
) -> Vec<(usize, usize)> {
    if base_rows.is_empty() || mine_rows.is_empty() {
        return Vec::new();
    }

    let shared_limit = usize::min(base_rows.len(), mine_rows.len());
    let mut prefix_len = 0usize;
    while prefix_len < shared_limit
        && base_rows[prefix_len].signature(compare_mode)
            == mine_rows[prefix_len].signature(compare_mode)
    {
        prefix_len += 1;
    }

    let mut suffix_len = 0usize;
    while suffix_len < shared_limit.saturating_sub(prefix_len)
        && base_rows[base_rows.len() - 1 - suffix_len].signature(compare_mode)
            == mine_rows[mine_rows.len() - 1 - suffix_len].signature(compare_mode)
    {
        suffix_len += 1;
    }

    let mut result = Vec::with_capacity(prefix_len + suffix_len);
    result.extend((0..prefix_len).map(|index| (index, index)));

    let base_middle_end = base_rows.len() - suffix_len;
    let mine_middle_end = mine_rows.len() - suffix_len;
    result.extend(
        patience_lcs_middle(
            &base_rows[prefix_len..base_middle_end],
            &mine_rows[prefix_len..mine_middle_end],
            compare_mode,
        )
        .into_iter()
        .map(|(base_idx, mine_idx)| (base_idx + prefix_len, mine_idx + prefix_len)),
    );

    result.extend(
        (0..suffix_len)
            .rev()
            .map(|offset| (base_rows.len() - 1 - offset, mine_rows.len() - 1 - offset)),
    );
    result
}

fn push_diff_line(
    output: &mut Vec<DiffLineJson>,
    line_type: &str,
    base: Option<String>,
    mine: Option<String>,
    base_line_no: Option<usize>,
    mine_line_no: Option<usize>,
) {
    let serialized_mine = if line_type == "equal" && base == mine {
        None
    } else {
        mine
    };
    let serialized_mine_line_no = if line_type == "equal" && base_line_no == mine_line_no {
        None
    } else {
        mine_line_no
    };
    output.push(DiffLineJson {
        line_type: line_type.to_string(),
        base,
        mine: serialized_mine,
        base_line_no,
        mine_line_no: serialized_mine_line_no,
    });
}

pub(crate) fn build_workbook_row_delta_json(
    base_row: Option<&WorkbookRowEntry>,
    mine_row: Option<&WorkbookRowEntry>,
    base_merge_index: &MergeRangeIndex<'_>,
    mine_merge_index: &MergeRangeIndex<'_>,
    left_line_idx: Option<usize>,
    right_line_idx: Option<usize>,
    compare_mode: &str,
) -> WorkbookRowDeltaJson {
    if let (Some(base_row), Some(mine_row)) = (base_row, mine_row) {
        if base_row.row_number == mine_row.row_number
            && base_row.signature(compare_mode) == mine_row.signature(compare_mode)
            && row_merge_semantics_match(base_row.row_number, base_merge_index, mine_merge_index)
        {
            return WorkbookRowDeltaJson {
                left_line_idx,
                right_line_idx,
                base_row_number: Some(base_row.row_number),
                mine_row_number: Some(mine_row.row_number),
                cell_deltas: Vec::new(),
            };
        }
    }

    let base_row_number = base_row.map(|row| row.row_number).unwrap_or(0);
    let mine_row_number = mine_row.map(|row| row.row_number).unwrap_or(0);
    let candidate_columns =
        collect_row_candidate_columns(base_row, mine_row, base_merge_index, mine_merge_index);
    let mut cell_deltas = Vec::with_capacity(candidate_columns.len());

    for column in candidate_columns {
        let base_cell =
            resolve_merge_aware_cell(base_row, base_row_number, column, base_merge_index);
        let mine_cell =
            resolve_merge_aware_cell(mine_row, mine_row_number, column, mine_merge_index);
        if let Some(cell_delta) =
            build_merge_aware_cell_delta_json(column, &base_cell, &mine_cell, compare_mode)
        {
            cell_deltas.push(cell_delta);
        }
    }

    WorkbookRowDeltaJson {
        left_line_idx,
        right_line_idx,
        base_row_number: base_row.map(|row| row.row_number),
        mine_row_number: mine_row.map(|row| row.row_number),
        cell_deltas,
    }
}

#[allow(clippy::too_many_arguments)]
fn append_row_pairs(
    output: &mut Vec<DiffLineJson>,
    base_rows: &[WorkbookRowEntry],
    mine_rows: &[WorkbookRowEntry],
    base_merge_ranges: &[WorkbookMergeRange],
    mine_merge_ranges: &[WorkbookMergeRange],
    sheet_rows: &mut Vec<WorkbookRowDeltaJson>,
    compare_mode: &str,
    collect_row_deltas: bool,
) {
    let base_merge_index = MergeRangeIndex::new(base_merge_ranges, base_rows);
    let mine_merge_index = MergeRangeIndex::new(mine_merge_ranges, mine_rows);

    if base_rows.len() == mine_rows.len()
        && base_rows
            .iter()
            .zip(mine_rows.iter())
            .all(|(base_row, mine_row)| {
                base_row.row_number == mine_row.row_number
                    && base_row.signature(compare_mode) == mine_row.signature(compare_mode)
                    && row_merge_semantics_match(
                        base_row.row_number,
                        &base_merge_index,
                        &mine_merge_index,
                    )
            })
    {
        for (base_row, mine_row) in base_rows.iter().zip(mine_rows.iter()) {
            let line_idx = output.len();
            push_diff_line(
                output,
                "equal",
                Some(base_row.raw_line.clone()),
                Some(mine_row.raw_line.clone()),
                Some(base_row.row_number),
                Some(mine_row.row_number),
            );
            if collect_row_deltas {
                sheet_rows.push(build_workbook_row_delta_json(
                    Some(base_row),
                    Some(mine_row),
                    &base_merge_index,
                    &mine_merge_index,
                    Some(line_idx),
                    Some(line_idx),
                    compare_mode,
                ));
            }
        }
        return;
    }

    let anchors = patience_lcs(base_rows, mine_rows, compare_mode);
    let mut base_idx = 0usize;
    let mut mine_idx = 0usize;

    #[allow(clippy::too_many_arguments)]
    fn emit_unmatched_rows(
        output: &mut Vec<DiffLineJson>,
        base_rows: &[WorkbookRowEntry],
        mine_rows: &[WorkbookRowEntry],
        base_merge_index: &MergeRangeIndex<'_>,
        mine_merge_index: &MergeRangeIndex<'_>,
        sheet_rows: &mut Vec<WorkbookRowDeltaJson>,
        base_idx: &mut usize,
        mine_idx: &mut usize,
        base_end: usize,
        mine_end: usize,
        compare_mode: &str,
        collect_row_deltas: bool,
    ) {
        let unmatched_count = usize::max(
            base_end.saturating_sub(*base_idx),
            mine_end.saturating_sub(*mine_idx),
        );
        for offset in 0..unmatched_count {
            let base_row = if *base_idx + offset < base_end {
                base_rows.get(*base_idx + offset)
            } else {
                None
            };
            let mine_row = if *mine_idx + offset < mine_end {
                mine_rows.get(*mine_idx + offset)
            } else {
                None
            };

            match (base_row, mine_row) {
                (Some(base_row), Some(mine_row)) => {
                    let left_line_idx = output.len();
                    push_diff_line(
                        output,
                        "delete",
                        Some(base_row.raw_line.clone()),
                        None,
                        Some(base_row.row_number),
                        None,
                    );
                    let right_line_idx = output.len();
                    push_diff_line(
                        output,
                        "add",
                        None,
                        Some(mine_row.raw_line.clone()),
                        None,
                        Some(mine_row.row_number),
                    );
                    if collect_row_deltas {
                        sheet_rows.push(build_workbook_row_delta_json(
                            Some(base_row),
                            Some(mine_row),
                            base_merge_index,
                            mine_merge_index,
                            Some(left_line_idx),
                            Some(right_line_idx),
                            compare_mode,
                        ));
                    }
                }
                (Some(base_row), None) => {
                    let left_line_idx = output.len();
                    push_diff_line(
                        output,
                        "delete",
                        Some(base_row.raw_line.clone()),
                        None,
                        Some(base_row.row_number),
                        None,
                    );
                    if collect_row_deltas {
                        sheet_rows.push(build_workbook_row_delta_json(
                            Some(base_row),
                            None,
                            base_merge_index,
                            mine_merge_index,
                            Some(left_line_idx),
                            None,
                            compare_mode,
                        ));
                    }
                }
                (None, Some(mine_row)) => {
                    let right_line_idx = output.len();
                    push_diff_line(
                        output,
                        "add",
                        None,
                        Some(mine_row.raw_line.clone()),
                        None,
                        Some(mine_row.row_number),
                    );
                    if collect_row_deltas {
                        sheet_rows.push(build_workbook_row_delta_json(
                            None,
                            Some(mine_row),
                            base_merge_index,
                            mine_merge_index,
                            None,
                            Some(right_line_idx),
                            compare_mode,
                        ));
                    }
                }
                (None, None) => {}
            }
        }
        *base_idx = base_end;
        *mine_idx = mine_end;
    }

    for (anchor_base_idx, anchor_mine_idx) in anchors {
        emit_unmatched_rows(
            output,
            base_rows,
            mine_rows,
            &base_merge_index,
            &mine_merge_index,
            sheet_rows,
            &mut base_idx,
            &mut mine_idx,
            anchor_base_idx,
            anchor_mine_idx,
            compare_mode,
            collect_row_deltas,
        );
        let base_row = &base_rows[anchor_base_idx];
        let mine_row = &mine_rows[anchor_mine_idx];
        let line_idx = output.len();
        push_diff_line(
            output,
            "equal",
            Some(base_row.raw_line.clone()),
            Some(mine_row.raw_line.clone()),
            Some(base_row.row_number),
            Some(mine_row.row_number),
        );
        if collect_row_deltas {
            sheet_rows.push(build_workbook_row_delta_json(
                Some(base_row),
                Some(mine_row),
                &base_merge_index,
                &mine_merge_index,
                Some(line_idx),
                Some(line_idx),
                compare_mode,
            ));
        }
        base_idx = anchor_base_idx + 1;
        mine_idx = anchor_mine_idx + 1;
    }

    emit_unmatched_rows(
        output,
        base_rows,
        mine_rows,
        &base_merge_index,
        &mine_merge_index,
        sheet_rows,
        &mut base_idx,
        &mut mine_idx,
        base_rows.len(),
        mine_rows.len(),
        compare_mode,
        collect_row_deltas,
    );
}

fn append_equal_sheet_output(
    diff_lines: &mut Vec<DiffLineJson>,
    sections: &mut Vec<WorkbookSectionDeltaJson>,
    sheet: &WorkbookTextSheetEntry,
    compare_mode: &str,
    include_workbook_delta: bool,
) {
    let row_metadata = rows_metadata_from_text_rows(&sheet.rows, compare_mode);
    let sheet_line_idx = diff_lines.len();
    push_diff_line(
        diff_lines,
        "equal",
        Some(sheet.raw_sheet_line.clone()),
        Some(sheet.raw_sheet_line.clone()),
        None,
        None,
    );

    let mut section_rows = Vec::new();
    for row in &sheet.rows {
        let line_idx = diff_lines.len();
        push_diff_line(
            diff_lines,
            "equal",
            Some(row.raw_line.clone()),
            Some(row.raw_line.clone()),
            Some(row.row_number),
            Some(row.row_number),
        );
        if include_workbook_delta {
            section_rows.push(WorkbookRowDeltaJson {
                left_line_idx: Some(line_idx),
                right_line_idx: Some(line_idx),
                base_row_number: Some(row.row_number),
                mine_row_number: Some(row.row_number),
                cell_deltas: Vec::new(),
            });
        }
    }

    if include_workbook_delta {
        sections.push(build_workbook_section_delta_json(
            sheet.name.clone(),
            true,
            true,
            sheet_line_idx,
            section_rows,
            row_metadata.clone(),
            row_metadata,
        ));
    }
}

fn text_cell_has_content(field: &str, compare_mode: &str) -> bool {
    let separator_idx = field.find(FORMULA_SEPARATOR);
    let value = separator_idx.map(|idx| &field[..idx]).unwrap_or(field);
    let formula = separator_idx
        .map(|idx| &field[idx + FORMULA_SEPARATOR.len_utf8()..])
        .unwrap_or("");
    let normalized_value = if compare_mode == "content" && value.trim().is_empty() {
        ""
    } else {
        value
    };
    !normalized_value.is_empty() || !formula.is_empty()
}

fn rows_metadata_from_text_rows(
    rows: &[WorkbookTextRowEntry],
    compare_mode: &str,
) -> Vec<(usize, usize, bool)> {
    rows.iter()
        .map(|row| {
            let max_columns = row.raw_line.split('\t').count().saturating_sub(2);
            let has_content = max_columns > 0
                && row
                    .raw_line
                    .split('\t')
                    .skip(2)
                    .any(|cell| text_cell_has_content(cell, compare_mode));
            (row.row_number, max_columns, has_content)
        })
        .collect()
}

fn rows_metadata_from_diff_rows(
    rows: &[WorkbookRowEntry],
    compare_mode: &str,
) -> Vec<(usize, usize, bool)> {
    rows.iter()
        .map(|row| {
            let has_content = row
                .cells
                .iter()
                .any(|cell| has_workbook_cell_content(cell, compare_mode));
            (row.row_number, row.cells.len(), has_content)
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_workbook_section_delta_json(
    name: String,
    has_base_side: bool,
    has_mine_side: bool,
    sheet_line_idx: usize,
    mut rows: Vec<WorkbookRowDeltaJson>,
    base_rows: Vec<(usize, usize, bool)>,
    mine_rows: Vec<(usize, usize, bool)>,
) -> WorkbookSectionDeltaJson {
    let line_indexes = rows
        .iter()
        .flat_map(|row| [row.left_line_idx, row.right_line_idx])
        .flatten()
        .collect::<Vec<_>>();
    let row_count = base_rows
        .iter()
        .chain(mine_rows.iter())
        .map(|(row_number, _, _)| *row_number)
        .max();
    let max_columns = base_rows
        .iter()
        .chain(mine_rows.iter())
        .map(|(_, max_columns, _)| *max_columns)
        .max();
    let first_base_data =
        base_rows
            .iter()
            .enumerate()
            .find_map(|(index, (row_number, _, has_content))| {
                has_content.then_some((index, *row_number))
            });
    let first_mine_data =
        mine_rows
            .iter()
            .enumerate()
            .find_map(|(index, (row_number, _, has_content))| {
                has_content.then_some((index, *row_number))
            });
    let first_data_row_number = match (first_base_data, first_mine_data) {
        (Some((base_index, base_row_number)), Some((mine_index, mine_row_number))) => {
            if base_index <= mine_index {
                Some(base_row_number)
            } else {
                Some(mine_row_number)
            }
        }
        (Some((_, base_row_number)), None) => Some(base_row_number),
        (None, Some((_, mine_row_number))) => Some(mine_row_number),
        (None, None) => None,
    };
    let first_data_line_idx = first_data_row_number.and_then(|target_row_number| {
        rows.iter().find_map(|row| {
            let base_match = row.base_row_number == Some(target_row_number);
            let mine_match = row.mine_row_number == Some(target_row_number);
            if base_match {
                row.left_line_idx
            } else if mine_match {
                row.right_line_idx
            } else {
                None
            }
        })
    });
    let start_line_idx = line_indexes.iter().copied().min().unwrap_or(sheet_line_idx);
    let end_line_idx = line_indexes.iter().copied().max().unwrap_or(sheet_line_idx);
    rows.retain(|row| {
        let has_cell_changes = !row.cell_deltas.is_empty();
        let has_structural_change = row.left_line_idx.is_none()
            || row.right_line_idx.is_none()
            || row.left_line_idx != row.right_line_idx
            || row.base_row_number != row.mine_row_number;
        let is_boundary_anchor = row.left_line_idx == Some(start_line_idx)
            || row.right_line_idx == Some(start_line_idx)
            || row.left_line_idx == Some(end_line_idx)
            || row.right_line_idx == Some(end_line_idx)
            || row.left_line_idx == first_data_line_idx
            || row.right_line_idx == first_data_line_idx;
        has_cell_changes || has_structural_change || is_boundary_anchor
    });

    WorkbookSectionDeltaJson {
        name,
        has_base_side,
        has_mine_side,
        start_line_idx: Some(sheet_line_idx.min(start_line_idx)),
        end_line_idx: Some(end_line_idx.max(sheet_line_idx)),
        max_columns,
        row_count,
        first_data_line_idx,
        first_data_row_number,
        rows,
    }
}

struct PreparedWorkbookComparison {
    base_sheet_names: Vec<String>,
    mine_sheet_names: Vec<String>,
    unchanged_sheet_names: HashSet<String>,
    base_equal_by_name: HashMap<String, WorkbookTextSheetEntry>,
    base_full_by_name: HashMap<String, WorkbookSheetDiffEntry>,
    mine_full_by_name: HashMap<String, WorkbookSheetDiffEntry>,
    base_workbook_metadata: WorkbookMetadataMap,
    mine_workbook_metadata: WorkbookMetadataMap,
    metadata_ms: f64,
}

impl PreparedWorkbookComparison {
    fn build_output(&self, compare_mode: &str) -> WorkbookDiffOutputJson {
        build_prepared_workbook_output(
            &self.base_sheet_names,
            &self.mine_sheet_names,
            &self.unchanged_sheet_names,
            &self.base_equal_by_name,
            &self.base_full_by_name,
            &self.mine_full_by_name,
            &self.base_workbook_metadata,
            &self.mine_workbook_metadata,
            self.metadata_ms,
            compare_mode,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn build_prepared_workbook_output(
    base_sheet_names: &[String],
    mine_sheet_names: &[String],
    unchanged_sheet_names: &HashSet<String>,
    base_equal_by_name: &HashMap<String, WorkbookTextSheetEntry>,
    base_full_by_name: &HashMap<String, WorkbookSheetDiffEntry>,
    mine_full_by_name: &HashMap<String, WorkbookSheetDiffEntry>,
    base_workbook_metadata: &WorkbookMetadataMap,
    mine_workbook_metadata: &WorkbookMetadataMap,
    metadata_ms: f64,
    compare_mode: &str,
) -> WorkbookDiffOutputJson {
    let build_start = profile::start();
    let base_sheet_name_set: HashSet<&str> = base_sheet_names.iter().map(String::as_str).collect();
    let mut diff_lines = Vec::new();
    let mut sections = Vec::new();

    for base_sheet_name in base_sheet_names {
        if unchanged_sheet_names.contains(base_sheet_name) {
            if let Some(sheet) = base_equal_by_name.get(base_sheet_name) {
                append_equal_sheet_output(
                    &mut diff_lines,
                    &mut sections,
                    sheet,
                    compare_mode,
                    true,
                );
            }
            continue;
        }

        let Some(base_sheet) = base_full_by_name.get(base_sheet_name) else {
            continue;
        };
        if let Some(mine_sheet) = mine_full_by_name.get(base_sheet_name) {
            let section_name = base_sheet.name.clone();
            let sheet_line_idx = diff_lines.len();
            let base_rows_metadata = rows_metadata_from_diff_rows(&base_sheet.rows, compare_mode);
            let mine_rows_metadata = rows_metadata_from_diff_rows(&mine_sheet.rows, compare_mode);
            let base_merge_ranges = base_workbook_metadata
                .sheets
                .get(base_sheet_name)
                .map(|sheet| sheet.merge_ranges.as_slice())
                .unwrap_or(&[]);
            let mine_merge_ranges = mine_workbook_metadata
                .sheets
                .get(base_sheet_name)
                .map(|sheet| sheet.merge_ranges.as_slice())
                .unwrap_or(&[]);
            push_diff_line(
                &mut diff_lines,
                "equal",
                Some(base_sheet.raw_sheet_line.clone()),
                Some(mine_sheet.raw_sheet_line.clone()),
                None,
                None,
            );
            let mut rows = Vec::new();
            append_row_pairs(
                &mut diff_lines,
                &base_sheet.rows,
                &mine_sheet.rows,
                base_merge_ranges,
                mine_merge_ranges,
                &mut rows,
                compare_mode,
                true,
            );
            sections.push(build_workbook_section_delta_json(
                section_name,
                true,
                true,
                sheet_line_idx,
                rows,
                base_rows_metadata,
                mine_rows_metadata,
            ));
            continue;
        }

        let section_name = base_sheet.name.clone();
        let sheet_line_idx = diff_lines.len();
        let base_rows_metadata = rows_metadata_from_diff_rows(&base_sheet.rows, compare_mode);
        let base_merge_ranges = base_workbook_metadata
            .sheets
            .get(base_sheet_name)
            .map(|sheet| sheet.merge_ranges.as_slice())
            .unwrap_or(&[]);
        let base_merge_index = MergeRangeIndex::new(base_merge_ranges, &base_sheet.rows);
        let empty_merge_index = MergeRangeIndex::empty();
        push_diff_line(
            &mut diff_lines,
            "delete",
            Some(base_sheet.raw_sheet_line.clone()),
            None,
            None,
            None,
        );
        let mut rows = Vec::new();
        for row in &base_sheet.rows {
            let line_idx = diff_lines.len();
            push_diff_line(
                &mut diff_lines,
                "delete",
                Some(row.raw_line.clone()),
                None,
                Some(row.row_number),
                None,
            );
            rows.push(build_workbook_row_delta_json(
                Some(row),
                None,
                &base_merge_index,
                &empty_merge_index,
                Some(line_idx),
                None,
                compare_mode,
            ));
        }
        sections.push(build_workbook_section_delta_json(
            section_name,
            true,
            false,
            sheet_line_idx,
            rows,
            base_rows_metadata,
            Vec::new(),
        ));
    }

    for mine_sheet_name in mine_sheet_names {
        if base_sheet_name_set.contains(mine_sheet_name.as_str()) {
            continue;
        }
        let Some(mine_sheet) = mine_full_by_name.get(mine_sheet_name) else {
            continue;
        };
        let section_name = mine_sheet.name.clone();
        let sheet_line_idx = diff_lines.len();
        let mine_rows_metadata = rows_metadata_from_diff_rows(&mine_sheet.rows, compare_mode);
        let mine_merge_ranges = mine_workbook_metadata
            .sheets
            .get(mine_sheet_name)
            .map(|sheet| sheet.merge_ranges.as_slice())
            .unwrap_or(&[]);
        let mine_merge_index = MergeRangeIndex::new(mine_merge_ranges, &mine_sheet.rows);
        let empty_merge_index = MergeRangeIndex::empty();
        push_diff_line(
            &mut diff_lines,
            "add",
            None,
            Some(mine_sheet.raw_sheet_line.clone()),
            None,
            None,
        );
        let mut rows = Vec::new();
        for row in &mine_sheet.rows {
            let line_idx = diff_lines.len();
            push_diff_line(
                &mut diff_lines,
                "add",
                None,
                Some(row.raw_line.clone()),
                None,
                Some(row.row_number),
            );
            rows.push(build_workbook_row_delta_json(
                None,
                Some(row),
                &empty_merge_index,
                &mine_merge_index,
                None,
                Some(line_idx),
                compare_mode,
            ));
        }
        sections.push(build_workbook_section_delta_json(
            section_name,
            false,
            true,
            sheet_line_idx,
            rows,
            Vec::new(),
            mine_rows_metadata,
        ));
    }

    profile::log_elapsed(
        build_start,
        format!("build_workbook_diff_output mode={compare_mode}"),
    );
    WorkbookDiffOutputJson {
        diff_lines,
        workbook_delta: Some(WorkbookPrecomputedDeltaJson {
            compare_mode: compare_mode.to_string(),
            sections,
        }),
        base_metadata: Some(base_workbook_metadata.clone()),
        mine_metadata: Some(mine_workbook_metadata.clone()),
        perf: Some(WorkbookDiffPerfJson { metadata_ms }),
    }
}

fn prepare_workbook_comparison(
    base_file_path: &str,
    mine_file_path: &str,
    profile_mode: &str,
) -> io::Result<PreparedWorkbookComparison> {
    let total_start = profile::start();
    if base_file_path == mine_file_path {
        profile::log(format!(
            "diff_fast_path same_file=true file={} mode={}",
            base_file_path, profile_mode,
        ));
        let empty_workbook_metadata = WorkbookMetadataMap {
            sheets: std::collections::BTreeMap::new(),
        };
        let metadata_start = std::time::Instant::now();
        let workbook_metadata =
            collect_workbook_metadata(base_file_path).unwrap_or(empty_workbook_metadata);
        let metadata_ms = metadata_start.elapsed().as_secs_f64() * 1000.0;
        let sheets = parse_workbook_text_document(base_file_path, None)?;
        let sheet_names = sheets
            .iter()
            .map(|sheet| sheet.name.clone())
            .collect::<Vec<_>>();
        let unchanged_sheet_names = sheet_names.iter().cloned().collect::<HashSet<_>>();
        let base_equal_by_name = sheets
            .into_iter()
            .map(|sheet| (sheet.name.clone(), sheet))
            .collect::<HashMap<_, _>>();
        profile::log_elapsed(
            total_start,
            format!(
                "prepare_workbook_comparison mode={} same_file=true",
                profile_mode
            ),
        );
        return Ok(PreparedWorkbookComparison {
            base_sheet_names: sheet_names.clone(),
            mine_sheet_names: sheet_names,
            unchanged_sheet_names,
            base_equal_by_name,
            base_full_by_name: HashMap::new(),
            mine_full_by_name: HashMap::new(),
            base_workbook_metadata: workbook_metadata.clone(),
            mine_workbook_metadata: workbook_metadata,
            metadata_ms,
        });
    }

    let empty_workbook_metadata = WorkbookMetadataMap {
        sheets: std::collections::BTreeMap::new(),
    };
    let metadata_start = std::time::Instant::now();
    let (base_workbook_metadata, mine_workbook_metadata) = thread::scope(|scope| {
        let base_handle = scope.spawn(|| collect_workbook_metadata(base_file_path));
        let mine_handle = scope.spawn(|| collect_workbook_metadata(mine_file_path));
        (
            base_handle
                .join()
                .ok()
                .flatten()
                .unwrap_or_else(|| empty_workbook_metadata.clone()),
            mine_handle
                .join()
                .ok()
                .flatten()
                .unwrap_or_else(|| empty_workbook_metadata.clone()),
        )
    });
    let metadata_ms = metadata_start.elapsed().as_secs_f64() * 1000.0;

    let inspect_start = profile::start();
    let mut use_sheet_inspection = false;
    let mut base_sheet_names = Vec::new();
    let mut mine_sheet_names = Vec::new();
    let mut unchanged_sheet_names: HashSet<String> = HashSet::new();
    let mut base_equal_by_name: HashMap<String, WorkbookTextSheetEntry> = HashMap::new();
    let (mut base_zip_context, mut mine_zip_context) = thread::scope(|scope| {
        let base_handle = scope.spawn(|| ZipWorkbookContext::open(base_file_path).ok());
        let mine_handle = scope.spawn(|| ZipWorkbookContext::open(mine_file_path).ok());
        (
            base_handle.join().ok().flatten(),
            mine_handle.join().ok().flatten(),
        )
    });

    if let (Some(base_context), Some(mine_context)) = (&mut base_zip_context, &mut mine_zip_context)
    {
        let candidate_base_sheet_names = base_context.sheet_names();
        let candidate_mine_sheet_names = mine_context.sheet_names();
        let candidate_mine_sheet_name_set: HashSet<String> =
            candidate_mine_sheet_names.iter().cloned().collect();
        let mut xml_different_common_sheet_names = HashSet::new();
        let mut inspection_failed = false;

        use_sheet_inspection = true;
        base_sheet_names = candidate_base_sheet_names;
        mine_sheet_names = candidate_mine_sheet_names;

        for sheet_name in &base_sheet_names {
            if !candidate_mine_sheet_name_set.contains(sheet_name) {
                continue;
            }

            let base_xml = match base_context.read_sheet_xml_by_name(sheet_name) {
                Ok(value) => value,
                Err(_) => {
                    inspection_failed = true;
                    break;
                }
            };
            let mine_xml = match mine_context.read_sheet_xml_by_name(sheet_name) {
                Ok(value) => value,
                Err(_) => {
                    inspection_failed = true;
                    break;
                }
            };

            if base_xml != mine_xml {
                xml_different_common_sheet_names.insert(sheet_name.clone());
                continue;
            }

            let scanned = base_context.scan_text_sheet_with_shared_refs(sheet_name, &base_xml);
            let shared_strings_match = scanned.shared_string_indices.iter().all(|index| {
                base_context
                    .shared_strings()
                    .value_equals(*index, mine_context.shared_strings())
            });

            if shared_strings_match {
                unchanged_sheet_names.insert(sheet_name.clone());
                base_equal_by_name.insert(sheet_name.clone(), scanned.sheet);
                base_context.remove_cached_sheet_xml(sheet_name);
                mine_context.remove_cached_sheet_xml(sheet_name);
            }
        }

        if !inspection_failed && !xml_different_common_sheet_names.is_empty() {
            let (base_inspections, mine_fingerprints) = thread::scope(|scope| {
                let base_handle = scope.spawn(|| {
                    base_context
                        .collect_text_sheet_inspections(Some(&xml_different_common_sheet_names))
                });
                let mine_handle = scope.spawn(|| {
                    mine_context
                        .collect_semantic_fingerprints(Some(&xml_different_common_sheet_names))
                });
                (
                    base_handle.join().unwrap_or_else(|_| {
                        Err(io::Error::other("Workbook base inspection thread panicked"))
                    }),
                    mine_handle.join().unwrap_or_else(|_| {
                        Err(io::Error::other("Workbook mine inspection thread panicked"))
                    }),
                )
            });

            match (base_inspections, mine_fingerprints) {
                (Ok(base_inspections), Ok(mine_fingerprints)) => {
                    let equal_xml_different_sheet_names: HashSet<String> =
                        xml_different_common_sheet_names
                            .iter()
                            .filter(|sheet_name| {
                                base_inspections
                                    .get(*sheet_name)
                                    .map(|inspection| &inspection.fingerprint)
                                    == mine_fingerprints.get(*sheet_name)
                                    && merge_range_slices_equal(
                                        base_workbook_metadata
                                            .sheets
                                            .get(*sheet_name)
                                            .map(|sheet| sheet.merge_ranges.as_slice())
                                            .unwrap_or(&[]),
                                        mine_workbook_metadata
                                            .sheets
                                            .get(*sheet_name)
                                            .map(|sheet| sheet.merge_ranges.as_slice())
                                            .unwrap_or(&[]),
                                    )
                            })
                            .cloned()
                            .collect();

                    if !equal_xml_different_sheet_names.is_empty() {
                        for sheet_name in equal_xml_different_sheet_names {
                            let Some(inspection) = base_inspections.get(&sheet_name) else {
                                inspection_failed = true;
                                break;
                            };
                            unchanged_sheet_names.insert(sheet_name.clone());
                            base_equal_by_name.insert(
                                sheet_name.clone(),
                                WorkbookTextSheetEntry {
                                    name: sheet_name.clone(),
                                    raw_sheet_line: format!(
                                        "{}\t{}",
                                        SHEET_PREFIX,
                                        normalize_field(&sheet_name).trim()
                                    ),
                                    rows: inspection.rows.clone(),
                                },
                            );
                            base_context.remove_cached_sheet_xml(&sheet_name);
                            mine_context.remove_cached_sheet_xml(&sheet_name);
                        }
                    }
                }
                _ => inspection_failed = true,
            }
        }

        if inspection_failed {
            use_sheet_inspection = false;
            unchanged_sheet_names.clear();
            base_equal_by_name.clear();
        }
    }

    let base_full_sheet_names: HashSet<String> = if use_sheet_inspection {
        base_sheet_names
            .iter()
            .filter(|sheet_name| !unchanged_sheet_names.contains(*sheet_name))
            .cloned()
            .collect()
    } else {
        HashSet::new()
    };
    let mine_full_sheet_names: HashSet<String> = if use_sheet_inspection {
        mine_sheet_names
            .iter()
            .filter(|sheet_name| !unchanged_sheet_names.contains(*sheet_name))
            .cloned()
            .collect()
    } else {
        HashSet::new()
    };
    if use_sheet_inspection {
        profile::log_elapsed(
            inspect_start,
            format!(
                "diff_sheet_inspection mode={} base_sheets={} mine_sheets={} unchanged={} changed_base={} changed_mine={}",
                profile_mode,
                base_sheet_names.len(),
                mine_sheet_names.len(),
                unchanged_sheet_names.len(),
                base_full_sheet_names.len(),
                mine_full_sheet_names.len(),
            ),
        );
    } else {
        profile::log_elapsed(
            inspect_start,
            format!(
                "diff_sheet_inspection mode={} zip_fast_path=false",
                profile_mode
            ),
        );
    }

    let base_file_path_owned = base_file_path.to_string();
    let mine_file_path_owned = mine_file_path.to_string();
    let compare_mode_owned = profile_mode.to_string();
    let base_compare_mode = compare_mode_owned.clone();
    let mine_compare_mode = compare_mode_owned.clone();
    let base_full_requested = if use_sheet_inspection {
        Some(base_full_sheet_names.clone())
    } else {
        None
    };
    let mine_full_requested = if use_sheet_inspection {
        Some(mine_full_sheet_names.clone())
    } else {
        None
    };

    if let Some(context) = base_zip_context.as_mut() {
        context.clear_sheet_scan_cache();
    }
    if let Some(context) = mine_zip_context.as_mut() {
        context.clear_sheet_scan_cache();
    }
    let base_context_for_full_parse = base_zip_context.take();
    let mine_context_for_full_parse = mine_zip_context.take();

    let base_full_handle = thread::spawn(move || match base_context_for_full_parse {
        Some(mut context) => {
            context.parse_full_sheets(&base_compare_mode, base_full_requested.as_ref())
        }
        None => parse_workbook_document(
            &base_file_path_owned,
            &base_compare_mode,
            base_full_requested.as_ref(),
        ),
    });
    let mine_full_handle = thread::spawn(move || match mine_context_for_full_parse {
        Some(mut context) => {
            context.parse_full_sheets(&mine_compare_mode, mine_full_requested.as_ref())
        }
        None => parse_workbook_document(
            &mine_file_path_owned,
            &mine_compare_mode,
            mine_full_requested.as_ref(),
        ),
    });

    let base_full_sheets = base_full_handle
        .join()
        .map_err(|_| io::Error::other("Workbook base parsing thread panicked"))??;
    let mine_full_sheets = mine_full_handle
        .join()
        .map_err(|_| io::Error::other("Workbook mine parsing thread panicked"))??;

    if !use_sheet_inspection {
        base_sheet_names = base_full_sheets
            .iter()
            .map(|sheet| sheet.name.clone())
            .collect();
        mine_sheet_names = mine_full_sheets
            .iter()
            .map(|sheet| sheet.name.clone())
            .collect();
    }

    let base_full_by_name: HashMap<String, WorkbookSheetDiffEntry> = base_full_sheets
        .into_iter()
        .map(|sheet| (sheet.name.clone(), sheet))
        .collect();
    let mine_full_by_name: HashMap<String, WorkbookSheetDiffEntry> = mine_full_sheets
        .into_iter()
        .map(|sheet| (sheet.name.clone(), sheet))
        .collect();

    profile::log_elapsed(
        total_start,
        format!(
            "prepare_workbook_comparison mode={} same_file=false",
            profile_mode
        ),
    );
    Ok(PreparedWorkbookComparison {
        base_sheet_names,
        mine_sheet_names,
        unchanged_sheet_names,
        base_equal_by_name,
        base_full_by_name,
        mine_full_by_name,
        base_workbook_metadata,
        mine_workbook_metadata,
        metadata_ms,
    })
}

pub fn compute_workbook_diff_output(
    base_file_path: &str,
    mine_file_path: &str,
    compare_mode: &str,
) -> io::Result<WorkbookDiffOutputJson> {
    let total_start = profile::start();
    let prepared = prepare_workbook_comparison(base_file_path, mine_file_path, compare_mode)?;
    let output = prepared.build_output(compare_mode);
    profile::log_elapsed(
        total_start,
        format!("compute_workbook_diff_output mode={compare_mode}"),
    );
    Ok(output)
}

pub fn compute_workbook_diff_outputs(
    base_file_path: &str,
    mine_file_path: &str,
) -> io::Result<WorkbookDiffBothOutputJson> {
    let total_start = profile::start();
    let prepared = prepare_workbook_comparison(base_file_path, mine_file_path, "both")?;
    let strict = prepared.build_output("strict");
    let content = prepared.build_output("content");
    profile::log_elapsed(total_start, "compute_workbook_diff_outputs mode=both");
    Ok(WorkbookDiffBothOutputJson { strict, content })
}

pub fn write_workbook_diff_outputs_stream<W: Write>(
    base_file_path: &str,
    mine_file_path: &str,
    primary_mode: &str,
    writer: &mut W,
) -> io::Result<()> {
    let total_start = profile::start();
    let prepared = prepare_workbook_comparison(base_file_path, mine_file_path, "stream")?;
    let alternate_mode = if primary_mode == "content" {
        "strict"
    } else {
        "content"
    };
    let primary = prepared.build_output(primary_mode);
    let serialize_start = profile::start();
    serde_json::to_writer(&mut *writer, &primary)
        .map_err(|error| io::Error::other(error.to_string()))?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    profile::log_elapsed(
        serialize_start,
        format!("serialize_workbook_diff_output mode={primary_mode}"),
    );

    // Let Electron clone and paint the primary payload before spending CPU on
    // the alternate mode. The parsed workbook remains in-process and is reused.
    thread::sleep(std::time::Duration::from_millis(STREAM_ALTERNATE_DELAY_MS));
    let alternate = prepared.build_output(alternate_mode);
    let serialize_start = profile::start();
    serde_json::to_writer(&mut *writer, &alternate)
        .map_err(|error| io::Error::other(error.to_string()))?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    profile::log_elapsed(
        serialize_start,
        format!("serialize_workbook_diff_output mode={alternate_mode}"),
    );
    profile::log_elapsed(
        total_start,
        format!("write_workbook_diff_outputs_stream primary={primary_mode}"),
    );
    Ok(())
}

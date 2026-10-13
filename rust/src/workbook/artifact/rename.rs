use super::*;

struct Stats {
    fingerprint: Vec<(u32, u32)>,
    counts: HashMap<u32, usize>,
    nonempty: usize,
    columns: u32,
}

fn stats(workbook: &StoredWorkbook, sheet: u32, mode: &str) -> Stats {
    let mut stats = Stats {
        fingerprint: Vec::new(),
        counts: HashMap::new(),
        nonempty: 0,
        columns: 0,
    };
    for &ordinal in workbook
        .sheet_rows
        .get(&sheet)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let row = &workbook.rows[ordinal];
        let (class, nonempty) = if mode == "content" {
            (row.content_class, row.content_nonempty)
        } else {
            (row.strict_class, row.strict_nonempty)
        };
        stats.fingerprint.push((row.row_number, class));
        stats.columns = stats.columns.max(row.max_columns);
        if nonempty {
            stats.nonempty += 1;
            *stats.counts.entry(class).or_default() += 1;
        }
    }
    stats
}

fn enough(a: &Stats, b: &Stats) -> bool {
    a.nonempty.max(b.nonempty) >= 2 || a.columns.max(b.columns) >= 2
}
fn apply(sheets: &[ArtifactSheet], summaries: &mut [SheetSummary], source: usize, target: usize) {
    summaries[source].change_type = "rename".to_owned();
    summaries[source].rename_role = Some("source".to_owned());
    summaries[source].rename_peer_name = Some(sheets[target].name.clone());
    summaries[target].change_type = "rename".to_owned();
    summaries[target].rename_role = Some("target".to_owned());
    summaries[target].rename_peer_name = Some(sheets[source].name.clone());
}

// Match the existing section annotations: unique exact physical-row/signature
// fingerprints first, then the same overlap/evidence thresholds and greedy order.
pub(super) fn annotate(
    sheets: &[ArtifactSheet],
    summaries: &mut [SheetSummary],
    base: &StoredWorkbook,
    mine: &StoredWorkbook,
    mode: &str,
) {
    for (sheet, summary) in sheets.iter().zip(summaries.iter_mut()) {
        summary.change_type = if sheet.has_base_side && sheet.has_mine_side {
            "equal"
        } else if sheet.has_base_side {
            "delete"
        } else {
            "add"
        }
        .to_owned();
    }
    let deleted: Vec<_> = sheets
        .iter()
        .enumerate()
        .filter(|(_, sheet)| sheet.has_base_side && !sheet.has_mine_side)
        .map(|(index, sheet)| (index, stats(base, sheet.id, mode)))
        .collect();
    let added: Vec<_> = sheets
        .iter()
        .enumerate()
        .filter(|(_, sheet)| !sheet.has_base_side && sheet.has_mine_side)
        .map(|(index, sheet)| (index, stats(mine, sheet.id, mode)))
        .collect();
    let mut used = HashSet::new();
    let mut deleted_exact = HashMap::<&[(u32, u32)], Vec<usize>>::new();
    let mut added_exact = HashMap::<&[(u32, u32)], Vec<usize>>::new();
    for (position, (_, stats)) in deleted.iter().enumerate() {
        if !stats.fingerprint.is_empty() {
            deleted_exact
                .entry(&stats.fingerprint)
                .or_default()
                .push(position);
        }
    }
    for (position, (_, stats)) in added.iter().enumerate() {
        if !stats.fingerprint.is_empty() {
            added_exact
                .entry(&stats.fingerprint)
                .or_default()
                .push(position);
        }
    }
    for (fingerprint, sources) in &deleted_exact {
        let Some(targets) = added_exact.get(fingerprint) else {
            continue;
        };
        if sources.len() != 1 || targets.len() != 1 {
            continue;
        }
        let (source, a) = &deleted[sources[0]];
        let (target, b) = &added[targets[0]];
        if enough(a, b) {
            apply(sheets, summaries, *source, *target);
            used.insert(*source);
            used.insert(*target);
        }
    }
    let mut candidates = Vec::new();
    for (source, a) in &deleted {
        if used.contains(source) {
            continue;
        }
        for (target, b) in &added {
            if used.contains(target) || !enough(a, b) {
                continue;
            }
            let overlap = a
                .counts
                .iter()
                .map(|(class, count)| (*count).min(b.counts.get(class).copied().unwrap_or(0)))
                .sum::<usize>();
            let total = a.nonempty.max(b.nonempty);
            if total == 0 {
                continue;
            }
            let coverage = overlap as f64 / total as f64;
            if coverage >= 0.85 || overlap >= 3 && coverage >= 0.6 {
                candidates.push((
                    *source,
                    *target,
                    overlap,
                    coverage,
                    summaries[*source]
                        .legacy_line_start
                        .abs_diff(summaries[*target].legacy_line_start),
                ));
            }
        }
    }
    candidates.sort_unstable_by(|a, b| {
        b.3.total_cmp(&a.3)
            .then_with(|| b.2.cmp(&a.2))
            .then_with(|| a.4.cmp(&b.4))
            .then_with(|| sheets[a.0].name.cmp(&sheets[b.0].name))
            .then_with(|| sheets[a.1].name.cmp(&sheets[b.1].name))
    });
    for (source, target, _, _, _) in candidates {
        if !used.contains(&source) && !used.contains(&target) {
            apply(sheets, summaries, source, target);
            used.insert(source);
            used.insert(target);
        }
    }
}

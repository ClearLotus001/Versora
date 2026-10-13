# Incremental decoding extension

This source is based on calamine 0.31.0, upstream commit
`348325728e671db2604a6e96beacf507edaef465`, distributed under the MIT license
in `LICENSE-MIT.md`. Versora pins this dependency by repository path and exact
version. Do not edit Cargo registry caches or silently upgrade the decoder.

The extension adds storage injection and incremental XLS/XLSB decoding while
sharing the upstream value, string, date, format and formula parsers. The
desktop artifact preparation path uses the streaming entry points exclusively.
Upstream Reader/Range APIs remain available for regression oracles, existing
calamine consumers and Versora's Text/DiffJson/DiffJsonBoth/DiffJsonStream CLI
modes. They are not a fallback in artifact ingest; this extension does not make
every CLI output mode bounded in memory.

## Added APIs

- `calamine::stream::SharedStrings`: append-only `push(String)`, owned/fallible
  `get(id)`, `len()` and `is_empty()`. The decoder owns format semantics; the
  caller owns storage, caching and cleanup. Empty strings retain their IDs.
- `XlsbStream`: `new(reader, strings)` streams SST items to initially empty
  storage without populating the standard reader's string Vec. `metadata()` and
  `sheets_metadata()` expose the existing metadata. `worksheet_cells_reader()`
  returns `XlsbStreamCellsReader` with `next_cell()`, `next_formula()` and
  `dimensions()`; values are `XlsbCellValue::Value(Data)` or `SharedStringId`.
- `XlsStream`: `new` / `new_with_options`, `metadata()`, `sheets_metadata()` and
  `read_sheet(index, strings, sink)`. `XlsSheetSink` receives value, formula and
  merge events in original record order, without constructing Range rectangles.

## Decoder and container changes

XLS uses exact `cfb = 0.15.0` for a seekable `/Workbook` or `/Book` stream. The
streaming record cursor uses a 64 KiB input buffer and one BIFF record payload;
SST CONTINUE records are consumed on demand. Globals retain necessary sheet
offsets, styles, names and date metadata, not Workbook bytes or sheet ranges.
Mini/regular streams and CFB v3/v4 are supported. The mature container reader
accepts valid v4 files rejected by the original 0.31 CFB implementation; this
additional accepted format is explicit and independently tested.

XLS shares SST, LabelSst and formula decoding with the original Reader. Repeated
SST records select a new append-store segment. BLANK, empty LabelSst and
out-of-range source LabelSst remain ignored, while actual empty LABEL/STRING
events preserve last-write behavior. A missing stored value for a valid source
ID is a storage error. Formula cached strings retain their source association;
the original XLS `Unrecognised formula ...` behavior remains.

XLSB shares SST, metadata, value and formula decoding with the original Reader.
Invalid SST IDs now produce controlled errors instead of an out-of-range panic;
short/missing declared SST records and storage failures propagate. Only actual
ZIP FileNotFound permits absent optional SST/styles members. Completed SST,
styles, workbook and worksheet value/formula readers drain their ZIP member to
EOF with an 8 KiB buffer, ensuring CRC/decompression errors cannot be hidden by
stopping at a logical BIFF terminator. Abandoning a reader early is not a
completed member validation.

## Application storage and limits

Versora's format-independent DiskStrings stores both UTF-8 data and the 12-byte
offset/length index on disk. It uses 16 KiB pages with 4 MiB data and 16 MiB index
budgets, plus a 16 MiB / 4096-entry text cache. Oversized individual strings are
returned fully and not cached. Index pages always prefetch; on a data-page miss,
nearby forward short reads prefetch a page while random/backward or at least
page-sized reads fetch only the remaining requested bytes. Cached pages are
reused in both cases. This avoids amplifying every random short-string lookup
into a full-page read without changing returned bytes. Positional reads use
Unix `read_at` or Windows `seek_read`, loop over short reads, retry Interrupted
and propagate UnexpectedEof or other I/O failures.

The XLS sink externally sorts independent
value/formula channels and source ordinals: 65536 events / 16 MiB text per run,
merge fan-in 16, and incremental leveled run compaction. It preserves last
writes, empty overwrites and observed value bounds before deduplication.

These application components are outside this dependency. Metadata, current
strings/rows, sort levels and alignment structures still scale; the complete
process is not constant-memory. Temporary strings, runs and formula files are
closed before RAII cleanup. Forced process termination relies on the enclosing
managed session cleanup rather than Rust Drop.

Changes are maintained in this source tree. Validate upstream upgrades
separately against frozen artifact output, real binary fixtures, independent
source models, CONTINUE/Unicode, formulas, duplicate coordinates and resource
cleanup. Record interface changes here before replacing the pinned baseline.

Run workspace tests, workspace formatting and strict workspace/all-targets
Clippy when modifying the extension. Fixture coverage must include Workbook/
Book, CFB mini/regular and v3/v4, BIFF5 codepages, SST character/rich/extension
CONTINUE boundaries, empty/duplicate/Unicode values, cached formula types,
invalid IDs, truncated records, damaged ZIP headers and real CRC corruption.
Compare frozen pre-extension artifacts and independent source models as well
as the shared Reader oracle. Storage tests cover mixed forward/backward,
cross-page, large, last-short-page reads and physical truncation under both
prefetch strategies. Architecture and final measurements are recorded
in [the design](../../../docs/binary-workbook-streaming-design.md) and
[the validation](../../../docs/binary-workbook-streaming-validation.md).

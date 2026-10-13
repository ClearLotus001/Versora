//! Storage contracts for incremental binary workbook decoding.
//!
//! Decoders own format semantics; storage implementations own buffering,
//! persistence and cleanup. Strings retain their original IDs and decoded text.

use std::io;

/// An append-only shared-string table with owned, fallible lookup.
///
/// Decoders append during workbook initialization and resolve only after that
/// phase completes. Implementations may keep both data and indexes on disk.
pub trait SharedStrings {
    /// Append one decoded string. Its ID is the preceding table length.
    fn push(&mut self, value: String) -> io::Result<()>;
    /// Resolve an ID without allowing callers to retain borrowed cache entries.
    fn get(&mut self, id: usize) -> io::Result<Option<String>>;
    /// Number of decoded entries, including empty strings.
    fn len(&self) -> usize;
    /// Whether the table contains no entries.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

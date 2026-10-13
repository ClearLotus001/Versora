#!/usr/bin/env python3
"""Generate and fully stream-verify deterministic, high-pressure XLSX fixtures.

Default workload: 100,000 physical rows (one header), 200 columns, and
20,000,000 non-empty inline-string cells per workbook. Only one XML row is
buffered while writing; verification uses Expat without building an XML tree.
All dependencies are in the Python standard library.

    python scripts/generate-workbook-stress.py
    python scripts/generate-workbook-stress.py --rows 251 --columns 8
    python scripts/generate-workbook-stress.py --verify-only
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from typing import Any
from xml.parsers import expat
import zipfile


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
DOCUMENT_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
SHEET_PATH = "xl/worksheets/sheet1.xml"
DEFAULT_CASES = ("base", "sparse", "dense")
CASES = (*DEFAULT_CASES, "islands")
READ_CHUNK_BYTES = 1024 * 1024


def column_label(index: int) -> str:
    result = ""
    value = index + 1
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def data_value(case: str, row: int, column: int, interval: int) -> str:
    if column == 0:
        return f"ID-{row}"
    if case == "dense" or (
        case == "sparse"
        and column == 5 and row % interval == 0
    ) or (
        case == "islands" and column % 3 == 1 and row % 3 == 1
    ):
        return f"updated-{row}-{column}"
    return f"value-{row}-{column}"


def expected_changes(case: str, rows: int, columns: int, interval: int) -> int:
    if case == "dense":
        return (rows - 1) * (columns - 1)
    if case == "sparse":
        return (rows - 1) // interval + 1
    if case == "islands":
        return ((rows + 1) // 3) * ((columns + 1) // 3)
    return 0


def package_parts() -> dict[str, str]:
    return {
        "[Content_Types].xml": XML_DECLARATION + (
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '</Types>'
        ),
        "_rels/.rels": XML_DECLARATION + (
            f'<Relationships xmlns="{PACKAGE_REL_NS}">'
            f'<Relationship Id="rId1" Type="{DOCUMENT_REL_NS}/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'
        ),
        "xl/workbook.xml": XML_DECLARATION + (
            f'<workbook xmlns="{MAIN_NS}" xmlns:r="{DOCUMENT_REL_NS}">'
            '<sheets><sheet name="Stress" sheetId="1" r:id="rId1"/></sheets>'
            '</workbook>'
        ),
        "xl/_rels/workbook.xml.rels": XML_DECLARATION + (
            f'<Relationships xmlns="{PACKAGE_REL_NS}">'
            f'<Relationship Id="rId1" Type="{DOCUMENT_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Type="{DOCUMENT_REL_NS}/styles" Target="styles.xml"/>'
            '</Relationships>'
        ),
        "xl/styles.xml": XML_DECLARATION + (
            f'<styleSheet xmlns="{MAIN_NS}">'
            '<fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            '</styleSheet>'
        ),
    }


def progress(case: str, phase: str, row: int, rows: int, started: float) -> None:
    elapsed = time.perf_counter() - started
    print(f"[{case}] {phase}: {row:,}/{rows:,} rows ({elapsed:.1f}s)", flush=True)


def generate_xlsx(path: Path, case: str, args: argparse.Namespace, labels: list[str]) -> float:
    started = time.perf_counter()
    dimension = f"A1:{labels[-1]}{args.rows}"
    with zipfile.ZipFile(
        path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=args.compression_level,
    ) as archive:
        for name, contents in package_parts().items():
            archive.writestr(name, contents.encode("utf-8"))
        with archive.open(SHEET_PATH, "w", force_zip64=True) as sheet:
            sheet.write((
                XML_DECLARATION
                + f'<worksheet xmlns="{MAIN_NS}"><dimension ref="{dimension}"/><sheetData>\n'
            ).encode("utf-8"))
            for physical_row in range(1, args.rows + 1):
                logical_row = physical_row - 1
                cells = []
                for column, label in enumerate(labels):
                    if physical_row == 1:
                        value = f"Field_{column}"
                    elif case == "sparse" and logical_row == args.rows - 1 and column == args.columns - 1:
                        value = f"updated-{logical_row}-{column}"
                    else:
                        value = data_value(case, logical_row, column, args.sparse_interval)
                    cells.append(f'<c r="{label}{physical_row}" t="inlineStr"><is><t>{value}</t></is></c>')
                sheet.write((f'<row r="{physical_row}">' + "".join(cells) + '</row>\n').encode("utf-8"))
                if physical_row % args.progress_rows == 0 or physical_row == args.rows:
                    progress(case, "generated", physical_row, args.rows, started)
            sheet.write(b'</sheetData></worksheet>')
    return time.perf_counter() - started


class WorksheetValidator:
    """Count and validate the complete worksheet using bounded SAX state."""

    def __init__(self, case: str, args: argparse.Namespace, labels: list[str]) -> None:
        self.case = case
        self.args = args
        self.labels = labels
        self.started = time.perf_counter()
        self.row = 0
        self.column = 0
        self.rows_verified = 0
        self.cells_verified = 0
        self.changes_verified = 0
        self.in_row = False
        self.in_cell = False
        self.in_text = False
        self.text_parts: list[str] = []
        self.cell_value: str | None = None
        self.dimension: str | None = None
        self.namespace_verified = False
        self.last_row_values: dict[str, str] = {}
        self.first_row_values: dict[str, str] = {}
        self.names = {key: f"{MAIN_NS}}}{key}" for key in ("worksheet", "dimension", "row", "c", "t")}

    def start(self, name: str, attributes: dict[str, str]) -> None:
        if name == self.names["row"]:
            if self.in_row or self.in_cell or attributes.get("r") != str(self.rows_verified + 1):
                raise ValueError(f"Unexpected row attributes: {attributes}")
            self.row = self.rows_verified + 1
            self.column = 0
            self.in_row = True
        elif name == self.names["c"]:
            if not self.in_row or self.in_cell or self.column >= self.args.columns:
                raise ValueError(f"Unexpected cell at row {self.row}: {attributes}")
            address = f"{self.labels[self.column]}{self.row}"
            if attributes.get("r") != address or attributes.get("t") != "inlineStr":
                raise ValueError(f"Invalid cell {address}: {attributes}")
            self.in_cell = True
            self.cell_value = None
        elif name == self.names["t"]:
            if not self.in_cell or self.in_text or self.cell_value is not None:
                raise ValueError(f"Unexpected inline text in row {self.row}")
            self.in_text = True
            self.text_parts = []
        elif name == self.names["dimension"]:
            self.dimension = attributes.get("ref")
        elif name == self.names["worksheet"]:
            self.namespace_verified = True

    def characters(self, value: str) -> None:
        if self.in_text:
            self.text_parts.append(value)

    def end(self, name: str) -> None:
        if name == self.names["t"]:
            self.cell_value = "".join(self.text_parts)
            self.text_parts = []
            self.in_text = False
        elif name == self.names["c"]:
            column = self.column
            row = self.row - 1
            if self.row == 1:
                baseline = expected = f"Field_{column}"
            elif column == 0:
                baseline = expected = f"ID-{row}"
            else:
                baseline = f"value-{row}-{column}"
                changed = self.case == "dense" or (
                    self.case == "sparse"
                    and ((column == 5 and row % self.args.sparse_interval == 0)
                         or (row == self.args.rows - 1 and column == self.args.columns - 1))
                ) or (
                    self.case == "islands" and column % 3 == 1 and row % 3 == 1
                )
                expected = f"updated-{row}-{column}" if changed else baseline
            if not self.cell_value or self.cell_value != expected:
                raise ValueError(f"Invalid value at {self.labels[column]}{self.row}: {self.cell_value!r}, expected {expected!r}")
            if self.cell_value != baseline:
                self.changes_verified += 1
            if self.row == self.args.rows:
                self.last_row_values[f"{self.labels[column]}{self.row}"] = self.cell_value
            elif self.row == 1:
                self.first_row_values[f"{self.labels[column]}1"] = self.cell_value
            self.column += 1
            self.cells_verified += 1
            self.in_cell = False
        elif name == self.names["row"]:
            if self.column != self.args.columns or self.in_cell:
                raise ValueError(f"Row {self.row} has {self.column} columns, expected {self.args.columns}")
            self.rows_verified += 1
            self.in_row = False
            if self.row % self.args.progress_rows == 0 or self.row == self.args.rows:
                progress(self.case, "verified", self.row, self.args.rows, self.started)

    def finish(self) -> dict[str, Any]:
        dimension = f"A1:{self.labels[-1]}{self.args.rows}"
        changes = expected_changes(self.case, self.args.rows, self.args.columns, self.args.sparse_interval)
        if not self.namespace_verified or self.dimension != dimension:
            raise ValueError(f"Invalid worksheet namespace or dimension: {self.dimension}")
        if self.rows_verified != self.args.rows or self.cells_verified != self.args.rows * self.args.columns:
            raise ValueError(f"Incomplete worksheet: {self.rows_verified} rows, {self.cells_verified} cells")
        if self.changes_verified != changes or self.in_row or self.in_cell or self.in_text:
            raise ValueError(f"Invalid completed worksheet: {self.changes_verified} changes, expected {changes}")
        return {
            "namespace": MAIN_NS,
            "dimension": self.dimension,
            "physical_rows": self.rows_verified,
            "data_rows": self.rows_verified - 1,
            "columns_in_every_row": self.args.columns,
            "non_empty_cells": self.cells_verified,
            "changed_cells_vs_base": self.changes_verified,
            "first_cell": "A1",
            "last_cell": f"{self.labels[-1]}{self.args.rows}",
            "header_values": self.first_row_values,
            "last_row_values": self.last_row_values,
            "tail_cells": dict(list(self.last_row_values.items())[-10:]),
            "every_cell_address_and_value_verified": True,
        }


def verify_xlsx(path: Path, case: str, args: argparse.Namespace, labels: list[str]) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    validator = WorksheetValidator(case, args, labels)
    parser = expat.ParserCreate(namespace_separator="}")
    parser.StartElementHandler = validator.start
    parser.EndElementHandler = validator.end
    parser.CharacterDataHandler = validator.characters
    parser.buffer_text = True
    with zipfile.ZipFile(path) as archive:
        expected_parts = package_parts()
        if set(archive.namelist()) != {*expected_parts, SHEET_PATH}:
            raise ValueError("Unexpected XLSX package entries")
        for name, contents in expected_parts.items():
            # Reading every entry to EOF verifies its CRC through ZipExtFile.
            if archive.read(name) != contents.encode("utf-8"):
                raise ValueError(f"Invalid package part: {name}")
        with archive.open(SHEET_PATH) as sheet:
            while chunk := sheet.read(READ_CHUNK_BYTES):
                parser.Parse(chunk, False)
            parser.Parse(b"", True)
        entries = [
            {"name": info.filename, "compressed_bytes": info.compress_size,
             "uncompressed_bytes": info.file_size, "crc32": f"{info.CRC:08x}"}
            for info in archive.infolist()
        ]
        sheet_info = archive.getinfo(SHEET_PATH)
    result = validator.finish()
    result.update({
        "crc_verified_all_entries": True,
        "zip_entries": entries,
        "zip_compressed_bytes": sum(entry["compressed_bytes"] for entry in entries),
        "zip_uncompressed_bytes": sum(entry["uncompressed_bytes"] for entry in entries),
        "worksheet_compressed_bytes": sheet_info.compress_size,
        "worksheet_uncompressed_bytes": sheet_info.file_size,
    })
    return result, time.perf_counter() - started


def write_manifest(path: Path, manifest: dict[str, Any]) -> None:
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output-dir", type=Path, default=Path("output/stress"))
    parser.add_argument("--rows", type=int, default=100_000, help="Physical rows, including the one header row")
    parser.add_argument("--columns", type=int, default=200)
    parser.add_argument("--sparse-interval", type=int, default=125)
    parser.add_argument("--compression-level", type=int, default=1, choices=range(0, 10))
    parser.add_argument("--progress-rows", type=int, default=10_000)
    parser.add_argument("--cases", nargs="+", choices=CASES, default=list(DEFAULT_CASES))
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if not 2 <= args.rows <= 1_048_576 or not 7 <= args.columns <= 16_384:
        parser.error("Use 2..1048576 physical rows and 7..16384 columns")
    if args.sparse_interval < 1 or args.progress_rows < 1:
        parser.error("Sparse interval and progress rows must be positive")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    labels = [column_label(column) for column in range(args.columns)]
    manifest_path = args.output_dir / "manifest.json"
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "generator": "scripts/generate-workbook-stress.py",
        "parameters": {"physical_rows": args.rows, "header_rows": 1, "columns": args.columns,
                       "sparse_interval": args.sparse_interval, "compression_level": args.compression_level},
        "data_specification": {"header": "Field_{column} (zero-based column)",
                               "column_0": "ID-{logical_row} (physical row minus one)",
                               "base": "value-{logical_row}-{column}",
                               "sparse": "column 5 on logical rows divisible by sparse_interval, plus the final cell",
                               "dense": "columns 1 through the final column on every data row",
                               "islands": "logical rows and non-ID columns congruent to 1 modulo 3; every changed cell is an independent eight-neighbor region",
                               "updated": "updated-{logical_row}-{column}"},
        "fixtures": [],
    }
    for case in dict.fromkeys(args.cases):
        filename = f"{case}-{args.rows}x{args.columns}.xlsx"
        path = args.output_dir / filename
        working_path = path if args.verify_only else path.with_suffix(".xlsx.tmp")
        generation_seconds = None if args.verify_only else generate_xlsx(working_path, case, args, labels)
        verification, verification_seconds = verify_xlsx(working_path, case, args, labels)
        hash_started = time.perf_counter()
        with working_path.open("rb") as fixture_file:
            sha256 = hashlib.file_digest(fixture_file, "sha256").hexdigest()
        hash_seconds = time.perf_counter() - hash_started
        if not args.verify_only:
            working_path.replace(path)
        manifest["fixtures"].append({
            "case": case, "filename": filename, "file_bytes": path.stat().st_size,
            "sha256": sha256, "generation_seconds": generation_seconds,
            "verification_seconds": verification_seconds, "hash_seconds": hash_seconds,
            **verification,
        })
        write_manifest(manifest_path, manifest)
        print(f"[{case}] READY {path.resolve()} cells={verification['non_empty_cells']:,} "
              f"changes={verification['changed_cells_vs_base']:,} bytes={path.stat().st_size:,} sha256={sha256}", flush=True)
    print(f"Manifest: {manifest_path.resolve()}", flush=True)


if __name__ == "__main__":
    main()

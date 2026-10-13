"""Generate BIFF8 boundary fixtures with an explicit independent source model.

Requires the test-only xlwt==1.3.0 dependency. xlwt writes the CFB container,
workbook globals, fonts and a genuine multi-record SST; this tool replaces only
the worksheet cell records to exercise cached formula values and event order.
The duplicate-coordinate case deliberately tests reader semantics for files
written by imperfect producers. It is separate from legal pressure workbooks.
"""

import argparse
import json
from pathlib import Path
import struct


def biff_record(kind, payload=b""):
    assert len(payload) <= 8224
    return struct.pack("<HH", kind, len(payload)) + payload


def biff_records(data, start=0):
    cursor = start
    while cursor < len(data):
        kind, length = struct.unpack_from("<HH", data, cursor)
        end = cursor + 4 + length
        assert end <= len(data)
        yield cursor, kind, data[cursor + 4:end]
        cursor = end


def number(row, column, value):
    return biff_record(0x203, struct.pack("<HHHd", row, column, 17, value))


def label(row, column, text):
    encoded = text.encode("utf-16le")
    return biff_record(0x204, struct.pack("<HHHHB", row, column, 17, len(encoded) // 2, 1) + encoded)


def formula(row, column, cache, constant=1):
    tokens = bytes((0x1E,)) + struct.pack("<H", constant)
    body = struct.pack("<HHH", row, column, 17) + cache
    body += struct.pack("<HIH", 0, 0, len(tokens)) + tokens
    return biff_record(6, body)


def special_cache(kind, value=0):
    return bytes((kind, 0, value, 0, 0, 0, 255, 255))


def formula_string(text):
    encoded = text.encode("utf-16le")
    return biff_record(0x207, struct.pack("<HB", len(encoded) // 2, 1) + encoded)


def create_fixture(path, expected_path):
    import xlwt
    from xlwt.CompoundDoc import XlsDoc

    ascii_text = "ascii-123/" * 1100
    multilingual = "多语言日本語한국어é" * 1300
    rich_text = "富文rich" * 1200
    workbook = xlwt.Workbook()
    sheet = workbook.add_sheet("Boundaries")
    sheet.write(0, 0, ascii_text)
    sheet.write(0, 1, multilingual)
    bold = xlwt.Font()
    bold.bold = True
    italic = xlwt.Font()
    italic.italic = True
    # 2,400 formatting runs take 9,600 bytes: the rich-string run array
    # crosses CONTINUE independently of its UTF-16 character array.
    sheet.write_rich_text(0, 2, [(text, font) for _ in range(1200)
                              for text, font in (("富文", bold), ("rich", italic))])
    empty_sst = workbook.add_str("")
    sheet.write(7, 7, 808)
    data = workbook.get_biff_data()
    globals_records = list(biff_records(data))
    boundsheet = next(payload for _, kind, payload in globals_records if kind == 0x85)
    sheet_start = struct.unpack_from("<I", boundsheet)[0]
    assert sum(kind == 0x85 for _, kind, _ in globals_records) == 1
    sst_references = {}
    for _, kind, payload in biff_records(data, sheet_start):
        if kind == 0xFD:
            row, column = struct.unpack_from("<HH", payload)
            sst_references[(row, column)] = struct.unpack_from("<I", payload, 6)[0]
    continuations = sum(kind == 0x3C for offset, kind, _ in globals_records if offset < sheet_start)
    assert continuations >= 6, "Fixture must span several genuine SST CONTINUE records"

    # Start late and return to earlier rows. Value events and formula events
    # independently use their last occurrence at a coordinate.
    events = [number(7, 7, 808), number(2, 0, 111), number(2, 1, 222),
              number(1, 3, 999), number(2, 3, 999), number(3, 3, 10)]
    for column in range(3):
        events.append(biff_record(0xFD, struct.pack("<HHHI", 0, column, 17, sst_references[(0, column)])))
    events += [number(0, 3, 123), biff_record(0xFD, struct.pack("<HHHI", 0, 3, 17, empty_sst)),
               formula(1, 0, special_cache(0)), formula_string("缓存结果\r\nTab\t分隔\x1f"),
               formula(1, 1, special_cache(2, 7)), formula(1, 2, special_cache(1, 1)),
               formula(1, 3, special_cache(3)),
               biff_record(0x201, struct.pack("<HHH", 2, 0, 17)),
               label(2, 1, ""),
               formula(2, 2, struct.pack("<d", 333)),
               formula(2, 2, struct.pack("<d", 444), 2),
               formula(2, 3, special_cache(0)), formula_string(""),
               biff_record(0x205, struct.pack("<HHHBB", 3, 0, 17, 0, 0)),
               biff_record(0x205, struct.pack("<HHHBB", 3, 1, 17, 42, 1)),
               label(3, 2, "line1\rline2\nline3\r\n\tend\x1f"), number(3, 3, 20)]
    float_cases = [(128.0, "128"), (4294967296.0, "4294967296"),
                   (1e-12, "0.000000000001"), (1e128, "9223372036854775807"),
                   (-1e128, "-9223372036854775808"), (1.0 / 3.0, "0.3333333333333333")]
    for column, (value, _) in enumerate(float_cases):
        events.append(number(4, column, value))

    # Keep xlwt's worksheet metadata. No INDEX/DBCELL records are emitted by
    # this writer, so replacing the cell stream needs no internal offset fix.
    cell_kinds = {6, 0x203, 0x204, 0x205, 0x207, 0x27E, 0xFD, 0xBD, 0xBE, 0x201}
    replaced_sheet = bytearray()
    inserted = False
    for _, kind, payload in biff_records(data, sheet_start):
        assert kind not in (0x20B, 0xD7), "Unexpected worksheet index offsets"
        if kind in cell_kinds:
            if not inserted:
                replaced_sheet.extend(b"".join(events))
                inserted = True
            continue
        replaced_sheet.extend(biff_record(kind, payload))
    assert inserted
    path.parent.mkdir(parents=True, exist_ok=True)
    XlsDoc().save(str(path), data[:sheet_start] + replaced_sheet)

    def cell(row, column, value, formula_text=""):
        return {"row": row + 1, "column": column, "value": value, "formula": formula_text}

    cells = [cell(0, 0, ascii_text), cell(0, 1, multilingual), cell(0, 2, rich_text),
             cell(0, 3, "123"), cell(1, 0, "缓存结果 / Tab    分隔 ", "=1"),
             cell(1, 1, "##DIV/0!", "=1"), cell(1, 2, "TRUE", "=1"),
             cell(1, 3, "", "=1"), cell(2, 0, "111"), cell(2, 2, "444", "=2"),
             cell(2, 3, "", "=1"), cell(3, 0, "FALSE"), cell(3, 1, "##N/A"),
             cell(3, 2, "line1 / line2 / line3 /     end "), cell(3, 3, "20"), cell(7, 7, "808")]
    cells += [cell(4, column, value) for column, (_, value) in enumerate(float_cases)]
    cells.sort(key=lambda value: (value["row"], value["column"]))
    model = {"kind": "versora-binary-edge-source-v1", "format": "xls",
             "sheets": [{"name": "Boundaries", "firstRow": 1, "lastRow": 8, "maxColumns": 8, "cells": cells}]}
    expected_path.parent.mkdir(parents=True, exist_ok=True)
    expected_path.write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"path": str(path.resolve()), "expectedSource": str(expected_path.resolve()),
            "bytes": path.stat().st_size, "sstContinueRecords": continuations,
            "expectedCellsPerSide": len(cells)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--expected-source", type=Path, required=True)
    options = parser.parse_args()
    if options.output.resolve() == options.expected_source.resolve():
        parser.error("Expected model must be separate from workbook")
    print(json.dumps(create_fixture(options.output, options.expected_source)))


if __name__ == "__main__":
    main()

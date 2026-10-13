"""Generate reproducible XLS/XLSB inputs for native memory benchmarks.

XLS uses the optional test-only dependency xlwt==1.3.0. XLSB replaces the
first sheet of the checked-in calamine fixture with sequential BIFF12
records, without retaining the worksheet or shared-string table in memory.
Every shared-string entry is distinct and referenced at least once. Smaller
tables naturally produce repeated references; no stale SST counts are written.
"""

import argparse
import json
import math
from pathlib import Path
import struct
import shutil
import zipfile
import xml.etree.ElementTree as ET


def record(kind, payload=b""):
    header = bytearray()
    if kind < 128:
        header.append(kind)
    else:
        header.extend(((kind & 127) | 128, kind >> 7))
    size = len(payload)
    while size >= 128:
        header.append((size & 127) | 128)
        size >>= 7
    header.append(size)
    return bytes(header) + payload


def shared_string(index, length):
    return f"sst-{index:010d}-".ljust(length, "x")


def shared_string_permutation(count, order):
    """An affine bijection creates distant SST lookups without a table in RAM."""
    if order == "sequential" or count <= 1:
        return 1, 0
    multiplier = 2654435761 % count
    while math.gcd(multiplier, count) != 1:
        multiplier += 1
    return multiplier, 104729 % count


def xlsb_template_sheet_name(template):
    """Read the template's one BrtBundleSh name without an Excel library."""
    with zipfile.ZipFile(template) as source:
        if "xl/worksheets/sheet1.bin" not in source.namelist():
            raise ValueError("XLSB template must use xl/worksheets/sheet1.bin")
        data = source.read("xl/workbook.bin")
    cursor = 0
    names = []
    while cursor < len(data):
        kind = data[cursor] & 127
        if data[cursor] & 128:
            cursor += 1
            kind |= data[cursor] << 7
        cursor += 1
        length = 0
        for shift in range(0, 28, 7):
            byte = data[cursor]
            cursor += 1
            length |= (byte & 127) << shift
            if byte < 128:
                break
        else:
            raise ValueError("Invalid XLSB template record length")
        end = cursor + length
        if end > len(data):
            raise ValueError("Truncated XLSB template record")
        if kind == 0x9C:
            relationship_length = struct.unpack_from("<I", data, cursor + 8)[0]
            if relationship_length == 0xFFFFFFFF:
                raise ValueError("XLSB template sheet must have a worksheet relationship")
            offset = cursor + 12 + relationship_length * 2
            characters = struct.unpack_from("<I", data, offset)[0]
            names.append(data[offset + 4:offset + 4 + characters * 2].decode("utf-16le"))
        cursor = end
    if len(names) != 1:
        raise ValueError("XLSB template must contain exactly one worksheet")
    return names[0]


def add_shared_string_part(xml, relationship=False):
    namespace = (
        "http://schemas.openxmlformats.org/package/2006/relationships"
        if relationship else
        "http://schemas.openxmlformats.org/package/2006/content-types"
    )
    ET.register_namespace("", namespace)
    root = ET.fromstring(xml)
    if relationship:
        kind = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"
        for entry in root:
            if entry.get("Type") == kind:
                entry.set("Target", "sharedStrings.bin")
                break
        else:
            identifiers = {entry.get("Id") for entry in root}
            identifier = "rIdStressSst"
            while identifier in identifiers:
                identifier += "x"
            ET.SubElement(root, f"{{{namespace}}}Relationship", {
                "Id": identifier, "Type": kind, "Target": "sharedStrings.bin",
            })
    else:
        part = "/xl/sharedStrings.bin"
        for entry in root:
            if entry.get("PartName") == part:
                break
        else:
            ET.SubElement(root, f"{{{namespace}}}Override", {
                "PartName": part, "ContentType": "application/vnd.ms-excel.sharedStrings",
            })
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def write_xlsb(path, rows, columns, template, shared_strings=0, string_length=128, permutation=(1, 0)):
    with zipfile.ZipFile(template) as source:
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as target:
            for entry in source.infolist():
                if shared_strings and entry.filename == "xl/sharedStrings.bin":
                    continue
                if shared_strings and entry.filename in ("[Content_Types].xml", "xl/_rels/workbook.bin.rels"):
                    target.writestr(entry, add_shared_string_part(
                        source.read(entry), entry.filename != "[Content_Types].xml",
                    ))
                    continue
                if entry.filename != "xl/worksheets/sheet1.bin":
                    with source.open(entry) as original, target.open(entry.filename, "w") as copy:
                        shutil.copyfileobj(original, copy)
                    continue
                with target.open(entry.filename, "w", force_zip64=True) as sheet:
                    sheet.write(record(0x81))
                    sheet.write(record(0x94, struct.pack("<IIII", 0, rows - 1, 0, columns - 1)))
                    sheet.write(record(0x91))
                    for row in range(rows):
                        buffer = bytearray(record(0, struct.pack("<I", row) + bytes(21)))
                        for column in range(columns):
                            value = row * columns + column
                            if (row, column) in ((0, 0), (rows - 1, columns - 1)):
                                # BrtFmlaNum, cached numeric value and constant 1 token.
                                body = struct.pack("<IId", column, 0, value)
                                body += bytes(2) + struct.pack("<I", 3) + bytes((0x1E, 1, 0))
                                body += struct.pack("<I", 0)
                                buffer.extend(record(9, body))
                            elif shared_strings:
                                # BrtCellIsst: Cell header and zero-based SST index.
                                index = ((value - 1) * permutation[0] + permutation[1]) % shared_strings
                                buffer.extend(record(7, struct.pack("<III", column, 0, index)))
                            else:
                                body = struct.pack("<IId", column, 0, value)
                                buffer.extend(record(5, body))
                        sheet.write(buffer)
                    sheet.write(record(0x92))
                    sheet.write(record(0x82))
            if shared_strings:
                references = rows * columns - (2 if rows * columns > 1 else 1)
                with target.open("xl/sharedStrings.bin", "w", force_zip64=True) as strings:
                    strings.write(record(0x9F, struct.pack("<II", references, shared_strings)))
                    for index in range(shared_strings):
                        text = shared_string(index, string_length).encode("utf-16le")
                        strings.write(record(0x13, bytes(1) + struct.pack("<I", string_length) + text))
                    strings.write(record(0xA0))


def write_xls(path, rows, columns, sheets=1):
    import xlwt

    if rows > 65536 or columns > 256:
        raise ValueError("BIFF8 XLS supports at most 65536 rows and 256 columns")
    workbook = xlwt.Workbook()
    for sheet_index in range(sheets):
        name = "Stress" if sheets == 1 else f"Stress{sheet_index + 1}"
        sheet = workbook.add_sheet(name)
        for row in range(rows):
            for column in range(columns):
                if (row, column) in ((0, 0), (rows - 1, columns - 1)):
                    sheet.write(row, column, xlwt.Formula("1"))
                else:
                    sheet.write(row, column, (sheet_index * rows + row) * columns + column)
            # Rows already serialized to BIFF can be discarded by the writer.
            if row % 512 == 511:
                sheet.flush_row_data()
    workbook.save(str(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=("xls", "xlsb"), required=True)
    parser.add_argument("--rows", type=int, default=10000)
    parser.add_argument("--columns", type=int, default=200)
    parser.add_argument("--sheets", type=int, default=1, help="Number of sequential XLS worksheets")
    parser.add_argument("--shared-strings", type=int, default=0, help="Distinct XLSB SST entries, all referenced; 0 writes numeric cells")
    parser.add_argument("--shared-string-order", choices=("sequential", "permuted"), default="sequential", help="Deterministic SST reference order; both orders reference every entry")
    parser.add_argument("--string-length", type=int, default=128, help="Exact character count per distinct XLSB SST entry")
    parser.add_argument("--expected-source", type=Path, help="Write a compact independent source-oracle model")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--xlsb-template", type=Path,
        default=Path(__file__).resolve().parents[1] / "tests/fixtures/binary/date.xlsb",
    )
    options = parser.parse_args()
    if not 1 <= options.rows <= 1048576 or not 1 <= options.columns <= 16384:
        parser.error("Dimensions must fit a complete Excel worksheet")
    if not 1 <= options.sheets <= 65535:
        parser.error("Sheet count must be between 1 and 65535")
    cells_per_sheet = options.rows * options.columns
    formulas_per_sheet = 2 if cells_per_sheet > 1 else 1
    references = cells_per_sheet - formulas_per_sheet
    if not 0 <= options.shared_strings <= references:
        parser.error("Every distinct SST entry must be referenced by a non-formula cell")
    if not 15 <= options.string_length <= 32767:
        parser.error("SST string length must be between 15 and 32767 characters")
    if options.format == "xls" and options.shared_strings:
        parser.error("Shared-string generation is only supported for XLSB")
    if options.shared_string_order != "sequential" and not options.shared_strings:
        parser.error("Permuted references require an XLSB shared-string table")
    if options.format == "xls" and (options.rows > 65536 or options.columns > 256):
        parser.error("BIFF8 XLS supports at most 65536 rows and 256 columns")
    if options.format == "xlsb" and options.sheets != 1:
        parser.error("The XLSB template generator supports one worksheet")
    if options.shared_strings and max(references, options.shared_strings) > 0x7FFFFFFF:
        parser.error("XLSB SST counts must fit signed 31-bit format limits")
    if options.format == "xlsb" and options.output.resolve() == options.xlsb_template.resolve():
        parser.error("Output must be separate from the XLSB template")
    if options.expected_source and options.expected_source.resolve() == options.output.resolve():
        parser.error("Expected-source model must be separate from the workbook")
    options.output.parent.mkdir(parents=True, exist_ok=True)
    permutation = shared_string_permutation(options.shared_strings, options.shared_string_order)
    if options.format == "xlsb":
        sheet_names = [xlsb_template_sheet_name(options.xlsb_template)]
        write_xlsb(options.output, options.rows, options.columns, options.xlsb_template, options.shared_strings, options.string_length, permutation)
    else:
        sheet_names = ["Stress" if options.sheets == 1 else f"Stress{index + 1}" for index in range(options.sheets)]
        write_xls(options.output, options.rows, options.columns, options.sheets)
    result = {
        "path": str(options.output.resolve()),
        "format": options.format,
        "rows": options.rows,
        "columns": options.columns,
        "sheets": options.sheets,
        "cellCount": cells_per_sheet * options.sheets,
        "bytes": options.output.stat().st_size,
        "formulas": formulas_per_sheet * options.sheets,
        "sharedStrings": options.shared_strings,
        "sharedStringReferences": references if options.shared_strings else 0,
        "sharedStringOrder": options.shared_string_order,
        "stringLength": options.string_length if options.shared_strings else 0,
    }
    if options.expected_source:
        model = {
            "kind": "versora-binary-stress-source-v1",
            "format": options.format, "rows": options.rows, "columns": options.columns,
            "sheetNames": sheet_names,
            "sharedStrings": options.shared_strings,
            "stringLength": options.string_length if options.shared_strings else 0,
            "sstPermutation": {"multiplier": permutation[0], "offset": permutation[1]},
        }
        options.expected_source.parent.mkdir(parents=True, exist_ok=True)
        options.expected_source.write_text(json.dumps(model, indent=2), encoding="utf-8")
        result["expectedSource"] = str(options.expected_source.resolve())
    print(json.dumps(result))


if __name__ == "__main__":
    main()

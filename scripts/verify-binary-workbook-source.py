"""Verify generated XLS/XLSB artifact values independently of parser hashes."""

import argparse
import json
from pathlib import Path
import struct
import time

def verify_generated_source(directory, expected_source):
    """Decode every artifact cell against a compact, independent source model.

    No calamine code, parser output or before/after hashes define expected values.
    """
    started = time.perf_counter()
    model = json.loads(expected_source.read_text(encoding="utf-8"))
    if model["kind"] == "versora-binary-edge-source-v1":
        return verify_edge_source(directory, model, expected_source, started)
    assert model["kind"] == "versora-binary-stress-source-v1"
    assert model["format"] in ("xls", "xlsb")
    rows, columns = model["rows"], model["columns"]
    names = model["sheetNames"]
    shared_strings = model["sharedStrings"]
    string_length = model["stringLength"]
    permutation = model.get("sstPermutation", {"multiplier": 1, "offset": 0})
    assert rows > 0 and columns > 0 and names
    total_rows = rows * len(names)
    cells_per_sheet = rows * columns
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["complete"] is True
    assert [(sheet["id"], sheet["name"]) for sheet in manifest["sheets"]] == list(enumerate(names))
    checked = 0
    for side in ("base", "mine"):
        assert manifest[side]["rowCount"] == total_rows
        assert manifest[side]["physicalRows"] == total_rows
        assert manifest[side]["maxColumns"] == columns
        assert manifest[side]["cellCount"] == total_rows * columns
        for name in names:
            metadata = manifest[f"{side}Metadata"]["s"][name]
            assert metadata["r"] == rows and metadata["c"] == columns
        with (directory / f"{side}.rows.idx").open("rb") as index:
            with (directory / f"{side}.rows.bin").open("rb") as data:
                assert index.read(8) == b"VWRIDX01"
                assert struct.unpack("<Q", index.read(8))[0] == total_rows
                assert data.read(8) == b"VWRROW01"
                next_offset = 8
                for ordinal in range(total_rows):
                    sheet_index, row = divmod(ordinal, rows)
                    sheet, number, offset, length, maximum = struct.unpack("<IIQII", index.read(24))
                    assert (sheet, number, offset, maximum) == (sheet_index, row + 1, next_offset, columns)
                    data.seek(offset)
                    record = data.read(length)
                    assert struct.unpack_from("<II", record) == (row + 1, columns)
                    cursor = 8
                    for column in range(columns):
                        actual_column, value_length, formula_length = struct.unpack_from("<III", record, cursor)
                        cursor += 12
                        value = record[cursor:cursor + value_length]
                        cursor += value_length
                        formula = record[cursor:cursor + formula_length]
                        cursor += formula_length
                        position = row * columns + column
                        is_formula = position in (0, cells_per_sheet - 1)
                        expected_formula = b"=1" if is_formula else b""
                        if is_formula and model["format"] == "xls":
                            # xlwt writes formula 1 with an empty cached value.
                            expected_value = b""
                        elif shared_strings and not is_formula:
                            identifier = ((position - 1) * permutation["multiplier"] + permutation["offset"]) % shared_strings
                            stem = "sst-" + str(identifier).zfill(10) + "-"
                            expected_value = (stem + "x" * (string_length - len(stem))).encode("ascii")
                        else:
                            expected_value = str(sheet_index * cells_per_sheet + position).encode("ascii")
                        assert actual_column == column
                        assert value == expected_value, (side, names[sheet_index], row + 1, column, value, expected_value)
                        assert formula == expected_formula, (side, names[sheet_index], row + 1, column, formula)
                        checked += 1
                    assert cursor == length
                    next_offset = offset + length
                assert not index.read(1)
                assert not data.read(1)
        assert not (directory / f"{side}.formulas.bin").exists()
    for mode in ("strict", "content"):
        assert manifest["modes"][mode]["pairCount"] == total_rows
        assert manifest["modes"][mode]["changedCellCount"] == 0
        assert manifest["modes"][mode]["regionCount"] == 0
        assert len(manifest["modes"][mode]["sheets"]) == len(names)
    return {"checkedCells": checked, "rowsPerSide": total_rows, "columns": columns,
            "sheetCount": len(names), "sharedStrings": shared_strings,
            "expectedSource": str(expected_source.resolve()),
            "elapsedSeconds": time.perf_counter() - started, "allCoordinatesValuesFormulasMatch": True}


def verify_edge_source(directory, model, expected_source, started):
    """Check sparse boundary fixtures against explicit source values, not hashes."""
    sheets = model["sheets"]
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["complete"] is True
    assert [(sheet["id"], sheet["name"]) for sheet in manifest["sheets"]] == [
        (index, sheet["name"]) for index, sheet in enumerate(sheets)
    ]
    total_rows = sum(sheet["lastRow"] - sheet["firstRow"] + 1 for sheet in sheets)
    expected = []
    for sheet_index, sheet in enumerate(sheets):
        cells_by_row = {}
        for cell in sheet["cells"]:
            assert cell["value"] or cell["formula"]
            cells_by_row.setdefault(cell["row"], {})[cell["column"]] = (cell["value"], cell["formula"])
        for row in range(sheet["firstRow"], sheet["lastRow"] + 1):
            expected.append((sheet_index, row, cells_by_row.get(row, {})))
    cell_count = sum(len(cells) for _, _, cells in expected)
    checked = 0
    for side in ("base", "mine"):
        assert manifest[side]["rowCount"] == total_rows
        assert manifest[side]["physicalRows"] == sum(sheet["lastRow"] for sheet in sheets)
        assert manifest[side]["cellCount"] == cell_count
        assert manifest[side]["maxColumns"] == max(sheet["maxColumns"] for sheet in sheets)
        for sheet in sheets:
            metadata = manifest[f"{side}Metadata"]["s"][sheet["name"]]
            assert metadata["r"] == sheet["lastRow"]
            assert metadata["c"] == sheet["maxColumns"]
        with (directory / f"{side}.rows.idx").open("rb") as index, (directory / f"{side}.rows.bin").open("rb") as data:
            assert index.read(8) == b"VWRIDX01"
            assert struct.unpack("<Q", index.read(8))[0] == total_rows
            assert data.read(8) == b"VWRROW01"
            next_offset = 8
            for expected_sheet, expected_row, cells in expected:
                sheet, number, offset, length, maximum = struct.unpack("<IIQII", index.read(24))
                assert (sheet, number, offset, maximum) == (
                    expected_sheet, expected_row, next_offset, max(cells, default=-1) + 1,
                )
                data.seek(offset)
                record = data.read(length)
                number, count = struct.unpack_from("<II", record)
                assert number == expected_row and count == len(cells)
                cursor = 8
                actual = {}
                for _ in range(count):
                    column, value_length, formula_length = struct.unpack_from("<III", record, cursor)
                    cursor += 12
                    value = record[cursor:cursor + value_length].decode("utf-8")
                    cursor += value_length
                    formula = record[cursor:cursor + formula_length].decode("utf-8")
                    cursor += formula_length
                    assert column not in actual
                    actual[column] = (value, formula)
                    checked += 1
                assert actual == cells, (side, expected_sheet, expected_row, actual, cells)
                assert cursor == length
                next_offset += length
            assert not index.read(1) and not data.read(1)
        assert not (directory / f"{side}.formulas.bin").exists()
    for mode in ("strict", "content"):
        assert manifest["modes"][mode]["pairCount"] == total_rows
        assert manifest["modes"][mode]["changedCellCount"] == 0
        assert manifest["modes"][mode]["regionCount"] == 0
    return {"checkedCells": checked, "rowsPerSide": total_rows, "sheetCount": len(sheets),
            "expectedSource": str(expected_source.resolve()),
            "elapsedSeconds": time.perf_counter() - started, "allCoordinatesValuesFormulasMatch": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--expected-source", type=Path, required=True)
    options = parser.parse_args()
    print(json.dumps(verify_generated_source(options.artifact.resolve(), options.expected_source), indent=2))


if __name__ == "__main__":
    main()

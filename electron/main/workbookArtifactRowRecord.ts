/** Shared canonical row validation; consumers decode only the fields they need. */
export function visitWorkbookArtifactRow(
  buffer: Buffer,
  visitor: (column: number, valueOffset: number, valueLength: number, formulaOffset: number, formulaLength: number) => void,
  expectedPhysicalRow?: number,
): void {
  if (buffer.length < 8) throw new Error('Truncated workbook source row header.');
  if (expectedPhysicalRow != null && buffer.readUInt32LE(0) !== expectedPhysicalRow) throw new Error('Invalid workbook source row number.');
  const count = buffer.readUInt32LE(4);
  let cursor = 8;
  let lastColumn = -1;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 12 > buffer.length) throw new Error('Truncated workbook cell header.');
    const column = buffer.readUInt32LE(cursor);
    const valueLength = buffer.readUInt32LE(cursor + 4);
    const formulaLength = buffer.readUInt32LE(cursor + 8);
    cursor += 12;
    const end = cursor + valueLength + formulaLength;
    if (end > buffer.length || column <= lastColumn) throw new Error('Invalid workbook cell record.');
    lastColumn = column;
    visitor(column, cursor, valueLength, cursor + valueLength, formulaLength);
    cursor = end;
  }
  if (cursor !== buffer.length) throw new Error('Invalid workbook row length.');
}

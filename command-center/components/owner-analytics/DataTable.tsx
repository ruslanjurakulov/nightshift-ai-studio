import type { Cell, Table } from "@/lib/owner-analytics/export";

/**
 * A table from the same Table object the export writes, so screen and file agree. A null cell reads `unknownText`, never 0.
 * Row ids (`{id}-{first cell}`) are the drill-down targets of the chart above the table.
 */
export function DataTable({
  table,
  id,
  unknownText,
  format,
  limit,
  showingText,
}: {
  table: Table;
  id: string;
  unknownText: string;
  /** Per column: how to print a number in it. Columns without one print the number as is. */
  format?: Array<((n: number) => string) | undefined>;
  limit?: number;
  showingText?: (n: number, total: number) => string;
}) {
  const rows = limit ? table.rows.slice(0, limit) : table.rows;
  const cell = (v: Cell, i: number) => {
    if (v === null) return <span className="oa-dim">{unknownText}</span>;
    if (typeof v === "number") return format?.[i] ? format[i]!(v) : String(v);
    return v;
  };
  return (
    <div className="oa-table-wrap">
      <table id={id}>
        <thead>
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} scope="col" className={i > 0 ? "oa-num" : undefined}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} id={`${id}-${String(r[0])}`}>
              {r.map((v, i) =>
                i === 0 ? (
                  <th key={i} scope="row">
                    {cell(v, i)}
                  </th>
                ) : (
                  <td key={i} className={typeof v === "number" || v === null ? "oa-num" : undefined}>
                    {cell(v, i)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {limit && table.rows.length > limit && showingText && <p className="oa-note">{showingText(limit, table.rows.length)}</p>}
    </div>
  );
}

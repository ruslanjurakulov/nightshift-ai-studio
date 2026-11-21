import type { ReactNode } from "react";

/**
 * A ruled list for dense data (insight and operations pages).
 *
 * On a desktop it is a table: a hairline under its head, a hairline between
 * rows. On a phone every row becomes a small stack: the first column is the
 * row's title, the others follow as `label  value` lines. It is the same markup
 * both ways, so no value is hidden and explicit roles keep the table semantics
 * when CSS changes the layout.
 *
 * Presentation only: it draws what the page hands it. A value the page does not
 * know is the page's to word (N/A, unpriced, a dash); this never turns an empty
 * cell into a 0.
 */
export interface DataColumn<T> {
  key: string;
  /** The column's name: the head cell on desktop, the line label on a phone. */
  label: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: "start" | "end";
  /** Keep the cell on one line on desktop (a time, a figure). */
  nowrap?: boolean;
}

export function DataList<T>({
  columns,
  rows,
  rowKey,
  caption,
}: {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Names the table for assistive tech; not drawn. */
  caption: string;
}) {
  return (
    <div className="g4-table-wrap">
      <table className="g4-table" role="table">
        <caption className="sr-only">{caption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c) => (
              <th key={c.key} scope="col" role="columnheader" data-align={c.align === "end" ? "end" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)} role="row">
              {columns.map((c, ci) => (
                <td
                  key={c.key}
                  role="cell"
                  data-title={ci === 0 ? "" : undefined}
                  data-align={c.align === "end" ? "end" : undefined}
                  data-nowrap={c.nowrap ? "" : undefined}
                >
                  {ci > 0 && (
                    <span className="g4-cell-label" aria-hidden>
                      {c.label}
                    </span>
                  )}
                  <span className="g4-cell-value">{c.render(row, i)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

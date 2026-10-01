/**
 * A section's slug: the engraved label that heads a section, followed by a
 * hairline to the edge — how a rundown sheet names its blocks. Not a heading
 * (the section's h2 is); a plain label above it.
 */
export function Slug({ children }: { children: React.ReactNode }) {
  return <p className="st-slug">{children}</p>;
}

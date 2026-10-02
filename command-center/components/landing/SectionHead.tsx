import { Slug } from "@/components/site/Slug";

/** Slug, H2 and optional lead — the head a public section opens with. The
 *  `hour` of the older night-hours eyebrow is accepted and no longer drawn. */
export function SectionHead({
  eyebrow,
  title,
  lead,
  id,
  className,
}: {
  hour?: string;
  eyebrow: string;
  title: string;
  lead?: string;
  id: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Slug>{eyebrow}</Slug>
      <h2 id={id} className="st-h2 mt-8">
        {title}
      </h2>
      {lead && <p className="st-lead mt-6">{lead}</p>}
    </div>
  );
}

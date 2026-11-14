"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useShell } from "@/components/shell/ShellContext";
import { ICONS } from "@/components/navigation/navIcons";
import { DESK_ICONS } from "@/components/studio/deskIcons";
import { DESKS, deskHref } from "@/lib/creative/desks";
import { deskOpen } from "@/lib/tool-availability";
import { studioTilesFor, type StudioTile } from "@/lib/navigation";
import { LayoutTemplate } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import "./studio-hub.css";

function tileName(tile: StudioTile, t: Dictionary): string {
  return tile.key === "presets" ? t.presets.title : t.nav[tile.key];
}

/**
 * Studio home's way into every tool: one tile per housed screen, each a plain link to the page that
 * does the job today (lib/studioRoutes.ts). The Create tile carries the desks it used to list in the
 * sidebar; a desk with nothing on sale says so and is not a link, exactly as the sidebar row did.
 *
 * Links only: a tile fills nothing and starts nothing, so no tile names a price (CLAUDE.md rule 3).
 * The tiles a viewer may not open (an operator-only screen, a section whose switch is off) are left
 * out rather than drawn disabled: the page behind them would answer 404 or send them home.
 */
export function StudioTiles() {
  const { t, fmt } = useI18n();
  const path = useChannelPath();
  const { operator, features, tools } = useShell();
  const tiles = studioTilesFor(operator, features);
  const groups: { id: StudioTile["group"]; title: string }[] = [
    { id: "make", title: t.studioHub.makeTitle },
    { id: "channel", title: t.studioHub.channelTitle },
  ];
  return (
    <section aria-labelledby="studio-tools" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="studio-tools" className="m-0 text-lg font-semibold text-[var(--color-fg)]">
          {t.studioHub.toolsTitle}
        </h2>
        <p className="m-0 max-w-[70ch] text-sm text-[var(--color-muted)]">{t.studioHub.toolsLead}</p>
      </div>
      {groups.map((g) => {
        const list = tiles.filter((tile) => tile.group === g.id);
        if (list.length === 0) return null;
        return (
          <div key={g.id} className="flex flex-col gap-2">
            {/* One heading only when there are two groups (a customer): the operator's list is all "make". */}
            {tiles.some((x) => x.group !== g.id) && <h3 className="studio-tiles-group">{g.title}</h3>}
            <ul className="studio-tiles" data-testid={`studio-tiles-${g.id}`}>
              {list.map((tile) => {
                const Icon = tile.key === "presets" ? LayoutTemplate : ICONS[tile.key];
                const name = tileName(tile, t);
                return (
                  <li key={tile.href} className="studio-tile">
                    <Link href={path(tile.href)} className="studio-tile-link" data-studio-tile={tile.key}>
                      <span aria-hidden className="studio-tile-icon">
                        <Icon className="size-[18px]" strokeWidth={1.9} />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="studio-tile-name">{name}</span>
                        <span className="studio-tile-desc">{t.studioHub.tiles[tile.key]}</span>
                      </span>
                    </Link>
                    {tile.key === "create" && (
                      <ul className="studio-desks" aria-label={name}>
                        {DESKS.filter((d) => d !== "overview").map((d) => {
                          const DeskIcon = DESK_ICONS[d];
                          const label = t.desk.names[d];
                          if (!deskOpen(tools, d)) {
                            return (
                              <li key={d}>
                                <span className="studio-desk" data-unavailable="true" title={fmt(t.availability.rowLabel, { name: label })} data-testid={`studio-desk-${d}`}>
                                  <DeskIcon aria-hidden className="size-3.5" strokeWidth={2} />
                                  <span>{label}</span>
                                  <span className="studio-desk-soon">{t.availability.notYet}</span>
                                </span>
                              </li>
                            );
                          }
                          return (
                            <li key={d}>
                              <Link href={path(deskHref(d))} className="studio-desk" data-testid={`studio-desk-${d}`}>
                                <DeskIcon aria-hidden className="size-3.5" strokeWidth={2} />
                                <span>{label}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

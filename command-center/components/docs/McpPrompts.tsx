import { ArrowUpRight } from "lucide-react";
import { claudeDesktopPromptLink } from "@/lib/dev/mcp-clients";
import { mcpConnectOffered } from "@/lib/dev/mcp-availability";
import { PROMPT_GALLERY, promptDoor } from "@/lib/dev/mcp-prompts";
import type { DevDictionary } from "@/lib/i18n/dev";
import { CopyButton } from "@/components/docs/CopyButton";
import "@/components/docs/mcp-prompts.css";

/**
 * /mcp's prompt gallery: eight things to paste into an assistant, each card naming the tools it uses and which
 * connection can run it (lib/dev/mcp-prompts.ts derives that from what a sign-in is offered). One "Copy prompt" button
 * per card, always.
 *
 * "Open in Claude" is drawn only where two facts allow it: the link format is documented (Claude Desktop's
 * `claude://claude.ai/new?q=`, lib/dev/mcp-clients.ts) and a link may send a person into Claude to use Nightshift at all
 * (mcpConnectOffered: sign-in on and Claude at least "ready"). Claude takes a sign-in only, so a card that needs an API
 * key never gets it. No other assistant documents a prefilled-prompt link, so no other "Open in …" exists.
 */
export function McpPrompts({ dev, oauthLive }: { dev: DevDictionary; oauthLive: boolean }) {
  const p = dev.mcp.land.prompts;
  const claudeOffered = mcpConnectOffered("claude", oauthLive);
  return (
    <section id="prompts" aria-labelledby="prompts-title" className="ml-land mp-prompts">
      <div className="ml-land-in mp-in">
        <p className="ml-label">{p.label}</p>
        <h2 id="prompts-title" className="ml-land-h2 ml-land-h2-left">
          {p.title}
        </h2>
        <p className="ml-land-lead mp-lead">{p.lead}</p>
        <ul className="mp-grid">
          {PROMPT_GALLERY.map((item) => {
            const words = p.items.find((x) => x.id === item.id)!;
            const door = promptDoor(item.tools);
            // With the sign-in off nothing connects by sign-in, so a card may not say "sign-in or API key".
            const doorLabel = door === "key" ? p.door.studioKey : oauthLive ? p.door.either : p.door.key;
            const claude = claudeOffered && door === "both";
            return (
              <li key={item.id} className="mp-card" data-id={item.id} data-door={door}>
                <p className="mp-door">{doorLabel}</p>
                <h3 className="mp-title">{words.title}</h3>
                <p className="mp-prompt">{words.prompt}</p>
                <p className="mp-tools">
                  <span className="mp-tools-label">{p.toolsLabel}</span>
                  {item.tools.map((t) => (
                    <code key={t} className="mp-tool">
                      {t}
                    </code>
                  ))}
                </p>
                <div className="mp-actions">
                  <CopyButton text={words.prompt} name={`${p.copyName} (${words.title})`} labels={{ ...dev.ui, copy: p.copy }} variant="label" />
                  {claude && (
                    // A custom scheme is followed in the same tab: a new tab for a link the browser hands to an app stays blank.
                    <a href={claudeDesktopPromptLink(words.prompt)} className="st-key" data-size="sm" data-tone="quiet" data-prompt-link="claude-desktop">
                      {p.openClaude}
                      <ArrowUpRight aria-hidden />
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mp-notes">
          <p className="st-small">{p.keyNote}</p>
          {claudeOffered && <p className="st-small">{p.openClaudeHint}</p>}
        </div>
      </div>
    </section>
  );
}

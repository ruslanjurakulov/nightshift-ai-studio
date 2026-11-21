/**
 * A channel's mark: its own avatar (pulled from YouTube when the channel was
 * confirmed) on a film tile, or, when there is none, the channel's first letter
 * in the amber the frame numbers are printed in. A frame, not an icon tile: the
 * same device the app uses for every picture.
 */
export function ChannelMark({ name, thumbnail, size = "md" }: { name: string; thumbnail?: string | null; size?: "sm" | "md" }) {
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "·";
  return (
    <span className="g2-mark" data-size={size === "sm" ? "sm" : undefined} aria-hidden>
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbnail} alt="" width={size === "sm" ? 36 : 48} height={size === "sm" ? 36 : 48} referrerPolicy="no-referrer" />
      ) : (
        letter
      )}
    </span>
  );
}

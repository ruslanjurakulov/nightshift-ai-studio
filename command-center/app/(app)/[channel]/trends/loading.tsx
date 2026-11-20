import { TrendCardSkeleton } from "@/components/trends/TrendCard";
import "@/components/trends/trends.css";

export default function Loading() {
  return (
    <ul className="tr-grid" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i}>
          <TrendCardSkeleton />
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from "react";
export default function Link({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) {
  return <a href={href} {...rest}>{children}</a>;
}

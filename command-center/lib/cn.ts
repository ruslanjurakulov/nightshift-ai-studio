/*
 * The class-name joiner the adopted primitives expect (shadcn/ui's `cn`, MIT; see THIRD_PARTY_NOTICES). clsx drops falsy parts;
 * tailwind-merge lets a caller's `className` override a primitive's own utility of the same property instead of both shipping
 * and the stylesheet's order deciding which one paints.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

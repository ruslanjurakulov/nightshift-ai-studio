"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/slider.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; each thumb takes its own accessible name, because a range
 * slider's two thumbs ("from", "to") are two different controls to a screen reader and shadcn's version leaves them unnamed.
 */
import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import "./primitives.css";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbLabels,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** One accessible name per thumb, from lib/i18n (a single slider passes one). */
  thumbLabels: string[];
}) {
  const count = (value ?? defaultValue ?? [min]).length;
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn("ui-slider", className)}
      {...props}
    >
      <SliderPrimitive.Track className="ui-slider-track">
        <SliderPrimitive.Range className="ui-slider-range" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb key={i} className="ui-slider-thumb" aria-label={thumbLabels[i] ?? thumbLabels[0]} />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };

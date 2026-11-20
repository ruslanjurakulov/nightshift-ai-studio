"use client";

import { useI18n } from "@/lib/i18n/context";
import { TemplateGrid, useTrendTemplates } from "@/components/customer/HomeCreate";
import "@/components/customer/customer.css";

export function TrendsScreen() {
  const { t } = useI18n();
  const { reading, retry } = useTrendTemplates();
  return (
    <div className="cs-screen" data-testid="trends-screen">
      <header className="flex flex-col gap-1">
        <h1 className="cs-title">{t.customerApp.trends.title}</h1>
        <p className="m-0 max-w-[70ch] text-sm text-[var(--color-muted)]">{t.customerApp.trends.lead}</p>
      </header>
      <TemplateGrid reading={reading} retry={retry} />
    </div>
  );
}

import type { PublicStatsDictionary } from "./en";

/** Saytdagi jonli hisoblagichlar. Manba — ./en.ts. Mashina qoralamasi: ona tilida soʻzlashuvchi oʻqib chiqsin. */
export const publicStatsUz: PublicStatsDictionary = {
  label: "Konveyerimizdan jonli",
  lead: "Maʼlumotlar bazamizdan, mijozlarimizning ish maydonlari boʻyicha sanalgan. Oʻzimizning va sinov maydonlari hisobga olinmaydi.",
  asOf: "{time} holatiga",
  notMeasured: "hali oʻlchanmagan",
  counts: {
    videos_rendered: "Render qilingan videolar (kamida)",
    videos_uploaded_private: "YouTubeʼga yopiq (private) holda yuklangan videolar",
    videos_approved: "Inson tasdiqlagan videolar",
    studio_generations: "Studiyada yakunlangan generatsiyalar",
  },
  lastRun: "Konveyerning oxirgi ishi tugagan vaqt",
  hourRange: "{day}, {from} va {to} oraligʻida (UTC)",
};

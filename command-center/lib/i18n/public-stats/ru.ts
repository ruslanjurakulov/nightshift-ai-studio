import type { PublicStatsDictionary } from "./en";

/** Живые счётчики на сайте. Источник — ./en.ts. Машинный черновик: пусть прочитает носитель языка. */
export const publicStatsRu: PublicStatsDictionary = {
  label: "Вживую из нашего конвейера",
  lead: "Подсчитано по нашей базе данных, по рабочим пространствам клиентов. Наши собственные и тестовые пространства не учитываются.",
  asOf: "Данные на {time}",
  notMeasured: "ещё не измерено",
  counts: {
    videos_rendered: "Видео отрендерено",
    videos_uploaded_private: "Видео загружено на YouTube приватно",
    videos_approved: "Видео одобрено человеком",
    studio_generations: "Генераций в Студии завершено",
  },
  lastRun: "Последний запуск конвейера завершён",
};

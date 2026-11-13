import type { StudioProgressDictionary } from "./en";

/** Заглушка генерации в Студии: что делает задание (по его строке) и число на плашке — оценка, данные модели или секунды. Источник — ./en.ts. */
export const studioProgressRu: StudioProgressDictionary = {
  phase: {
    queued: "В очереди",
    sending: "Отправляем модели",
    making: "Модель работает",
    storing: "Сохраняем в библиотеку",
    done: "Готово",
    failed: "Не получилось",
  },
  coming: "{kind}: скоро будет",
  loadingResult: "Готово — загружаем результат",
  estimate: "~{n} %",
  estimateSpoken: "Готово примерно на {n} %. Это оценка по тому, сколько заняли последние задания этой модели здесь ({count}), а не измерение.",
  reported: "{n} %",
  reportedSpoken: "Готово на {n} % — по данным модели.",
  seconds: "{n} с",
  minutes: "{m} мин {s} с",
  elapsedSpoken: "{n} с с начала работы. Оценки нет: у этой модели здесь меньше 3 завершённых заданий.",
  waitingSpoken: "{n} с в очереди.",
};

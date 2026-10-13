import type { LibraryUxDictionary } from "./en";

/** Мелочи библиотеки: сортировка по имени, перетаскивание файлов, несколько файлов подряд. Источник — ./en.ts. */
export const libraryUxRu: LibraryUxDictionary = {
  sortName: "По имени, А–Я",
  dropHere: "Отпустите файлы, чтобы загрузить",
  dropHereFolder: "Отпустите файлы, чтобы загрузить в «{folder}»",
  dropHint: "Файлы можно также перетащить в любое место этой страницы.",
  dropTooMany: "Взяты только первые {max} файлов.",
  queue: "Файл {i} из {n}",
  someFailed: "Не удалось отправить файлов: {failed} из {n}:",
  fileFailed: "{name}: {reason}",
  selectionHint: "Shift-клик выбирает диапазон. Esc снимает выбор.",
};

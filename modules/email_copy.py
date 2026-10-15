"""The words of the e-mails (ready, weekly summary), one block per language CODE.

Languages are data here, not code: the renderer (modules/email_notify.py) takes
the recipient's language as an argument and looks the block up by code; a code
with no block is written in English. A new language is one new entry in COPY
(and a line in tests/test_email_notify.py's expectations: the test fails until
the block has exactly the same keys as English).

Rules the copy keeps, and tests/test_email_notify.py pins:

* every block has the same keys as ``en``, and every placeholder an English line
  uses is in the translation too;
* no provider or model brand names, no role words (owner / editor / viewer /
  admin);
* no sentence needs a plural form: a count is always "Label: {n}", so a language
  with several plural classes (or none) can be added without new code;
* no price, no promise about money: the only number about credits is the balance
  the account holds, shown as measured.

``dir`` is "ltr" or "rtl" and goes on the HTML root; ``decimal`` is the decimal
separator the language writes its numbers with.
"""

from __future__ import annotations

from typing import Dict, Mapping

DEFAULT_LANGUAGE = "en"

COPY: Dict[str, Dict[str, str]] = {
    "en": {
        "dir": "ltr",
        "decimal": ".",
        "subject_video": "{channel}: your video is ready",
        "subject_video_plain": "Your video is ready",
        "title_video": "Your video is ready",
        "body_video": "Take a look and decide what happens next.",
        "subject_export": "Your export is ready",
        "title_export": "Your export is ready",
        "body_export": "Your finished video is in your library.",
        "channel_label": "Channel",
        "cta_open": "Open",
        "cta_another": "Make another",
        "reason_ready": "You are getting this because e-mails about finished videos are on in your settings.",
        "unsub_ready": "Stop these e-mails",
        "manage": "E-mail settings",
        "subject_weekly": "Your week: what was made and what is waiting",
        "title_weekly": "The last {days} days",
        "intro_weekly": "Here is where things stand.",
        "made_videos": "Videos made: {n}",
        "made_exports": "Exports finished: {n}",
        "made_generations": "Generations finished: {n}",
        "waiting_videos": "Videos waiting for your decision: {n}",
        "waiting_storyboards": "Storyboards waiting for your decision: {n}",
        "credits_left": "Credits left: {n}",
        "channel_line": "{channel}: made {made}, waiting {waiting}",
        "cta_weekly_open": "Open Nightshift",
        "cta_weekly_new": "Make a new video",
        "reason_weekly": "You are getting this because you turned on the weekly summary in your settings.",
        "unsub_weekly": "Stop the summary",
    },
    "ru": {
        "dir": "ltr",
        "decimal": ",",
        "subject_video": "{channel}: ваше видео готово",
        "subject_video_plain": "Ваше видео готово",
        "title_video": "Ваше видео готово",
        "body_video": "Посмотрите его и решите, что делать дальше.",
        "subject_export": "Экспорт готов",
        "title_export": "Экспорт готов",
        "body_export": "Готовое видео уже в вашей библиотеке.",
        "channel_label": "Канал",
        "cta_open": "Открыть",
        "cta_another": "Сделать ещё",
        "reason_ready": "Вы получаете это письмо, потому что в настройках включены письма о готовых видео.",
        "unsub_ready": "Отключить эти письма",
        "manage": "Настройки писем",
        "subject_weekly": "Ваша неделя: что сделано и что ждёт решения",
        "title_weekly": "За последние {days} дн.",
        "intro_weekly": "Вот как обстоят дела.",
        "made_videos": "Сделано видео: {n}",
        "made_exports": "Готово экспортов: {n}",
        "made_generations": "Готово генераций: {n}",
        "waiting_videos": "Видео ждут вашего решения: {n}",
        "waiting_storyboards": "Раскадровки ждут вашего решения: {n}",
        "credits_left": "Осталось кредитов: {n}",
        "channel_line": "{channel}: сделано {made}, ждут {waiting}",
        "cta_weekly_open": "Открыть Nightshift",
        "cta_weekly_new": "Сделать новое видео",
        "reason_weekly": "Вы получаете это письмо, потому что включили еженедельную сводку в настройках.",
        "unsub_weekly": "Отключить сводку",
    },
    "uz": {
        "dir": "ltr",
        "decimal": ",",
        "subject_video": "{channel}: videongiz tayyor",
        "subject_video_plain": "Videongiz tayyor",
        "title_video": "Videongiz tayyor",
        "body_video": "Koʻrib chiqing va keyingi qadamni oʻzingiz hal qiling.",
        "subject_export": "Eksport tayyor",
        "title_export": "Eksport tayyor",
        "body_export": "Tayyor video kutubxonangizda.",
        "channel_label": "Kanal",
        "cta_open": "Ochish",
        "cta_another": "Yana bittasini yaratish",
        "reason_ready": "Bu xatni sozlamalarda tayyor videolar haqidagi xatlar yoqilgani uchun olyapsiz.",
        "unsub_ready": "Bu xatlarni oʻchirish",
        "manage": "Xat sozlamalari",
        "subject_weekly": "Haftangiz: nima yaratildi va nima qaroringizni kutmoqda",
        "title_weekly": "Soʻnggi {days} kun",
        "intro_weekly": "Hozirgi holat shunday.",
        "made_videos": "Yaratilgan videolar: {n}",
        "made_exports": "Tayyor eksportlar: {n}",
        "made_generations": "Tayyor generatsiyalar: {n}",
        "waiting_videos": "Qaroringizni kutayotgan videolar: {n}",
        "waiting_storyboards": "Qaroringizni kutayotgan raskadrovkalar: {n}",
        "credits_left": "Qolgan kreditlar: {n}",
        "channel_line": "{channel}: yaratildi {made}, kutmoqda {waiting}",
        "cta_weekly_open": "Nightshiftʼni ochish",
        "cta_weekly_new": "Yangi video yaratish",
        "reason_weekly": "Bu xatni sozlamalarda haftalik xulosani yoqqaningiz uchun olyapsiz.",
        "unsub_weekly": "Xulosani oʻchirish",
    },
}


def copy_for(language: str | None) -> Mapping[str, str]:
    """The block for a language code; English for a code (or a value) it has none for."""
    code = (language or "").strip().lower()
    return COPY.get(code) or COPY[DEFAULT_LANGUAGE]

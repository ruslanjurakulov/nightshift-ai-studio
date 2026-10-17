"""The operator control bot (@NightshiftAiStudio_bot): an owner-facing,
read-only-by-default panel for the person who runs the platform.

Layout, from the inside out:

  modules/telegram_control.py   authorization by sender and the legacy /channels
  config / sources / analysis   what is read, from where, and what it means
  views                         the messages and inline keyboards
  alerts / store                proactive alerts: dedupe, rate limit, quiet hours,
                                mute, daily digest
  router                        one update in -> authorization -> reply (poll and
                                webhook share it)
  webhook                       the secret-token check and the sender allow-list
                                that run BEFORE any work

It cannot publish, spend, change a price or a plan, grant a role, delete data or
approve anything. Those stay behind the publish gate and the human approvals;
the old /publish /pause /resume are gone (a typed one is answered "view-only").
See docs/operator-bot.md.
"""

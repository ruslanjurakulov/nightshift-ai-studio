"""Security-lab contract for migration 0121 (Custom Voice: the queue gates G2 and G3, and the oracle on channel_voice_config_problem).
One hook wires it in, at the bottom of sec_expectations.py:

    import sec_voice_job_gates_0121; sec_voice_job_gates_0121.extend(TABLES, FUNCTIONS)

No table is added. Three functions are: the two the worker's sweep calls (service role only, like the rest of the worker's side) and the
core of the oracle's function (the body 0117 had, now callable by nobody; the function of the old name is a wrapper that stays
executable by signed-in users and the service role, so it keeps its entry in sec_voice_profiles_0117.py). The attacks are in
test_sec_voice_job_gates.py.
"""

from __future__ import annotations


def extend(tables: dict, functions: dict) -> None:
    from sec_expectations import SERVICE

    functions.update({
        # the worker's sweep: counts and ages only / a bounded re-queue of failed purge and deletion jobs
        "voice_requeue_overdue": SERVICE,
        "voice_overdue_report": SERVICE,
        # 0117's channel_voice_config_problem, body unchanged, behind the wrapper that decides who is told the truth
        "channel_voice_config_problem_core": SERVICE,
    })

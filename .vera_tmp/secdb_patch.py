p = 'tests/security/sec_db.py'
s = open(p, encoding='utf-8').read()


def rep(old, new):
    global s
    assert s.count(old) == 1, old[:80]
    s = s.replace(old, new)


rep('''ROLLBACK_0159 = REPO / "docs" / "sql" / "rollback_0159_duration_offered_by_model.sql"
#: Migrations written on 0156's creative_price, which refuse to apply without it: a sequence that leaves 0156 out leaves these out too.
ON_0156 = (MIGRATION_0159.name,)''', '''ROLLBACK_0159 = REPO / "docs" / "sql" / "rollback_0159_duration_offered_by_model.sql"
MIGRATION_0208 = MIGRATIONS / "0208_geo_gate_and_image_size_price.sql"
ROLLBACK_0208 = REPO / "docs" / "sql" / "rollback_0208_geo_gate_and_image_size_price.sql"
#: Migrations written on 0156's creative_price, which refuse to apply without it: a sequence that leaves 0156 out leaves these out too.
#: 0208 sits on 0159's creative_price (and 0156's creative_params_problem).
ON_0156 = (MIGRATION_0159.name, MIGRATION_0208.name)''')

rep('''#: md5 of 0159's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0159 = "dafc5edae0000e741ac1b19bd0075790"


def has_0159(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0159]).fetchone()[0])
''', '''#: md5 of 0159's creative_price body (white space folded), the way its drift guard reads it.
CREATIVE_PRICE_0159 = "dafc5edae0000e741ac1b19bd0075790"
#: md5 of 0208's creative_price body: 0208 replaces 0159's (and 0156's creative_params_problem).
CREATIVE_PRICE_0208 = "f61aaddd5686045961addd6f14a02c32"


def has_0159(conn_or_session) -> bool:
    """0159's creative_price, or 0208's on top of it (take_off_0159 takes 0208 off first)."""
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\\\s+', ' ', 'g')) = any (%s) from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)",
        [[CREATIVE_PRICE_0159, CREATIVE_PRICE_0208]]).fetchone()[0])


def has_0208(conn_or_session) -> bool:
    conn = getattr(conn_or_session, "conn", conn_or_session)
    return bool(conn.execute(
        "select coalesce((select md5(regexp_replace(prosrc, '\\\\s+', ' ', 'g')) = %s from pg_proc "
        "where oid = to_regprocedure('public.creative_price(uuid, text, text, jsonb)')), false)", [CREATIVE_PRICE_0208]).fetchone()[0])


def rollback_0208_body() -> str:
    text = ROLLBACK_0208.read_text(encoding="utf-8")
    return "\\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))


def take_off_0208(session) -> None:
    """0208 replaces creative_price() on 0159's body and creative_params_problem() on 0156's, and 0159's and 0156's replays and
    rollbacks refuse any other body: taken off first with its own rollback, put back with put_back_0208."""
    session.conn.execute(rollback_0208_body())


def put_back_0208(session) -> None:
    session.conn.execute(MIGRATION_0208.read_text(encoding="utf-8"))
''')

rep('''    put_back_0159 where the chain goes on."""
    session.conn.execute(rollback_0159_body())


def put_back_0159(session) -> None:
    session.conn.execute(MIGRATION_0159.read_text(encoding="utf-8"))
''', '''    put_back_0159 where the chain goes on. 0208 sits on 0159's body, so it comes off first when it is there."""
    if has_0208(session):
        take_off_0208(session)
    session.conn.execute(rollback_0159_body())


def put_back_0159(session) -> None:
    session.conn.execute(MIGRATION_0159.read_text(encoding="utf-8"))
    put_back_0208(session)
''')
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')

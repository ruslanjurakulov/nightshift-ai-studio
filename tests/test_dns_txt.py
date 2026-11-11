"""modules/dns_txt.py: the DNS TXT proof of a domain (migration 0133). No real network: a fake resolver answers the
parser, and a TLS server on 127.0.0.1 with a throw-away CA plays the DNS-over-HTTPS resolver for the transport."""

from __future__ import annotations

import base64
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from modules import brand_fetch as bf
from modules import dns_txt as dt

HOST = "shop.example.com"
NAME = "_nightshift.shop.example.com"
TOKEN = "0123456789abcdef0123456789abcdef"
QID = 0x4A2F


def name_bytes(name: str) -> bytes:
    return b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"


def txt_rdata(*strings: bytes) -> bytes:
    return b"".join(bytes([len(s)]) + s for s in strings)


def rr(owner: bytes, rtype: int, rdata: bytes, rclass: int = dt.IN) -> bytes:
    return owner + struct.pack("!HHIH", rtype, rclass, 300, len(rdata)) + rdata


def answer(qid=QID, *, flags=0x8180, qname=NAME, qtype=dt.TXT, records=(), qd=1, an=None) -> bytes:
    """A response to our query: header, the question, then ``records`` (raw bytes, already encoded)."""
    recs = list(records)
    head = struct.pack("!HHHHHH", qid, flags, qd, len(recs) if an is None else an, 0, 0)
    return head + name_bytes(qname) + struct.pack("!HH", qtype, dt.IN) + b"".join(recs)


PTR_Q = b"\xc0\x0c"                                            # a pointer to the question's name
OURS = rr(PTR_Q, dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode()))


class FakeResolver:
    """The transport: records the query it was sent and answers with ``reply(query)``."""

    def __init__(self, reply):
        self.reply, self.queries = reply, []

    def __call__(self, query: bytes, budget) -> bytes:
        self.queries.append(query)
        return self.reply(query) if callable(self.reply) else self.reply


def verifier(reply) -> "tuple[dt.TxtVerifier, FakeResolver]":
    fake = FakeResolver(reply)
    return dt.TxtVerifier(fake, new_id=lambda: QID), fake


class Query(unittest.TestCase):
    def test_the_query_asks_for_txt_at_the_underscore_name_with_recursion(self):
        v, fake = verifier(answer(records=[OURS]))
        self.assertEqual(v.check(HOST, TOKEN), dt.VERIFIED)
        q = fake.queries[0]
        self.assertEqual(struct.unpack("!HHHHHH", q[:12]), (QID, 0x0100, 1, 0, 0, 0))
        self.assertEqual(q[12:], name_bytes(NAME) + struct.pack("!HH", dt.TXT, dt.IN))
        self.assertEqual(dt.record_name(HOST), NAME)

    def test_the_query_id_is_random_by_default(self):
        ids = set()
        for _ in range(64):
            fake = FakeResolver(lambda q: answer(qid=struct.unpack("!H", q[:2])[0], records=[OURS]))
            self.assertEqual(dt.TxtVerifier(fake).check(HOST, TOKEN), dt.VERIFIED)
            ids.add(fake.queries[0][:2])
        self.assertGreater(len(ids), 48)

    def test_a_host_or_token_of_the_wrong_shape_is_never_asked_about(self):
        for host in ("", "Shop.example.com", "a..b", "shop_x.test", "127.0.0.1", "x" * 250 + ".test", None, "a.b\n"):
            v, fake = verifier(answer(records=[OURS]))
            self.assertEqual(v.check(host, TOKEN), dt.DNS_ERROR, host)
            self.assertEqual(fake.queries, [])
        for token in ("", "short", TOKEN.upper(), TOKEN + "0", None):
            v, fake = verifier(answer(records=[OURS]))
            self.assertEqual(v.check(HOST, token), dt.DNS_ERROR)
            self.assertEqual(fake.queries, [])


class Verdicts(unittest.TestCase):
    def check(self, reply):
        return verifier(reply)[0].check(HOST, TOKEN)

    def test_our_record_among_others_is_verified(self):
        spf = rr(PTR_Q, dt.TXT, txt_rdata(b"v=spf1 -all"))
        self.assertEqual(self.check(answer(records=[spf, OURS])), dt.VERIFIED)

    def test_a_record_split_into_strings_is_read_joined(self):
        split = rr(PTR_Q, dt.TXT, txt_rdata(b"nightshift-verify=", TOKEN[:10].encode(), TOKEN[10:].encode()))
        self.assertEqual(self.check(answer(records=[split])), dt.VERIFIED)

    def test_another_token_or_a_near_miss_is_a_mismatch(self):
        for text in (f"nightshift-verify={'f' * 32}", f"nightshift-verify={TOKEN} ", f" nightshift-verify={TOKEN}",
                     f"NIGHTSHIFT-VERIFY={TOKEN}", TOKEN, f"nightshift-verify={TOKEN}x", f"nightshift-verify={TOKEN.upper()}"):
            with self.subTest(text=text):
                self.assertEqual(self.check(answer(records=[rr(PTR_Q, dt.TXT, txt_rdata(text.encode()))])), dt.MISMATCH)

    def test_no_record_or_no_name_is_no_record(self):
        self.assertEqual(self.check(answer(records=[])), dt.NO_RECORD)
        self.assertEqual(self.check(answer(flags=0x8183)), dt.NO_RECORD, "NXDOMAIN")

    def test_a_server_failure_or_a_refusal_is_a_dns_error_never_a_no(self):
        for rcode in (1, 2, 4, 5):
            self.assertEqual(self.check(answer(flags=0x8180 | rcode)), dt.DNS_ERROR, rcode)

    def test_a_non_ascii_record_is_never_ours(self):
        self.assertEqual(self.check(answer(records=[rr(PTR_Q, dt.TXT, txt_rdata("nightshift-verify=ü".encode()))])), dt.MISMATCH)


class Spoofing(unittest.TestCase):
    """What a forged or mangled answer can do: never verify. At worst it is a dns_error (the domain stays as it was)."""

    def check(self, reply):
        return verifier(reply)[0].check(HOST, TOKEN)

    def test_an_answer_to_another_query_id_is_refused(self):
        for qid in (QID ^ 1, 0, 0xFFFF):
            self.assertEqual(self.check(answer(qid=qid, records=[OURS])), dt.DNS_ERROR, qid)

    def test_a_truncated_answer_is_refused_even_with_our_record_in_it(self):
        self.assertEqual(self.check(answer(flags=0x8380, records=[OURS])), dt.DNS_ERROR)

    def test_a_cut_message_is_refused_wherever_it_is_cut(self):
        full = answer(records=[OURS])
        for n in range(0, len(full)):
            with self.subTest(n=n):
                self.assertNotEqual(self.check(full[:n]), dt.VERIFIED)
                self.assertEqual(self.check(full[:n]), dt.DNS_ERROR)

    def test_a_count_that_promises_more_records_than_are_there_is_refused(self):
        self.assertEqual(self.check(answer(records=[OURS], an=2)), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(records=[OURS] * 65)), dt.DNS_ERROR, "more than MAX_ANSWERS")

    def test_an_oversized_answer_is_refused_before_it_is_read(self):
        padding = rr(PTR_Q, dt.TXT, txt_rdata(*([b"x" * 255] * 16)))
        big = answer(records=[OURS] + [padding] * 2)
        self.assertGreater(len(big), dt.MAX_MESSAGE)
        self.assertEqual(self.check(big), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(records=[OURS]) + b"\x00" * dt.MAX_MESSAGE), dt.DNS_ERROR)

    def test_a_query_instead_of_a_response_or_another_opcode_is_refused(self):
        self.assertEqual(self.check(answer(flags=0x0100, records=[OURS])), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(flags=0x8980, records=[OURS])), dt.DNS_ERROR, "opcode 1")

    def test_an_answer_to_another_question_is_refused(self):
        for kw in ({"qname": "_nightshift.evil.example.com"}, {"qname": "shop.example.com"}, {"qtype": 1}, {"qd": 2}, {"qd": 0}):
            with self.subTest(kw=kw):
                self.assertEqual(self.check(answer(records=[OURS], **kw)), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(qname=NAME.upper(), records=[OURS])), dt.VERIFIED, "names compare without case")

    def test_a_cname_is_not_followed_and_its_targets_record_does_not_count(self):
        target = name_bytes("verify.attacker.test")
        cname = rr(PTR_Q, dt.CNAME, target)
        theirs = rr(target, dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode()))
        self.assertEqual(self.check(answer(records=[cname, theirs])), dt.NO_RECORD)
        # The target's record written with a pointer to the CNAME's rdata: still another name.
        ptr_to_target = bytes([0xC0, 12 + len(name_bytes(NAME)) + 4 + 2 + 10])
        self.assertEqual(self.check(answer(records=[cname, rr(ptr_to_target, dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode()))])),
                         dt.NO_RECORD)

    def test_a_record_for_another_name_or_class_or_type_next_to_ours_does_not_count(self):
        for rec in (rr(name_bytes("shop.example.com"), dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode())),
                    rr(name_bytes("x._nightshift.shop.example.com"), dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode())),
                    rr(PTR_Q, dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode()), rclass=3),
                    rr(PTR_Q, 99, txt_rdata(f"nightshift-verify={TOKEN}".encode()))):
            self.assertEqual(self.check(answer(records=[rec])), dt.NO_RECORD)

    def test_compression_games_are_refused(self):
        first = 12 + len(name_bytes(NAME)) + 4                              # where the first record's owner starts
        itself = rr(struct.pack("!H", 0xC000 | first), dt.TXT, txt_rdata(b"x"))
        self.assertEqual(self.check(answer(records=[itself, OURS])), dt.DNS_ERROR, "a pointer to itself")
        self.assertEqual(self.check(answer(records=[rr(b"\xc0\xff", dt.TXT, b"\x01x"), OURS])), dt.DNS_ERROR, "forward")
        self.assertEqual(self.check(answer(records=[rr(b"\x80abc", dt.TXT, b"\x01x"), OURS])), dt.DNS_ERROR, "a label type 10")
        self.assertEqual(self.check(answer(records=[rr(b"\x40abc", dt.TXT, b"\x01x"), OURS])), dt.DNS_ERROR, "a label type 01")

        def chained(k):
            """A first record whose rdata is k backward pointers, each to the one before (the first to the question), and our
            record whose owner points at the last: k + 1 jumps to read its name."""
            base = first + 2 + 10
            chain = b"".join(struct.pack("!H", 0xC000 | (12 if i == 0 else base + 2 * (i - 1))) for i in range(k))
            return answer(records=[rr(PTR_Q, 99, chain), rr(struct.pack("!H", 0xC000 | (base + 2 * (k - 1))), dt.TXT,
                                                             txt_rdata(f"nightshift-verify={TOKEN}".encode()))])
        # A pointer FORWARD to a copy of our name hidden in a later record's data: the name would read as ours, and is refused.
        later = rr(name_bytes("x.test"), 99, name_bytes(NAME))
        ours_first_len = 2 + 10 + len(txt_rdata(f"nightshift-verify={TOKEN}".encode()))
        target = first + ours_first_len + len(name_bytes("x.test")) + 10
        forward = rr(struct.pack("!H", 0xC000 | target), dt.TXT, txt_rdata(f"nightshift-verify={TOKEN}".encode()))
        self.assertEqual(self.check(answer(records=[forward, later])), dt.DNS_ERROR, "a forward pointer")
        backward = answer(records=[later, rr(struct.pack("!H", 0xC000 | (first + len(name_bytes("x.test")) + 10)), dt.TXT,
                                             txt_rdata(f"nightshift-verify={TOKEN}".encode()))])
        self.assertEqual(self.check(backward), dt.VERIFIED, "the same name pointed at backwards is read")
        self.assertEqual(self.check(chained(dt.MAX_POINTERS - 1)), dt.VERIFIED, "within the cap the name reads as ours")
        self.assertEqual(self.check(chained(dt.MAX_POINTERS)), dt.DNS_ERROR, "one jump too many")

    def test_a_label_holding_a_dot_or_another_byte_is_never_our_name(self):
        # "_nightshift.shop" as ONE label, then "example", "com": joined as text it would spell the name we asked for.
        dotted = b"\x10_nightshift.shop" + name_bytes("example.com")
        theirs = txt_rdata(f"nightshift-verify={TOKEN}".encode())
        self.assertEqual(self.check(answer(records=[rr(dotted, dt.TXT, theirs)])), dt.NO_RECORD)
        for bad in (b"_night shift", b"_night\x00shift", b"_night/shift", b"_nightshift\xff"):
            owner = bytes([len(bad)]) + bad + name_bytes("shop.example.com")
            self.assertEqual(self.check(answer(records=[rr(owner, dt.TXT, theirs)])), dt.NO_RECORD, bad)
        # The same trick in the question: an answer to another question.
        q = struct.pack("!HHHHHH", QID, 0x8180, 1, 1, 0, 0) + dotted + struct.pack("!HH", dt.TXT, dt.IN) + OURS
        self.assertEqual(self.check(q), dt.DNS_ERROR)

    def test_a_name_longer_than_255_bytes_is_refused(self):
        long_owner = (b"\x3f" + b"a" * 63) * 4 + b"\x00"
        self.assertEqual(self.check(answer(records=[rr(long_owner, dt.TXT, b"\x01x")])), dt.DNS_ERROR)

    def test_a_txt_string_that_runs_past_its_record_or_an_empty_record_is_refused(self):
        self.assertEqual(self.check(answer(records=[rr(PTR_Q, dt.TXT, b"\x09short")])), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(records=[rr(PTR_Q, dt.TXT, b"")])), dt.DNS_ERROR)
        self.assertEqual(self.check(answer(records=[rr(PTR_Q, dt.TXT, b"\x00")])), dt.MISMATCH, "one empty string is a record")

    def test_garbage_and_the_wrong_types_are_dns_errors(self):
        for junk in (b"", b"\x00" * 11, b"\xff" * 512, "text", None, 12):
            self.assertEqual(self.check(junk), dt.DNS_ERROR, junk)

    def test_a_transport_that_ran_out_of_time_is_a_timeout(self):
        def slow(q, budget):
            raise bf.BrandFetchError(bf.E_TIMEOUT, "late")
        self.assertEqual(dt.TxtVerifier(slow).check(HOST, TOKEN), dt.TIMEOUT)

        def gone(q, budget):
            raise dt.DnsError(dt.DNS_ERROR, "x")
        self.assertEqual(dt.TxtVerifier(gone).check(HOST, TOKEN), dt.DNS_ERROR)


# ── the DNS-over-HTTPS transport, against a loopback resolver ─────────────────────────────────────────────────────

_CERTS: dict = {}
RESOLVER_IP = "104.16.248.249"     # stands for the resolver; routed to the loopback server


def setUpModule():
    d = Path(tempfile.mkdtemp(prefix="dns_txt_ca_"))
    _CERTS["dir"] = d

    def run(*args):
        subprocess.run(["openssl", *args], check=True, capture_output=True, timeout=60, cwd=d)

    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", "ca.key", "-out", "ca.pem",
        "-subj", "/CN=DoH Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    for host, stem in ((dt.RESOLVER_HOST, "leaf"), ("evil.test", "evil")):
        run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{stem}.key", "-out", f"{stem}.csr", "-subj", f"/CN={host}")
        (d / f"{stem}.cnf").write_text(f"subjectAltName=DNS:{host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n")
        run("x509", "-req", "-in", f"{stem}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
            "-out", f"{stem}.pem", "-extfile", f"{stem}.cnf")


def tearDownModule():
    shutil.rmtree(_CERTS.pop("dir"), ignore_errors=True)


class Resolver:
    """A TLS server on 127.0.0.1 that answers GET /dns-query?dns=... with ``respond(query) -> raw HTTP``."""

    def __init__(self, respond, stem="leaf"):
        self.ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ctx.load_cert_chain(str(_CERTS["dir"] / f"{stem}.pem"), str(_CERTS["dir"] / f"{stem}.key"))
        self.respond, self.requests = respond, []
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            try:
                tls = self.ctx.wrap_socket(conn, server_side=True)
                data = b""
                while b"\r\n\r\n" not in data and len(data) < 65536:
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                line = data.split(b"\r\n", 1)[0].decode()
                self.requests.append(data.decode("latin-1"))
                target = line.split(" ")[1]
                q = parse_qs(urlsplit(target).query).get("dns", [""])[0]
                query = base64.urlsafe_b64decode(q + "=" * (-len(q) % 4))
                tls.sendall(self.respond(query))
                tls.close()
            except (OSError, ssl.SSLError, ValueError, IndexError):
                conn.close()

    def close(self):
        self.sock.close()


def http_answer(body: bytes, status=200, ctype="application/dns-message", extra=()) -> bytes:
    head = [f"HTTP/1.1 {status} X", f"Content-Type: {ctype}", f"Content-Length: {len(body)}", "Connection: close", *extra]
    return ("\r\n".join(head) + "\r\n\r\n").encode() + body


def echo(query: bytes, records=(OURS,)) -> bytes:
    qid = struct.unpack("!H", query[:2])[0]
    return http_answer(answer(qid=qid, records=list(records)))


class OverHttps(unittest.TestCase):
    def net(self, server, answers=(RESOLVER_IP,)):
        dialled = []

        def connect(ip, timeout):
            dialled.append(ip)
            return socket.create_connection(("127.0.0.1", server.port), timeout=timeout)

        self.dialled = dialled
        return bf._TestNet(resolve=lambda h: list(answers) if h == dt.RESOLVER_HOST else [],
                           connect=connect, tls=ssl.create_default_context(cafile=str(_CERTS["dir"] / "ca.pem")))

    def run_check(self, respond, stem="leaf", answers=(RESOLVER_IP,)):
        server = Resolver(respond, stem)
        self.addCleanup(server.close)
        v = dt.TxtVerifier(dt.doh_transport(self.net(server, answers)), budget_s=5)
        return v.check(HOST, TOKEN), server

    def test_a_real_round_trip_verifies_and_the_request_is_a_plain_rfc8484_get(self):
        code, server = self.run_check(echo)
        self.assertEqual(code, dt.VERIFIED)
        req = server.requests[0]
        self.assertTrue(req.startswith("GET /dns-query?dns="), req[:60])
        self.assertIn(f"Host: {dt.RESOLVER_HOST}\r\n", req)
        self.assertIn("Accept: application/dns-message\r\n", req)
        self.assertIn("Accept-Encoding: identity\r\n", req)
        self.assertNotIn("Cookie", req)
        self.assertEqual(self.dialled, [RESOLVER_IP])

    def test_another_certificate_name_is_refused(self):
        code, _ = self.run_check(echo, stem="evil")
        self.assertEqual(code, dt.DNS_ERROR)

    def test_the_resolvers_name_must_resolve_to_public_addresses_only(self):
        for answers in (("127.0.0.1",), (RESOLVER_IP, "10.0.0.1"), ()):
            with self.subTest(answers=answers):
                code, server = self.run_check(echo, answers=answers)
                self.assertEqual(code, dt.DNS_ERROR)
                self.assertEqual(server.requests, [])
                self.assertEqual(self.dialled, [])

    def test_an_answer_that_is_not_a_200_dns_message_is_refused(self):
        for resp in (lambda q: http_answer(b"", status=302, extra=("Location: https://evil.test/",)),
                     lambda q: http_answer(answer(qid=struct.unpack("!H", q[:2])[0], records=[OURS]), ctype="text/html"),
                     lambda q: http_answer(answer(qid=struct.unpack("!H", q[:2])[0], records=[OURS]), extra=("Content-Encoding: gzip",)),
                     lambda q: http_answer(b"x" * (dt.MAX_MESSAGE + 1)),
                     lambda q: (b"HTTP/1.1 200 X\r\nContent-Type: application/dns-message\r\nConnection: close\r\n\r\n" + b"\x00" * 9000)):
            with self.subTest():
                code, _ = self.run_check(resp)
                self.assertEqual(code, dt.DNS_ERROR)

    def test_a_resolver_that_never_answers_is_a_timeout_within_the_budget(self):
        import time

        hold = threading.Event()
        self.addCleanup(hold.set)

        def stall(q):
            hold.wait(10)
            return b""
        t = time.monotonic()
        server = Resolver(stall)
        self.addCleanup(server.close)
        v = dt.TxtVerifier(dt.doh_transport(self.net(server)), budget_s=1)
        self.assertIn(v.check(HOST, TOKEN), (dt.TIMEOUT, dt.DNS_ERROR))
        self.assertLess(time.monotonic() - t, 3)

    def test_a_tls_context_that_does_not_check_the_name_is_refused_before_anything_is_sent(self):
        server = Resolver(echo)
        self.addCleanup(server.close)
        for loose in ("no_name", "no_cert"):
            ctx = ssl.create_default_context(cafile=str(_CERTS["dir"] / "ca.pem"))
            ctx.check_hostname = False
            if loose == "no_cert":
                ctx.verify_mode = ssl.CERT_NONE
            net = self.net(server)
            net = bf._TestNet(resolve=net.resolve, connect=net.connect, tls=ctx)
            self.assertEqual(dt.TxtVerifier(dt.doh_transport(net), budget_s=5).check(HOST, TOKEN), dt.DNS_ERROR, loose)
            self.assertEqual(self.dialled, [], "refused before any connection")
        self.assertEqual(server.requests, [])

    def test_only_a_real_test_hook_is_accepted_and_the_default_is_the_fixed_resolver(self):
        class Lookalike:
            resolve = connect = tls = None
        with self.assertRaises(TypeError):
            dt.doh_transport(Lookalike())
        self.assertEqual((dt.RESOLVER_HOST, dt.RESOLVER_PATH), ("cloudflare-dns.com", "/dns-query"))
        src = Path(dt.__file__).read_text(encoding="utf-8")
        for banned in ("import requests", "urllib.request", "allow_redirects", "getaddrinfo(", "SOCK_DGRAM"):
            self.assertNotIn(banned, src)


if __name__ == "__main__":
    unittest.main()

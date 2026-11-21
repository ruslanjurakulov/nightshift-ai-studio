"""Proof that a person controls a domain: the DNS TXT record ``nightshift-verify=<token>`` at ``_nightshift.<host>``
(migration 0133, docs/ADS_FACTORY.md "Phase 2: brand scan", the owner's "strong form").

Why DNS-over-HTTPS to one fixed resolver, and not the system resolver.
* The stdlib has no TXT lookup (``getaddrinfo`` answers addresses only) and ``dnspython`` is not a dependency
  (requirements.txt). The two ways left were a hand-made DNS query over UDP to the resolver in /etc/resolv.conf, or the
  same query over HTTPS (RFC 8484) to a fixed public resolver.
* A plain UDP answer can be forged by anyone who can send packets to the worker (an off-path attacker racing the real
  answer has 32 bits of query id and source port to guess, and a successful forgery here VERIFIES a domain the attacker
  does not own). An answer over TLS from a certificate-checked resolver cannot be forged on the path at all.
* The resolver is one fixed name (``RESOLVER_HOST``), so this is not a fetch of anything a customer chose: no SSRF
  surface. The connection reuses the brand fetcher's safe socket (``modules/brand_fetch.py``: the name resolved once
  and every answer held to the public-address rule, the certificate checked for the name on TLS 1.2+, every wait capped
  by a budget, every byte counted against a cap, no redirect followed, nothing compressed).
* The customer's host is not a secret (it is the site the person asked us to scan), so telling the resolver which TXT
  record we ask for gives nothing away.

The answer is parsed strictly (``parse_txt_answer``): the id must be ours, the message must be a response to a standard
query with the question we asked and not truncated, at most ``MAX_MESSAGE`` bytes, every name and record inside its
bounds, compression pointers only backwards and at most ``MAX_POINTERS`` of them. ONLY a TXT record whose owner name is
exactly the name we asked for counts: a CNAME is not followed, and a record for any other name in the answer (a CNAME
target, an attacker's name next to it) is ignored. So a zone owner must publish the record at ``_nightshift.<host>``
itself.

What a check says (``TxtVerifier.check``), the closed codes 0133's ``finish_domain_check`` stores:
  ``verified``   a TXT record at the name reads exactly ``nightshift-verify=<token>``
  ``mismatch``   TXT records are there, none is ours (a definite "no": 0133 takes a verification away)
  ``no_record``  the name does not exist, or has no TXT record (a definite "no" as well)
  ``dns_error``  the resolver could not be asked or answered something unusable (the domain is left as it was)
  ``timeout``    no answer within the budget (left as it was)

Known limit: the resolver's own caches decide how soon a record that was just added is seen (a "no" it cached can last
for the zone's negative TTL, often minutes). The page says so and the person presses "Check now" again.
"""

from __future__ import annotations

import base64
import http.client
import re
import secrets
import socket
import ssl
import struct
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

from modules import brand_fetch as bf

RESOLVER_HOST = "cloudflare-dns.com"
RESOLVER_PATH = "/dns-query"
#: The whole check, every wait together.
CHECK_BUDGET_S = 10.0
#: A DNS message is at most this many bytes; anything larger is refused (TXT answers for one name are small).
MAX_MESSAGE = 4096
MAX_ANSWERS = 64
MAX_POINTERS = 16
TXT, IN, CNAME = 16, 1, 5
RECORD_LABEL = "_nightshift"
RECORD_PREFIX = "nightshift-verify="

VERIFIED, MISMATCH, NO_RECORD, DNS_ERROR, TIMEOUT = "verified", "mismatch", "no_record", "dns_error", "timeout"

#: The host shape 0133's ads_scan_host_ok holds (a lower-case DNS name, letters or punycode last, no underscore).
_HOST = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:xn--[a-z0-9-]{1,59}|[a-z]{2,63})\Z")
_TOKEN = re.compile(r"[0-9a-f]{32}\Z")
_LABEL = re.compile(rb"[A-Za-z0-9_-]{1,63}")


class DnsError(Exception):
    """An answer that cannot be used. ``code`` is ``dns_error`` or ``timeout``; ``reason`` a word for the log."""

    def __init__(self, code: str, reason: str):
        super().__init__(f"{code}: {reason}")
        self.code, self.reason = code, reason


def record_name(host: str) -> str:
    if not isinstance(host, str) or len(host) > 240 or not _HOST.match(host):
        raise DnsError(DNS_ERROR, "not a host name")
    return f"{RECORD_LABEL}.{host}"


# ── the message ───────────────────────────────────────────────────────────────────────────────────────────────────

def _encode_name(name: str) -> bytes:
    out = b""
    for label in name.rstrip(".").split("."):
        raw = label.encode("ascii")
        if not 1 <= len(raw) <= 63:
            raise DnsError(DNS_ERROR, "a label of the wrong length")
        out += bytes([len(raw)]) + raw
    if len(out) + 1 > 255:
        raise DnsError(DNS_ERROR, "a name over 255 bytes")
    return out + b"\x00"


def build_query(name: str, qid: int) -> bytes:
    """A standard query (RD set) for the TXT records of ``name``, class IN, with id ``qid``."""
    return struct.pack("!HHHHHH", qid & 0xFFFF, 0x0100, 1, 0, 0, 0) + _encode_name(name) + struct.pack("!HH", TXT, IN)


def _read_name(msg: bytes, pos: int) -> "tuple[str, int]":
    """The name at ``pos`` and the offset just after it in the record (compression pointers followed backwards only)."""
    labels: List[str] = []
    end = None
    jumps = 0
    total = 0
    while True:
        if pos >= len(msg):
            raise DnsError(DNS_ERROR, "a name runs past the message")
        n = msg[pos]
        if n & 0xC0 == 0xC0:
            if pos + 1 >= len(msg):
                raise DnsError(DNS_ERROR, "a cut pointer")
            target = ((n & 0x3F) << 8) | msg[pos + 1]
            if target >= pos:
                raise DnsError(DNS_ERROR, "a pointer that does not point backwards")
            jumps += 1
            if jumps > MAX_POINTERS:
                raise DnsError(DNS_ERROR, "too many pointers")
            if end is None:
                end = pos + 2
            pos = target
            continue
        if n & 0xC0:
            raise DnsError(DNS_ERROR, "a label type that is not used")
        if n == 0:
            if end is None:
                end = pos + 1
            break
        if pos + 1 + n > len(msg):
            raise DnsError(DNS_ERROR, "a label runs past the message")
        total += n + 1
        if total > 255:
            raise DnsError(DNS_ERROR, "a name over 255 bytes")
        label = msg[pos + 1:pos + 1 + n]
        # Letters, digits, hyphen and underscore only: a label that holds a dot ("_nightshift.shop" as ONE label) would read back as two
        # labels of the name we asked for, and any other byte is no host name. Such a label is never equal to ours.
        labels.append(label.decode("ascii").lower() if _LABEL.fullmatch(label) else "\x00")
        pos += 1 + n
    return ".".join(labels), end


@dataclass(frozen=True)
class TxtAnswer:
    """What the resolver said about the name: whether it exists, and the TXT texts AT THAT NAME (each record's strings
    joined, as RFC 7208 reads a TXT record)."""

    exists: bool
    texts: Sequence[str]


def parse_txt_answer(msg: bytes, qid: int, name: str) -> TxtAnswer:
    """The TXT records for exactly ``name`` in the answer to our query ``qid``, or ``DnsError``."""
    if not isinstance(msg, (bytes, bytearray)) or len(msg) > MAX_MESSAGE:
        raise DnsError(DNS_ERROR, "an answer over the size cap")
    if len(msg) < 12:
        raise DnsError(DNS_ERROR, "an answer shorter than a header")
    rid, flags, qd, an, _ns, _ar = struct.unpack("!HHHHHH", msg[:12])
    if rid != qid & 0xFFFF:
        raise DnsError(DNS_ERROR, "an answer to another query (id)")
    if not flags & 0x8000 or (flags >> 11) & 0xF != 0:
        raise DnsError(DNS_ERROR, "not a response to a standard query")
    if flags & 0x0200:
        raise DnsError(DNS_ERROR, "a truncated answer")
    rcode = flags & 0xF
    if qd != 1:
        raise DnsError(DNS_ERROR, "not exactly one question")
    qname, pos = _read_name(msg, 12)
    if pos + 4 > len(msg):
        raise DnsError(DNS_ERROR, "a cut question")
    qtype, qclass = struct.unpack("!HH", msg[pos:pos + 4])
    pos += 4
    want = name.rstrip(".").lower()
    if qname != want or qtype != TXT or qclass != IN:
        raise DnsError(DNS_ERROR, "an answer to another question")
    if rcode == 3:                                       # NXDOMAIN: the name does not exist
        return TxtAnswer(False, ())
    if rcode != 0:
        raise DnsError(DNS_ERROR, f"the resolver answered rcode {rcode}")
    if an > MAX_ANSWERS:
        raise DnsError(DNS_ERROR, "too many answer records")
    texts: List[str] = []
    for _ in range(an):
        owner, pos = _read_name(msg, pos)
        if pos + 10 > len(msg):
            raise DnsError(DNS_ERROR, "a cut record")
        rtype, rclass, _ttl, rdlen = struct.unpack("!HHIH", msg[pos:pos + 10])
        pos += 10
        if pos + rdlen > len(msg):
            raise DnsError(DNS_ERROR, "a record runs past the message")
        rdata = msg[pos:pos + rdlen]
        pos += rdlen
        if rtype != TXT or rclass != IN or owner != want:
            continue                                     # a CNAME, its target's records, anything for another name
        parts, i = [], 0
        while i < len(rdata):
            n = rdata[i]
            if i + 1 + n > len(rdata):
                raise DnsError(DNS_ERROR, "a TXT string runs past its record")
            parts.append(bytes(rdata[i + 1:i + 1 + n]))
            i += 1 + n
        if not parts:
            raise DnsError(DNS_ERROR, "an empty TXT record")
        try:
            texts.append(b"".join(parts).decode("ascii"))
        except UnicodeDecodeError:
            texts.append("\x00")                          # a record, but never ours
    return TxtAnswer(True, tuple(texts))


def verdict(answer: TxtAnswer, token: str) -> str:
    want = RECORD_PREFIX + token
    if any(t == want for t in answer.texts):
        return VERIFIED
    return MISMATCH if answer.texts else NO_RECORD


# ── the transport: DNS-over-HTTPS (RFC 8484) over the brand fetcher's safe socket ─────────────────────────────────

Transport = Callable[[bytes, "bf.Budget"], bytes]


def doh_transport(_test_net: Optional["bf._TestNet"] = None) -> Transport:
    """GET https://cloudflare-dns.com/dns-query?dns=<query> with Accept: application/dns-message. The resolver's name is
    looked up once and every answer must be a public address; TLS checks the certificate for the name; 200 and
    application/dns-message only; at most MAX_MESSAGE bytes; no redirect, no compression. ``_test_net`` is for tests
    only (the brand fetcher's hook: it maps the name to a loopback server and cannot switch the address rule off)."""
    if _test_net is not None and not isinstance(_test_net, bf._TestNet):
        raise TypeError("_test_net is for tests only")

    def send(query: bytes, budget: "bf.Budget") -> bytes:
        resolve = _test_net.resolve if _test_net is not None else bf._system_resolve
        connect = _test_net.connect if _test_net is not None else bf._system_connect
        tls = _test_net.tls if _test_net is not None else bf._system_tls()
        if not tls.check_hostname or tls.verify_mode != ssl.CERT_REQUIRED:
            raise DnsError(DNS_ERROR, "a TLS context that does not verify the name")
        try:
            budget.check()
            answers = list(dict.fromkeys(resolve(RESOLVER_HOST)))
        except bf.BrandFetchError as e:
            raise DnsError(TIMEOUT if e.code == bf.E_TIMEOUT else DNS_ERROR, e.code) from None
        except (OSError, UnicodeError):
            raise DnsError(DNS_ERROR, "the resolver's name did not resolve") from None
        if not answers or any(bf.address_problem(a) for a in answers):
            raise DnsError(DNS_ERROR, "the resolver's name resolves to an address that is not public")
        target = RESOLVER_PATH + "?dns=" + base64.urlsafe_b64encode(query).decode("ascii").rstrip("=")
        last = "no address"
        for ip in answers:
            raw = None
            try:
                raw = connect(ip, budget.timeout(bf.CONNECT_TIMEOUT_S))
                raw.settimeout(budget.timeout(bf.READ_TIMEOUT_S))
                sock = bf._DeadlineSocket(tls.wrap_socket(raw, server_hostname=RESOLVER_HOST), budget, bf.MAX_HEADER_BYTES)
            except bf.BrandFetchError as e:
                if raw is not None:
                    raw.close()
                raise DnsError(TIMEOUT if e.code == bf.E_TIMEOUT else DNS_ERROR, e.code) from None
            except ssl.SSLError:
                if raw is not None:
                    raw.close()
                raise DnsError(DNS_ERROR, "TLS with the resolver failed") from None
            except OSError as e:
                if raw is not None:
                    raw.close()
                last = type(e).__name__
                continue
            conn = bf._Conn(RESOLVER_HOST, sock)
            try:
                conn.putrequest("GET", target, skip_host=True, skip_accept_encoding=True)
                for k, v in (("Host", RESOLVER_HOST), ("User-Agent", bf.USER_AGENT), ("Accept", "application/dns-message"),
                             ("Accept-Encoding", "identity"), ("Connection", "close")):
                    conn.putheader(k, v)
                conn.endheaders()
                resp = conn.getresponse()
                sock.limit = sock.read_total + MAX_MESSAGE + bf.MAX_FRAMING_BYTES
                if resp.status != 200:
                    raise DnsError(DNS_ERROR, f"the resolver answered HTTP {resp.status}")
                if (resp.getheader("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/dns-message":
                    raise DnsError(DNS_ERROR, "the resolver answered something that is not a DNS message")
                if (resp.getheader("Content-Encoding") or "identity").strip().lower() != "identity":
                    raise DnsError(DNS_ERROR, "a compressed answer")
                declared = resp.getheader("Content-Length")
                if declared is not None and (not declared.strip().isdigit() or int(declared) > MAX_MESSAGE):
                    raise DnsError(DNS_ERROR, "an answer over the size cap")
                body = resp.read(MAX_MESSAGE + 1)
                if len(body) > MAX_MESSAGE:
                    raise DnsError(DNS_ERROR, "an answer over the size cap")
                return body
            except bf.BrandFetchError as e:
                raise DnsError(TIMEOUT if e.code == bf.E_TIMEOUT else DNS_ERROR, e.code) from None
            except (socket.timeout, TimeoutError):
                raise DnsError(TIMEOUT, "the resolver did not answer in time") from None
            except (http.client.HTTPException, ValueError, OSError) as e:
                raise DnsError(DNS_ERROR, f"the resolver's answer could not be read ({type(e).__name__})") from None
            finally:
                conn.close()
                sock.close()
        raise DnsError(DNS_ERROR, f"could not connect to the resolver ({last})")

    return send


class TxtVerifier:
    """One question: does ``_nightshift.<host>`` say ``nightshift-verify=<token>``? ``transport`` sends a DNS query and
    returns the raw answer (the default is DNS-over-HTTPS to ``RESOLVER_HOST``); a test passes a fake resolver."""

    def __init__(self, transport: Optional[Transport] = None, *, budget_s: float = CHECK_BUDGET_S,
                 new_id: Callable[[], int] = lambda: secrets.randbits(16)):
        self.transport = transport or doh_transport()
        self.budget_s = budget_s
        self.new_id = new_id

    def check(self, host: str, token: str) -> str:
        if not isinstance(token, str) or not _TOKEN.match(token):
            return DNS_ERROR
        try:
            name = record_name(host)
            qid = self.new_id()
            budget = bf.Budget(self.budget_s)
            raw = self.transport(build_query(name, qid), budget)
            return verdict(parse_txt_answer(raw, qid, name), token)
        except DnsError as e:
            return e.code
        except bf.BrandFetchError as e:
            return TIMEOUT if e.code == bf.E_TIMEOUT else DNS_ERROR

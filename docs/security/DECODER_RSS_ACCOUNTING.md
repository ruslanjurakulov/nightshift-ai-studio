# Decoder RSS must not include the worker heap

## Evidence and diagnosis

The clean 64x64 ingest in `RealDecoderTests` failed in CI runs
[41388597184](https://github.com/ruslanjurakulov/nightshift-ai-studio/actions/runs/41388597184)
and [41582309819](https://github.com/ruslanjurakulov/nightshift-ai-studio/actions/runs/41582309819).
Both logged approximately 272–273 MiB against the test's 256 MiB allowance.
The CI logs do not measure the parent's RSS separately.

A local Linux reproduction did: with 160 MiB allocated in the parent, a
no-op Python child reported 172.24 MiB through the old `ffmpeg_limits.run`.
The revised launcher reported 8.12 MiB for the same command and parent.
Linux `wait4().ru_maxrss` includes the child's pre-exec footprint, inherited
when it is created from the large worker. It is not decoder-only memory.
The old implementation also rejected a successfully decoded synthetic 64x64
video with 640 MiB of parent padding under the real 512 MiB base allowance.

These are local measurements, not production memory measurements. The
per-frame check is an early crop-window refusal heuristic; `RLIMIT_AS`
remains the hard per-decoder address-space limit.

## Change and boundary

`ffmpeg_limits.run` executes a small stdlib-only Python supervisor with
`-I -S`. The fresh supervisor launches the existing resource-limit
trampoline and uses `wait4` on that child. The decoder's peak still includes
the small supervisor/trampoline footprint, conservatively. No baseline is
subtracted, no memory limit is raised, and no sampling can miss a short peak.
Concurrent decoders have distinct supervisors and distinct accounting pipes.

Only the supervisor writes a fixed 16-byte binary result: signed exit status
and unsigned peak bytes. Decoder stdout goes to `/dev/null`. Empty, malformed,
zero-peak or failed-supervisor results cannot produce a successful Outcome,
even when the caller did not request a per-frame memory check.

The supervisor and decoder share a new private process group. Timeout,
refusal, exceptions and unexpected supervisor exit stop that group. Linux
`waitid(WNOWAIT)` retains the supervisor PID until group cleanup, preventing
a PID-reuse window before `wait4` reaps it. Decoder exit and signal statuses,
heartbeats, bounded stderr, `RLIMIT_AS`, stack and thread limits are preserved.
Normal cancellation first sends SIGTERM: the supervisor kills and reaps the
decoder before exiting. A supervisor that does not respond is killed after a
one-second cleanup grace period. An abrupt supervisor crash can leave a killed
orphan awaiting container init; the regression checks it cannot keep running.
The public `limited_argv` API is unchanged. Pipeline renders that do not use
this runner are unchanged.

This is a Linux process lifecycle boundary, not a sandbox for arbitrary
executables. It assumes trusted launcher/FFmpeg binaries and no other thread
reaping these PIDs. A compromised executable that escapes its process group
requires container/cgroup isolation. Abrupt death of the entire worker still
depends on container lifecycle cleanup; this patch does not add host-wide
memory admission or prove aggregate container capacity. A small additional
interpreter remains resident while each decoder runs. Profile its overhead
and concurrent ingest/export peaks on an approved staging worker before release.

## Reproducible local validation

Use an isolated environment; the tests use synthetic files and processes only.
The real-decoder tests below use the bundled FFmpeg from `imageio-ffmpeg==0.6.0`
(7.0.2), matching the fixtures' original measurements. Installing a newer
FFmpeg is a separate compatibility check, not an equivalent runtime.

```sh
python3 -m unittest tests.test_ffmpeg_supervisor -v
python3 -m unittest tests.test_breach_media_memory -v
python3 -m unittest tests.test_media_library tests.test_render_backend
python3 -m unittest tests.test_pinned_refs tests.test_nightshift_orchestrator_monitor
git diff --check
```

The security regression file lives in `tests/security/test_decoder_rss.py`
and is imported by the normal unittest bridge. No PostgreSQL fixture or
production connection is used. Coverage includes a busy parent, independent
parallel peaks, real large allocations, a synthetic thumbnail, forged decoder
stdout, malformed accounting, exit/signal status, heartbeat, resource limits,
timeout/refusal cleanup and an injected supervisor crash.

Repository-wide validation is still required. In the existing CI run
41582309819, unrelated editor tests also failed with `Unrecognized option
'vsync'`. These failures must be reported separately; this change does not
modify editor transition logic or change the FFmpeg dependency version.

## Workflow pins and rollback

The monitor now uses the same reviewed checkout/upload-artifact SHAs as the
other workflows. Main's two older Supabase workflows receive the identical
pin-only changes already present in draft PR #647; none of that PR's runtime
or migration changes is copied into this patch. Triggers, permissions and
runner settings are unchanged.

Before deployment, rollback is simply closing this draft PR. If separately
approved and released later, revert the decoder commit as a unit (runner,
supervisor, tests and documentation). Drain active media work using the
existing approved operational procedure before replacing worker code. Reverting
restores the false-rejection risk; it does not require SQL, credit settlement,
feature flags or secret changes. The independent action-pin commit can remain.
No merge or deployment is authorized by these local results.

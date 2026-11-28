# AI Brain model benchmark and commercial eligibility

Status: P0 documentation only. Audited 2026-11-15 against source baseline
`f985b3afd371c0677357670da436ef2074fdb036`. No model selected, installed,
downloaded, served, or benchmarked on the Hetzner machine. No configuration,
production state, publishing behaviour, or provider default changes are authorized
by this document. The tables below distinguish published facts, estimates, and
proposed experiments. This is not a performance report.

## Decision and existing integration seams

Use a provider-agnostic inference contract behind the existing Python orchestration.
Do not replace the pipeline or duplicate the provider architecture. Existing seams:
capability adapters, the priced job path, and `modules/audio_mixer.py:verify_voice`.
`modules/providers.py` also defines `VoiceProvider`, `SpeechToTextProvider`, and
thin adapters, but explicitly says **NOT WIRED**: production call sites still use
concrete modules. Reuse those contract shapes where suitable; wiring them is
future implementation and cannot be represented as existing end-to-end proof.
ElevenLabs remains a premium provider, subject to the current terms/probe gates.

The merged voice-explainer engine (`modules/voice_explainer.py`,
`tools/voice_to_video.py`, `docs/VOICE_EXPLAINER.md`) already converts narration
to deterministic Remotion scenes; do not propose rebuilding it. Studio integration
PR #771 and Scribe PR #783 were reported open during the coordination audit and
are not enabled functionality at this source baseline; recheck their status
before implementation. The owner's external-STT decision is preserved: local
Whisper research must not silently replace a selected Scribe path.

The proposed text inference contract needs messages, model/revision, context and
output limits, reasoning budget, optional schema/tools/images, cancellation,
timeouts, normalized errors, and usage/latency provenance. Capability flags must be
verified against the exact runtime and artifact; an OpenAI-compatible HTTP shape
does not establish behavioural compatibility. Neither the model nor its adapter
receives provider secrets or permission to execute arbitrary commands.

One resident model can serve distinct agent contexts through a bounded queue.
Start with one inference request at a time. Agent count is not model-process count.
Context, cache keys, tool results, and retrieval remain scoped to the authorized
workspace/user/channel; KV/prefix caches must not share private tenant context.
Model switching is an explicit policy and approval decision, never a silent fallback.

## Hardware baseline and resource feasibility

The owner's current declaration is **Intel Core i7-6700, 4 cores / 8 threads,
64 GB RAM, no dedicated GPU, Ubuntu 24.04, 2 × 512 GB NVMe and 2 × 4 TB HDD**.
Earlier AX42 sizing in deployment documents is historical context, not evidence
that this machine has those resources. P0 has not inspected the production host.
Before any experiment, an authorized operator must record actual CPU flags,
MemTotal/MemAvailable, filesystem capacity, RAID layout, competing workloads,
container limits and idle/peak consumption without collecting secrets.

Bytes and units matter: 1 GB = 1,000,000,000 bytes; 1 GiB = 1,073,741,824 bytes.
If 64 GB means decimal bytes it is about 59.6 GiB; a marketed 64 GB DIMM capacity
may instead be reported near 64 GiB before system deductions. Record actual bytes.
Disk counts do not establish usable capacity or redundancy; do not assume 1 TB
NVMe / 8 TB HDD usable before verifying RAID and filesystem layout.

`deploy/docker-compose.yml` currently declares worker `mem_limit: 48g` (48 GiB
under Docker memory-unit interpretation). A cap is a maximum, not measured usage
or a reservation. Allowing that worker to approach its cap while a separate
24 GiB resident inference service runs is incompatible with a roughly 64 GB host,
before the app, OS and other services. Do not add these services under unchanged
limits and assume memory safety. P0 changes no limit.

The same source Compose file declares web 2g, media-worker 4g, creative-worker 2g,
notify/email/operator/marketing workers 256m each, and brand-scan-worker 1536m.
Caddy has no explicit memory cap here. Profiles and production switches determine
which services run; repository limits do not prove deployment or actual usage.
The listed capped services sum to about 58.5 GiB before Caddy/OS or a new LLM, if
all are admitted at their caps. Review the entire concurrent envelope, not only
the pipeline worker. No production switches were inspected.

Previous audit worksheet: 16 units app/OS, 24 LLM, 8 transient audio/render, 16
headroom. This is an unvalidated 64-unit sketch, not a deployable allocation:
units must first be normalized and it cannot consume every byte of a nominal
64 GB host. Headroom is counted once, outside workload caps; it is not a second
usable pool. A valid future envelope satisfies:

```
OS + baseline services + admitted concurrent workload budgets + one headroom budget
    < measured usable host RAM
```

As an illustrative conservative worksheet only, if actual usable RAM permits it,
10 GiB baseline + 20 GiB inference peak + 8 GiB transient peak + 12 GiB headroom
= 50 GiB, leaving further slack. These are hypotheses, not observed consumption
or approved cgroup limits. Replace them with measured worst-case peaks and
reviewed admission limits. If they do not fit, shrink context/model size or keep
inference off the host. Do not rely on swap to make interactive inference viable.

Initially do not admit CPU-heavy render and inference simultaneously; coordinate
Whisper/TTS jobs as well. A resident model still consumes RAM when compute is idle.
Unload/reload or reduce admission if render's measured peak cannot coexist with
resident weights. Test 1/2/4 physical inference threads; compare 8 logical threads
only as an experiment. CPU shares/weights prioritize contention and do not reserve
cores. Any later CPU quota/cpuset decision needs host measurements and an approved
configuration change. Keep weights and scratch on NVMe; archive media on HDD only
after storage layout and recovery requirements are confirmed.

## Candidate matrix: published capability, not local proof

Sources were inspected on 2026-11-15. These are verified current candidates, not a
claim of an exhaustive newest-model catalog. Pin the exact revision before use.
No i7-6700 tokens/second result was found or measured for these candidates.

| Candidate | License / commercial condition | JSON and tools | Creative / multimodal scope | Memory evidence |
| --- | --- | --- | --- | --- |
| Ternary Bonsai 2 27B, official stable GGUF | Apache-2.0; retain required notices and verify exact artifact/dependencies | Tool-capable model; schema constraints depend on runtime/template; backend validation required | Reasoning/text and optional vision; Nightshift creative quality unmeasured | Language files 5.95 GB PTQ1_0, 7.21 GB PQ2_0, 7.63 GB stock Q2_0; optional Q8 vision pack 0.63 GB; not total RAM |
| Qwen3.8-27B | Apache-2.0 for inspected official artifact | Agent/tool support; schema enforcement is serving-runtime capability | Text/images and reasoning; compare script/storyboard quality locally | Dense Q4 theoretical payload about 13.5 GB plus format overhead, KV and scratch; not an artifact/RSS measurement |
| Qwen3.6-35B-A3B | Apache-2.0 for inspected official artifact | Tool/template and structured decoding conformance must be tested | Multimodal MoE; about 3B active parameters is not total resident weights | Q4 theoretical payload about 17.5 GB plus overhead; all expert weights still need storage/residency planning |
| Gemma 4 26B A4B instruction-tuned | Apache-2.0; older Gemma custom terms must not be applied to Gemma 4 | Native function calling; JSON Schema acceptance still runtime-specific | Text/image/video frames, thinking; no audio input for this 26B variant; creativity unmeasured | Google's Q4_0 GPU/TPU estimate is 14.4 GB, not CPU RSS; KV/context overhead must be measured |
| GPT-OSS-20B | Apache-2.0 and published gpt-oss usage policy | Native function calling/Structured Outputs; correct Harmony formatting required | Text-only reasoning MoE; creative and multilingual quality unmeasured | Official MXFP4 claim: within 16 GB memory; CPU runtime expansion/overhead not measured |

Qwen3.8 and Gemma 4 are additional quality candidates beyond older Qwen/Gemma
families; MoE candidates may improve compute economics but are not automatically
faster or better on this CPU. GPT-OSS-120B's official 80 GB GPU target excludes it
from the initial shared 64 GB-host shortlist; a differently quantized artifact
would require separate eligibility, quality and memory evidence. CPU-only image
or video diffusion is not part of the promised production capability.

Primary sources:

- [Bonsai stable card and exact packing/runtime table](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf).
- [PrismML release, 2026-09-17](https://prismml.com/news/prismml-launches-bonsai-2-27b).
- [Qwen3.8-27B official card](https://huggingface.co/Qwen/Qwen3.8-27B) and
  [Qwen3.6-35B-A3B official card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B).
- [Gemma overview and memory estimates](https://ai.google.dev/gemma/docs/core),
  [official 26B A4B card](https://huggingface.co/google/gemma-4-26B-A4B-it),
  [Gemma 4 Apache license](https://ai.google.dev/gemma/apache_2).
- [OpenAI GPT-OSS-20B card](https://huggingface.co/openai/gpt-oss-20b) and
  [OpenAI license/usage-policy overview](https://help.openai.com/en/articles/11870455-openai-open-weight-models-gpt-oss).

### Bonsai runtime qualification

The stable artifact is `prism-ml/Ternary-Bonsai-2-27B-gguf`, not its `-dev`
variant or an unrelated community conversion. PTQ1_0 and PQ2_0 require the
PrismML ternary-kernel fork; stock Q2_0 needs llama.cpp **b11556 or newer**.
The card warns older stock builds can load Q2_0 but produce incorrect text.
Record the runtime SHA and run known-answer/template checks before timing it.
The smallest file is not necessarily the fastest CPU representation.
Advertised RTX 5090 or Apple Metal throughput is not i7 throughput. Published
aggregate retention scores do not establish Uzbek scripts, latency or safety.

The model card's default high reasoning budget can spend substantial time before
the final answer. Benchmark thinking and non-thinking modes separately; record
all generated tokens and time, not just final visible tokens. Do not promise a
low-reasoning mode unsupported by the exact model/template.

### JSON Schema and tool safety

JSON syntax, schema conformance, tool selection, and permitted tool execution are
separate acceptance checks. llama.cpp converts a subset of JSON Schema to grammar;
not every schema keyword is a decoding guarantee. See the
[runtime schema converter](https://github.com/ggml-org/llama.cpp/blob/master/common/json-schema.h).
The backend validates the full schema, sizes/ranges, ownership and policy after
generation. Invalid output is rejected or retried under a bounded budget. No
schema-conformant proposal bypasses approval, financial or tenant checks.

## Reproducible benchmark proposal

This protocol requires separate execution approval; P0 does not run it.

1. Record host baseline, allowed time window, artifact hash/license, runtime and
   template hashes, build flags, model packing, context, thread count, seed,
   sampling and reasoning settings. Do not benchmark on unreviewed downloads or
   execute upstream piped installers. Use synthetic/de-identified fixtures.
2. Establish app-only latency/health and idle/peak RAM. Benchmark one model at a
   time with GPU offload zero, concurrency one, no heavy render/STT/TTS alongside.
3. Test cold and warm loads, 512/2K/8K input tokens and 128/512/2K output budgets;
   include long-context overflow and cancellation. Use at least five repeated
   runs per timing cell, recording variance. Larger samples are required before
   treating p95 as a stable production estimate.
4. Capture queue wait, load time, TTFT, prefill/decode tokens per second, total
   generated reasoning/final tokens, time to valid final artifact, peak RSS and
   cgroup memory, CPU utilization, faults/swap, errors, retries and provider usage.
5. Run at least 90 task fixtures across Uzbek, Russian and English: scripts/hooks,
   storyboards, character/brand consistency, grounded research, SEO, comment
   triage/replies, generation plans/cost boundaries and malformed tool proposals.
   Include screenshot/thumbnail fixtures only for a qualified vision runtime.
6. Include prompt injection in comments/retrieved pages, cross-tenant retrieval,
   unauthorized actions, stale approvals, unavailable models, budget exhaustion,
   duplicate requests, interrupted jobs and schema rejection. Policy must block
   unsafe actions irrespective of model quality. No real external action occurs.
7. Native-language human reviewers blind-score originality, coherence, brand
   fidelity, language naturalness and grounding. Compare equivalent tasks against
   an explicitly approved paid-provider baseline, including retries and cost.
8. Only after single-job qualification, test bounded bursts and queue starvation;
   separately measure render/inference scheduling transitions and resident-memory
   coexistence. Do not enable simultaneous heavy execution by default.

### Proposed SLOs to ratify before testing

These are product targets to accept or revise, not measured promises:

| Work class | Proposed acceptance target | Failure disposition |
| --- | --- | --- |
| Short comment classification/draft, bounded 2K input / 256 output | Warm p95 time to validated artifact <= 60 s; interactive acknowledgement <= 2 s through existing app | Queue/background UX or explicitly approved alternative; no silent substitution |
| Script/storyboard planning, bounded 8K input / 2K output | p95 completion <= 10 min with visible queued/running status and cancellation | Reduce scope or propose approved provider/capacity change |
| Structured output | >= 99% valid schema on agreed fixture corpus within at most one budgeted retry; all invalid outputs blocked | Candidate fails affected task class |
| Safety/tenant/financial boundary | Zero unauthorized effects or cross-tenant disclosures in adversarial corpus | Block rollout and investigate; a finite corpus is not a security proof |
| Creative quality | Blind median >= 4/5 and no material regression against approved baseline for each supported language | Restrict task/language or retain approved premium route |
| Resource isolation | No OOM/swap thrashing, app health within agreed baseline tolerance, measured peaks within reviewed envelope | Reject shared-host deployment or adjust approved capacity |

Record sample sizes and confidence limits; do not represent a five-run percentile
as a statistically established production SLO. Agent multiplicity adds queue wait:
arrival rate × average service time must stay below sustained service capacity,
with slack for bursts. A model that fits RAM can still fail usability.

## Cost worksheet and sensitivity

No current Hetzner tariff, paid-model token tariff, electricity rate or guaranteed
savings is asserted. Obtain dated first-party rates and actual invoice terms.
Separate customer credit/service price from admin-only provider cost and margin.
No internal cost or profit appears in customer estimates.

```
API task cost = sum over every attempt (
  input_tokens / 1e6 * input_rate + output_tokens / 1e6 * output_rate
  + billed_tool_units * tool_rate + billed_media_units * media_rate)
local monthly incremental cost = incremental hosting + storage/backups
  + monitoring + attributable operations + incremental electricity if separately billed
cost per successful task = all attributable costs / accepted successful tasks
break-even successful task count = incremental local fixed cost /
  (API expected cost per accepted task - local variable cost per accepted task)
```

Break-even is undefined if the denominator is zero/negative, or if quality/SLO
fails. Count failed attempts, retries, idle capacity, cold loads and reasoning
tokens. Existing server rent may be sunk for a short-term marginal comparison;
also show an allocated-capacity view so displaced render workload is not hidden.
Do not add electricity twice when a dedicated-server tariff already includes it.

Illustration only, not a tariff or throughput prediction: a task with 2,000 input
and 2,000 billed output tokens at hypothetical $0.20/M input and $1.00/M output
costs $0.0024 per attempt. At 1,000 accepted tasks and a hypothetical 10% extra
full-cost attempts, that is $2.64. A hypothetical incremental local fixed cost
of $20/month would not save money on that workload. Different real rates,
volumes, quality and retry patterns can reverse the comparison.

Sensitivity illustration: at hypothetical decode rates of 5/10/20 tokens/s,
2,000 generated tokens take 400/200/100 seconds before adding prefill, reasoning
outside that token budget, queue wait and retries. These are arithmetic scenarios,
not benchmark results. Recalculate cost and latency at measured low/median/high
throughput, arrival volumes, context lengths and retry rates. Document which
tasks fit locally and which require an explicitly approved premium route.

## Voice eligibility and the existing VoiceStudio audit

Extend [the existing OSS audit](research/oss-alternatives-2026-10.md), rather than
creating a second independent verdict. Its default-weight commercial block still
holds: current [VoiceStudio LICENSE-NOTICE](https://github.com/debpalash/VoiceStudio/blob/main/LICENSE-NOTICE.md)
states AGPL-3.0 covers the application, default OmniVoice weights are CC-BY-NC,
and the tokenizer has separate Boson Higgs Audio/Llama terms. Buying a commercial
application license does not clear third-party model assets. AGPL itself permits
commercial use; modification/network-source obligations require review.

Audit delta: the old statement that VoiceStudio requires a GPU is stale. Its
[current README](https://github.com/debpalash/VoiceStudio) supports Linux CPU and
CPU Docker, with slower performance. This is not evidence of acceptable i7 speed,
commercial clearance, or complete consent enforcement. Do not install the default
bundle into production or replace an explicitly configured ElevenLabs voice.

Proposed component allowlist review (all local entries remain disabled pending
exact revision/dependency, license, consent, quality and CPU qualification):

| Function | Candidate / existing seam | Eligibility and qualification |
| --- | --- | --- |
| Standard TTS | Kokoro-82M via voice adapter | Official weights Apache-2.0; inspect voices, G2P/runtime dependencies and required notices; test supported languages; not a clone/design replacement |
| Voice cloning | Qwen3-TTS 1.7B Base | Official artifact Apache-2.0; verify tokenizer/dependencies and consent/ownership, retention, revocation and user scoping; CPU speed unknown |
| Voice design | Qwen3-TTS 1.7B VoiceDesign | Official artifact Apache-2.0; qualify output rights/identity policy and quality; do not claim Uzbek support from its ten-language list |
| Transcription | Existing concrete Whisper path; shape-only SpeechToTextProvider; separately selected Scribe integration | Whisper code and weights MIT; benchmark WER/timing per language; preserve the owner's external-STT/Scribe choice and current provider gates; no automatic replacement |
| Dubbing | Orchestrate approved STT -> translation -> consented TTS -> alignment -> mux | No single blanket dubbing license; every translation/alignment/runtime/model component requires an exact reviewed entry; reject NC/unresolved components |
| Premium audio | Existing ElevenLabs provider | Retain configured provider, plan entitlements and consent checks; no automatic free/local fallback |

Sources: [Kokoro official card](https://huggingface.co/hexgrad/Kokoro-82M),
[Qwen3-TTS Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base),
[Qwen3-TTS VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign),
[Whisper license statement](https://github.com/openai/whisper).
Qwen's listed ten TTS languages include English and Russian, not Uzbek. CUDA
latency claims do not establish CPU latency. Preserve existing `voice_usable_by`
and append-only consent trail described in `CUSTOM_VOICE.md` across every adapter.
Also extend, rather than supersede, `research/ELEVENLABS_STUDIO.md` (2026-11-14):
its commercial plan, model-language, voice-retirement, registry/probe and terms
gates remain dependencies. API adapters or merged engine code do not prove that
a particular paid audio model is live, licensed for this SaaS, or approved.

## Evidence record and decision gate

Each future candidate record must contain:

```
candidate_id / task_classes / languages:
artifact repository / immutable revision / file SHA256 / packing:
license source and revision / dependency and tokenizer review / notices:
runtime commit / template hash / build flags / CPU flags:
host usable bytes / baseline peak / reviewed caps / admission policy:
context / threads / reasoning / sampling / concurrency:
fixture revision / repetitions / raw timing and memory evidence:
schema pass rate / tool correctness / safety failures / human quality scores:
queue wait / TTFT / time-to-valid-artifact p50,p95 / peak RSS,cgroup memory:
input,reasoning,final tokens / errors,retries / cost basis and dated rates:
known limitations / recommendation / reviewer / owner decision:
```

Unknown fields remain unknown, never zero. No candidate becomes selectable merely
because a card exists. A successful real adapter call, reliable job lifecycle,
license clearance, reviewed policy limits and owner-approved selection are required.
Changing model, runtime capability, generation plan or customer price invalidates
the affected prior approval; never substitute an unavailable model invisibly.

P0 dependencies before execution: owner-approved host access/test window and
resource envelope; immutable licensed artifacts; de-identified fixture corpus;
policy/tenant boundaries; cost/approval contract; approved SLOs; runtime supply-chain
review; and a separate reviewed change for service configuration. P0 completion
means this plan is reviewable. It does not mean CPU feasibility, savings, quality,
commercial eligibility of an entire stack, or production readiness has been proven.

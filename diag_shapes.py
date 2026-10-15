import sys, os, json, subprocess, threading, time, collections, platform, tempfile, resource
sys.path.insert(0, ".")
from pathlib import Path
from PIL import Image
from modules import timeline as tl, timeline_render as tr, ffmpeg_limits as fl, render_backend as rb
exe = rb.resolve_ffmpeg()
print("python", sys.version.split()[0], "platform", platform.platform(), "cpus", os.cpu_count(), len(os.sched_getaffinity(0)))
print("ulimit -s", resource.getrlimit(resource.RLIMIT_STACK), "ulimit -v", resource.getrlimit(resource.RLIMIT_AS))
print(subprocess.run([exe, "-version"], capture_output=True, text=True).stdout.splitlines()[0])
ci = open("/proc/cpuinfo").read()
print([l for l in ci.splitlines() if "model name" in l][0], "avx512" in ci)
for f in ("/sys/kernel/mm/transparent_hugepage/enabled", "/proc/sys/vm/overcommit_memory", "/proc/sys/vm/max_map_count"):
    try: print(f, open(f).read().strip())
    except Exception as e: print(f, e)
print("env", {k: v for k, v in os.environ.items() if k.startswith(("MALLOC", "OMP", "LD_", "X264", "FF"))})
B = "11111111-1111-4111-8111-111111111111"; P = "33333333-3333-4333-8333-333333333333"
W, H, fps, secs = 1920, 1080, 60, 2
d = Path(tempfile.mkdtemp())
base = d / "b.mp4"
subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x336699:s={W}x{H}:r={fps}:d={secs}", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(base)], check=True)
png = d / "p.png"; Image.new("RGBA", (W, H), (255, 200, 0, 200)).save(png)
table = {B: tl.ResolvedAsset(B, "video", str(base), float(secs), False), P: tl.ResolvedAsset(P, "image", str(png), None, None)}
def doc(n_shapes, n_pics, w=1.0):
    x = {"version": 1, "width": W, "height": H, "fps": fps, "tracks": [{"id": "v1", "kind": "V", "clips": [{"id": "c1", "asset_id": B, "start_s": 0, "in_s": 0, "out_s": secs}]}]}
    x["shapes"] = [{"id": f"s{i}", "kind": "circle", "start_s": 0, "end_s": 3, "x": 0.5, "y": 0.5, "w": w, "opacity": 1.0} for i in range(n_shapes)]
    if n_pics: x["overlays"] = [{"id": f"o{i}", "asset_id": P, "start_s": 0, "end_s": secs, "w": 1.0, "anim_in": "pop", "move": {"to": {"x": 0.4}}} for i in range(n_pics)]
    return x
best = {"peak": 0}; stop = False
def poll():
    me = os.getpid()
    while not stop:
        for pid in os.listdir("/proc"):
            if not pid.isdigit(): continue
            try:
                if int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[1]) != me: continue
                cmd = open(f"/proc/{pid}/cmdline").read().split("\0")
                if "-filter_complex" not in cmd: continue
                st = dict(l.split(":", 1) for l in open(f"/proc/{pid}/status").read().splitlines() if ":" in l)
                pk = int(st["VmPeak"].split()[0]) // 1024
                if pk > best["peak"]:
                    best.update(peak=pk, threads=int(st["Threads"]), comm=dict(collections.Counter(open(f"/proc/{pid}/task/{t}/comm").read().strip()[:14] for t in os.listdir(f"/proc/{pid}/task"))), maps=open(f"/proc/{pid}/maps").read())
            except Exception: pass
        time.sleep(0.003)
threading.Thread(target=poll, daemon=True).start()
def go(n_shapes, n_pics, mem_mb, w=1.0):
    best.clear(); best["peak"] = 0
    fl.CHILD_MEM_BYTES = mem_mb * 2**20
    try:
        tr.render(doc(n_shapes, n_pics, w), table.get, str(d / "o.mp4"), ffmpeg=exe, jobs=1, timeout_s=300); ok = "ok"
    except Exception as e: ok = "FAIL " + str(e)[-80:].replace("\n", " ")
    tot = collections.Counter()
    for l in best.get("maps", "").splitlines():
        p = l.split(); lo, hi = [int(x, 16) for x in p[0].split("-")]
        tot[p[5] if len(p) > 5 and p[5].startswith("[") else ("exe" if len(p) > 5 else "anon")] += (hi - lo) / 2**20
    print(f"shapes={n_shapes} pics={n_pics} limit={mem_mb}: {ok}; VmPeak={best['peak']} threads={best.get('threads')} {dict((k, round(v)) for k, v in tot.items())} {best.get('comm')}", flush=True)
for mem in (8192, 2048, 2300, 2600):
    go(8, 8, mem)
for mem in (8192, 2048):
    go(8, 0, mem); go(0, 8, mem); go(12, 0, mem, 0.8); go(8, 4, mem)
print("repeat 2048 x5:")
for _ in range(5): go(8, 8, 2048)

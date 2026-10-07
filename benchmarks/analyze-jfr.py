"""Summarize JFR JSON exported with jfr print; no third-party dependencies."""
import collections
import json
import re
import sys
import os
import subprocess
from pathlib import Path

source = Path(sys.argv[1])
output = Path(sys.argv[2]) if len(sys.argv) > 2 else source.with_name("jfr-summary.json")
recording_summary = None
if source.suffix.lower() == ".jfr":
    binary = "jfr.exe" if os.name == "nt" else "jfr"
    java_home = os.environ.get("JAVA_HOME")
    tool = str(Path(java_home) / "bin" / binary) if java_home else binary
    recording_summary = subprocess.run([tool, "summary", str(source)], check=True,
        capture_output=True, text=True, timeout=60).stdout
    exported = source.with_suffix(".events.json")
    with exported.open("wb") as stream:
        subprocess.run([tool, "print", "--json", "--stack-depth", "1", "--events",
            "jdk.ExecutionSample,jdk.ObjectAllocationSample,jdk.JavaMonitorEnter,jdk.ThreadPark,jdk.GarbageCollection,jdk.DataLoss",
            str(source)], stdout=stream, check=True, timeout=120)
    source = exported
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else source.with_name("jfr-summary.json")
events = json.loads(source.read_text(encoding="utf-8-sig"))["recording"]["events"]
counts = collections.Counter()
execution = collections.Counter()
allocation_types = collections.Counter()
allocation_frames = collections.Counter()
parks = collections.Counter()
monitors = collections.Counter()
gc = []

def frame_name(frame):
    method = frame.get("method") or {}
    return (method.get("type") or {}).get("name", "?").replace("/", ".") + "." + method.get("name", "?")

def first_frame(values):
    frames = (values.get("stackTrace") or {}).get("frames", [])
    return frame_name(frames[0]) if frames else "(no stack)"

def seconds(value):
    if isinstance(value, (int, float)):
        return value
    match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", value or "")
    if not match:
        raise ValueError("Unsupported JFR duration: " + str(value))
    h, m, s = match.groups()
    return float(h or 0) * 3600 + float(m or 0) * 60 + float(s or 0)

for event in events:
    kind, values = event["type"], event["values"]
    counts[kind] += 1
    if kind == "jdk.ExecutionSample":
        execution[first_frame(values)] += 1
    elif kind == "jdk.ObjectAllocationSample":
        weight = values["weight"]
        allocation_types[(values.get("objectClass") or {}).get("name", "?").replace("/", ".")] += weight
        allocation_frames[first_frame(values)] += weight
    elif kind == "jdk.ThreadPark":
        parks[(values.get("eventThread") or {}).get("javaName", "?")] += seconds(values["duration"])
    elif kind == "jdk.JavaMonitorEnter":
        monitors[first_frame(values)] += seconds(values["duration"])
    elif kind == "jdk.GarbageCollection":
        gc.append({"name": values.get("name"), "cause": values.get("cause"),
                   "durationSeconds": seconds(values["duration"]),
                   "pauseSeconds": seconds(values["sumOfPauses"]),
                   "longestPauseSeconds": seconds(values["longestPause"])})

result = {
    "recordingSummary": recording_summary,
    "eventCounts": dict(counts),
    "executionTopFrames": execution.most_common(20),
    "allocationWeightedBytesByClass": allocation_types.most_common(20),
    "allocationWeightedBytesByTopFrame": allocation_frames.most_common(20),
    "allocationWeightedBytesTotal": sum(allocation_types.values()),
    "threadParkSecondsByThread": parks.most_common(20),
    "monitorEnterSecondsByTopFrame": monitors.most_common(20),
    "gc": gc,
    "gcPauseSecondsTotal": sum(item["pauseSeconds"] for item in gc),
    "gcLongestPauseSeconds": max((item["longestPauseSeconds"] for item in gc), default=0),
    "interpretation": [
        "ExecutionSample counts are samples, not exact CPU time or an attribution of end-to-end latency.",
        "AllocationSample weights estimate allocation; they are not retained heap measurements.",
        "Park/monitor durations sum across threads and may exceed recording wall time.",
        "A waiting worker or event loop is not by itself a bottleneck."
    ]
}
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"events": dict(counts), "gcPauseSecondsTotal": result["gcPauseSecondsTotal"],
                  "gcLongestPauseSeconds": result["gcLongestPauseSeconds"]}))

"""Summarize explicit stability runs, preserving cold failures and separate interventions."""
import argparse,json,re,statistics,xml.etree.ElementTree as ET
from pathlib import Path
from datetime import datetime

def utc(s): return datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
def extent(values):
    v=[x for x in values if x is not None]
    return {"min":min(v),"median":statistics.median(v),"max":max(v),"first":v[0],"last":v[-1]} if v else {}
def smaps(raw):
    rows=[];row=None
    for line in raw.splitlines():
        m=re.match(r'^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\d+\s*(.*)$',line)
        if m:
            row={"start":int(m[1],16),"end":int(m[2],16),"permissions":m[3],"path":m[4]};rows.append(row)
        elif row is not None:
            m=re.match(r'^(\w+):\s+(\d+)\s+kB$',line)
            if m:row[m[1]+"KiB"]=int(m[2])
    return rows
def memory_checkpoint(checkpoint):
    d=Path(checkpoint["output"])
    get=lambda n:(d/("A-"+n+".txt")).read_text(encoding="utf-8-sig")
    nmt=get("VM-native_memory")
    categories={m[0].strip():{"reservedKiB":int(m[1]),"committedKiB":int(m[2])}
                for m in re.findall(r"^-\s+(.+?)\s+\(reserved=(\d+)KB, committed=(\d+)KB\)",nmt,re.M)}
    total=re.search(r"Total: reserved=(\d+)KB, committed=(\d+)KB",nmt)
    malloc_nmt=re.search(r"^\s*malloc:\s*(\d+)KB",nmt,re.M)
    info=get("GC-heap_info")
    heap=re.search(r"total (\d+)K, used (\d+)K \[(0x[0-9a-f]+), (0x[0-9a-f]+)\)",info)
    assert heap,info
    lo,hi=int(heap[3],16),int(heap[4],16)
    code=get("Compiler-codecache")
    bounds=[(int(m[0],16),int(m[2],16)) for m in re.findall(r"bounds \[(0x[0-9a-f]+), (0x[0-9a-f]+), (0x[0-9a-f]+)\]",code)]
    mappings=smaps(get("smaps"));groups={}
    for row in mappings:
        overlaps=lambda a,b:row["start"]<b and row["end"]>a
        if overlaps(lo,hi):
            assert lo<=row["start"] and row["end"]<=hi,"Heap VMA overlaps unknown region"
            group="javaHeap"
        elif any(overlaps(a,b) for a,b in bounds):group="codeCache"
        elif row["path"].startswith("/"):group="file"
        elif row["path"]=="[heap]":group="mainCHeap"
        elif row["path"].startswith("[stack"):group="stack"
        else:group="otherAnonymous"
        g=groups.setdefault(group,{"rssKiB":0,"privateDirtyKiB":0,"sizeKiB":0})
        for a,b in [("rssKiB","RssKiB"),("privateDirtyKiB","Private_DirtyKiB"),("sizeKiB","SizeKiB")]:g[a]+=row.get(b,0)
    raw=get("System-native_heap_info");xml=ET.fromstring(raw[raw.index("<malloc"):])
    top=lambda name,typ:int(xml.find(f'{name}[@type="{typ}"]').attrib["size"])
    allocator={"arenas":len(xml.findall("heap")),"systemCurrentBytes":top("system","current"),
               "freeBinBytes":top("total","fast")+top("total","rest"),"mmapBytes":top("total","mmap")}
    allocator["notInFreeBinsEstimateBytes"]=allocator["systemCurrentBytes"]-allocator["freeBinBytes"]+allocator["mmapBytes"]
    rss=int(re.search(r"^Rss:\s+(\d+)",get("smaps-rollup"),re.M)[1])
    return {"label":checkpoint["label"],"at":checkpoint["completedAt"],"rssKiB":rss,
            "heapUsedKiB":int(heap[2]),"heapCommittedKiB":int(heap[1]),
            "nmtReservedKiB":int(total[1]),"nmtCommittedKiB":int(total[2]),
            "nmtMallocKiB":int(malloc_nmt[1]),"nmtCategories":categories,"mappedMemory":groups,"allocator":allocator,
            "snapshotSkewNote":"Diagnostic files are sequential observations, not an atomic memory snapshot."}

def summarize(path):
    r=json.loads(path.read_text(encoding="utf-8-sig"))
    result={"source":str(path.resolve()),"phase":r["phase"],"config":r["config"],"jar":r["jar"],
            "executionPassed":r["passed"],"error":r.get("error"),"cleanup":r.get("cleanup"),
            "stages":[],"memory":[memory_checkpoint(x) for x in r.get("memoryCheckpoints",[]) if "completedAt" in x],
            "diagnosticInterventions":r.get("diagnosticInterventions",[])}
    for t in r["stages"]:
        row={"name":t["name"],"startedAt":t.get("driverStartedAt",t["startedAt"]),"durationSeconds":t["durationSeconds"],
             "assessment":t.get("assessment"),"accounting":t.get("accounting"),"readyToDriverMs":t.get("readyToDriverMs")}
        if "result" in t:
            row["load"]={k:t["result"][k] for k in ["offered","issued","finished","schedulerMisses","capacityMisses","statuses",
                "transportErrors","statusLatencyMs","successfulRequestsPerSecond","segmentStats","firstFailures"]}
        if "result" in t:
            driver=t["result"]["samples"]
            row["driverObservations"]={"cpuCores":extent([x["cpuCores"] for x in driver]),
              "eventLoopP99Ms":extent([x["eventLoopP99Ms"] for x in driver]),
              "inFlight":extent([x["inFlight"] for x in driver]),
              "rssMiB":extent([x["rss"]/1048576 for x in driver]),
              "requestsPerSecond":extent([x["requestsPerSecond"] for x in driver])}
        row["resources"]={}
        for label in sorted({x["label"] for x in t["samples"]}):
            v=[x for x in t["samples"] if x["label"]==label]
            reasons=v[-1]["jvm"]["proxyOutcomes"] if v else {}
            changes=[]
            for previous,current in zip(v,v[1:]):
                outcomes=lambda x:sum(x["limiter"]["outcomes"].get(k,0) for k in ["redis_fail_open","local_fail_open"])
                change=outcomes(current)-outcomes(previous)
                if change:
                    changes.append({"from":previous["at"],"to":current["at"],"newFailOpen":change,
                      "gcPauseDeltaSeconds":(current["jvm"]["gcPauseSeconds"] or 0)-(previous["jvm"]["gcPauseSeconds"] or 0),
                      "cpuFraction":current["jvm"]["cpuFraction"],"queueSample":current["limiter"]["queued"],
                      "transportState":current["limiter"]["transportState"]})
            row.setdefault("failOpenObservationIntervals",{})[label]=changes
            row["resources"][label]={"rssMiB":extent([x["processMemory"]["rssBytes"]/1048576 for x in v if "processMemory" in x]),
                "heapMiB":extent([x["jvm"]["heapBytes"]/1048576 for x in v]),
                "directMiB":extent([x["jvm"]["directBytes"]/1048576 for x in v]),
                "threads":extent([x["jvm"]["threads"] for x in v]),
                "nonHeapMiB":extent([x["jvm"]["nonHeapBytes"]/1048576 for x in v]),
                "heapCommittedMiB":extent([x["jvm"]["heapCommitted"]/1048576 for x in v]),
                "cpuFraction":extent([x["jvm"]["cpuFraction"] for x in v]),
                "openFiles":extent([x["jvm"]["openFiles"] for x in v]),
                "gcPauseSecondsCumulative":extent([x["jvm"]["gcPauseSeconds"] for x in v]),
                "gcCountCumulative":extent([x["jvm"]["gcCount"] for x in v]),
                "auditPending":extent([x["audit"]["pending"] for x in v]),
                "limiterQueued":extent([x["limiter"]["queued"] for x in v]),
                "poolActive":extent([x["proxy"]["pool"].get("active.connections",0) for x in v]),
                "poolPending":extent([x["proxy"]["pool"].get("pending.connections",0) for x in v]),
                "proxyReasonsCumulativeLastSample":reasons}
            if t["durationSeconds"]>=3600:
                windows=[]
                start=utc(row["startedAt"])
                for k in range(0,t["durationSeconds"],600):
                    part=[x for x in v if k<=utc(x["at"])-start<k+600]
                    windows.append({"startSeconds":k,
                      "rssMiB":extent([x["processMemory"]["rssBytes"]/1048576 for x in part if "processMemory" in x]),
                      "heapMiB":extent([x["jvm"]["heapBytes"]/1048576 for x in part]),
                      "directMiB":extent([x["jvm"]["directBytes"]/1048576 for x in part]),
                      "threads":extent([x["jvm"]["threads"] for x in part])})
                row["resources"][label]["tenMinuteWindows"]=windows
        result["stages"].append(row)
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument("reports",nargs="+",type=Path);p.add_argument("--output",required=True,type=Path);a=p.parse_args()
    if a.output.exists():raise SystemExit("Refusing to overwrite an existing analysis")
    runs=[summarize(p) for p in a.reports]
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps({"runs":runs,"interpretation":[
      "Immediate and gradual whole-run latency distributions have different offered-load mixes; compare common target segment counts.",
      "Cold 503 and fail-open counts are preserved; ready is not a claim of peak steady-state capacity.",
      "Allocator free-bin sizes are not exact resident bytes; NMT is not a complete process accounting.",
      "Trim/GC are after measured load and idle; they are diagnostic interventions, not application behavior.",
      "A 60-minute observation is not proof against all leaks or production sizing."]},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(a.output),"runs":len(runs)}))
if __name__=="__main__":main()

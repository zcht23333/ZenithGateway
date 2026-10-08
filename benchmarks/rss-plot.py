"""Render read-only RSS analysis as standalone scientific figures (PNG + SVG).
Usage: python benchmarks/rss-plot.py <rss-report output directory>
"""
import json
import sys
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

folder = Path(sys.argv[1]).resolve()
analysis = json.loads((folder / 'analysis.json').read_text(encoding='utf-8'))
series = json.loads((folder / 'series.json').read_text(encoding='utf-8'))
gc = json.loads((folder / 'gc.json').read_text(encoding='utf-8'))
mib = 1048576
stamp = lambda x: datetime.fromisoformat(x.replace('Z', '+00:00')).timestamp()
origin = stamp(series[0]['at'])
minute = lambda x: (stamp(x) - origin) / 60
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 10, 'axes.spines.top': False,
                     'axes.spines.right': False, 'svg.fonttype': 'none'})
fig, axes = plt.subplots(3, 2, figsize=(16, 13), constrained_layout=True)
rss = [s for s in series if s.get('processMemory')]
times = [minute(s['at']) for s in series]
checkpoints = [c for c in analysis['checkpoints'] if 'smaps' in c]
ct = [minute(c['at']) for c in checkpoints]
def line(ax, values, label, **kw):
    ax.plot(times, values, label=label, linewidth=1.2, **kw)
def cp_line(ax, values, label, **kw):
    kw.pop('linestyle', None)
    ax.plot(ct, values, marker='o', markersize=4, linestyle='none', label=label, **kw)
def decorate(ax, title, ylabel):
    ax.set_title(title, loc='left', fontweight='bold', pad=12)
    ax.set_ylabel(ylabel); ax.set_xlabel('Minutes since first warmup sample')
    ax.grid(alpha=.18); ax.legend(loc='best', fontsize=9)
    for s in analysis['stages']:
        if s['kind'] in ('soak', 'recovery', 'idle') and s['to']:
            a, b = minute(s['from']), minute(s['to'])
            ax.axvspan(a, b, color={'soak': '#319c64', 'recovery': '#d6ae41', 'idle': '#759bbd'}[s['kind']], alpha=.055)
            ax.axvline(a, color='#777777', linestyle=':', alpha=.35)
    if analysis.get('nativeTrim'):
        intervention = minute(analysis['nativeTrim']['startedAt'])
        ax.axvline(intervention, color='#b04474', linewidth=1.5)
        ax.axvspan(intervention, max(times), color='#b04474', alpha=.06)
    ax.set_xlim(min(times), max(times))

ax = axes[0, 0]
ax.plot([minute(s['at']) for s in rss], [s['processMemory']['rssBytes']/mib for s in rss], label='Process RSS', color='#146d9f')
ax.plot([minute(s['at']) for s in rss], [s['processMemory']['cgroupBytes']/mib for s in rss], label='Cgroup memory.current', color='#c87923')
cp_line(ax, [c['nmt']['committedBytes']/mib for c in checkpoints], 'NMT committed (overlaps RSS)', color='#878787', linestyle='--')
decorate(ax, '1  Different accounting views — do not add', 'MiB')

ax = axes[0, 1]
line(ax, [s['jvm']['heapBytes']/mib for s in series], 'Heap used', color='#a2c2cd', alpha=.6)
line(ax, [s['jvm']['heapCommitted']/mib for s in series], 'Heap committed', color='#666666', linestyle='--')
cp_line(ax, [c['smaps']['groups'].get('javaHeap', {}).get('rssBytes', float('nan'))/mib for c in checkpoints], 'Heap VMA resident', color='#147b75')
young = [g for g in gc if ('Pause Young' in g['kind'] or 'Pause Full' in g['kind']) and minute(g['at']) >= 0]
ax.plot([minute(g['at']) for g in young], [g['afterBytes']/mib for g in young], '.', markersize=1.5, color='#ac4141', label='After collection (not exact live set)')
decorate(ax, '2  Heap occupancy, capacity and residency', 'MiB')

ax = axes[1, 0]
cp_line(ax, [c['smaps']['groups'].get('codeHeap', {}).get('rssBytes', float('nan'))/mib for c in checkpoints], 'Code VMA RSS', color='#9871b5')
cp_line(ax, [c['nmt']['groups'].get('Code', {}).get('committedBytes', float('nan'))/mib for c in checkpoints], 'Code NMT committed', color='#9871b5', linestyle='--')
cp_line(ax, [c['nmt']['groups'].get('Metaspace', {}).get('committedBytes', float('nan'))/mib for c in checkpoints], 'Metaspace NMT committed', color='#ce873d', linestyle='--')
line(ax, [s['jvm']['directBytes']/mib for s in series], 'Direct buffers used', color='#338e82')
decorate(ax, '3  Code, metadata and direct buffers', 'MiB (distinct measurements)')

ax = axes[1, 1]
cp_line(ax, [c['smaps']['groups'].get('otherAnonymous', {}).get('rssBytes', float('nan'))/mib for c in checkpoints], 'Other anonymous RSS [left]', color='#176f99')
right = ax.twinx(); right.spines['right'].set_visible(True)
right.plot(ct, [c['nmt']['groups'].get('Object Monitors', {}).get('committedBytes', float('nan'))/mib for c in checkpoints], color='#c7852f', marker='o', linestyle='none', label='Object Monitors NMT [right]')
right.plot(ct, [c['nmt']['groups'].get('Arena Chunk', {}).get('committedBytes', float('nan'))/mib for c in checkpoints], color='#aa5683', marker='x', linestyle='none', label='Arena Chunk NMT [right]')
right.set_ylabel('NMT category committed (MiB)', color='#a56b24'); right.set_ylim(bottom=0)
decorate(ax, '4  Anonymous residency and monitor allocations', 'Other anonymous RSS (MiB)')
left_handles, left_labels = ax.get_legend_handles_labels()
right_handles, right_labels = right.get_legend_handles_labels()
ax.legend(left_handles+right_handles, left_labels+right_labels, loc='upper left', fontsize=8)

ax = axes[2, 0]
line(ax, [s['jvm']['threads'] for s in series], 'Java threads', color='#476aa0')
for key, label, color in [('connections', 'Proxy connections', '#57977c'), ('queued', 'Limiter queue', '#d79c42'), ('retained', 'Retained decisions', '#b56780'), ('auditPending', 'Audit pending', '#bbbbbb')]:
    line(ax, [s['resources'][key] for s in series], label, color=color, alpha=.8)
decorate(ax, '5  Resource occupancy (sampled, not true peaks)', 'Count')

ax = axes[2, 1]
ax.bar(ct, [c['elapsedMs']/1000 for c in checkpoints], width=.45, color='#5b839e', label='Checkpoint wall time')
ax.axhline(20, color='#b84343', linestyle='--', label='20s budget threshold')
decorate(ax, '6  Diagnostic overhead is part of this experiment', 'Seconds per checkpoint')

suffix = '\nPink: explicit native trim; post-intervention data is NOT natural stability evidence' if analysis.get('nativeTrim') else ''
fig.suptitle('ZenithGateway | RSS investigation\nJAR '+analysis['jar']['sha256'][:16]+'…  |  4 logical CPUs / 1 GiB  |  G1, NMT summary\nGreen: fixed load   /   Amber: downshift   /   Blue: idle   /   Dots: sparse checkpoints'+suffix, fontsize=13, fontweight='bold')
fig.savefig(folder/'memory-overview.png', dpi=160)
fig.savefig(folder/'memory-overview.svg')
plt.close(fig)

soak = next((s for s in analysis['stages'] if s['kind']=='soak'), None)
if soak:
    start = stamp(soak['from'])
    hour = [g for g in young if start <= stamp(g['at']) <= stamp(soak['to'])]
    fig, ax = plt.subplots(figsize=(12, 4), constrained_layout=True)
    ax.plot([(stamp(g['at'])-start)/60 for g in hour], [g['afterBytes']/mib for g in hour], '.', markersize=2, label='After young/full GC')
    ax.set(title='Natural post-collection heap occupancy — old-generation garbage may remain', xlabel='Minutes in the fixed-load window', ylabel='MiB')
    ax.grid(alpha=.2); ax.legend()
    fig.savefig(folder/'gc-after-collection.png', dpi=160)
    fig.savefig(folder/'gc-after-collection.svg')
    plt.close(fig)
print(folder/'memory-overview.png')


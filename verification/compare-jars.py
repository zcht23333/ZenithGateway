"""Read-only JAR identity comparison; equal entry bytes do not transfer a load-test claim."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inventory(path):
    entries = {}
    total = 0
    with ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            if info.filename in entries:
                raise ValueError('Duplicate JAR entry: '+info.filename)
            total += info.file_size
            if info.file_size > 96*1024*1024 or total > 512*1024*1024:
                raise ValueError('JAR expansion exceeds comparison budget')
            content = archive.read(info)
            entries[info.filename] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
                                      'zipTime': info.date_time, 'compression': info.compress_type}
            if Path(info.filename).suffix in {'.xml', '.yml', '.yaml', '.lua', '.properties', '.json', '.txt'}:
                entries[info.filename]['lfSha256'] = hashlib.sha256(content.replace(b'\r\n', b'\n')).hexdigest()
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    parser.add_argument('candidate', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError('Comparison output must be new')
    before, after = inventory(args.baseline), inventory(args.candidate)
    common = sorted(before.keys() & after.keys())
    changed = [name for name in common if before[name]['sha256'] != after[name]['sha256']]
    added, removed = sorted(after.keys()-before.keys()), sorted(before.keys()-after.keys())
    runtime = lambda name: name.startswith(('BOOT-INF/classes/', 'BOOT-INF/lib/'))
    result = {'schemaVersion': 1, 'baseline': {'sha256': sha(args.baseline), 'entries': len(before)},
              'candidate': {'sha256': sha(args.candidate), 'entries': len(after)},
              'byteIdentical': sha(args.baseline) == sha(args.candidate),
              'allUncompressedEntriesIdentical': not (changed or added or removed),
              'runtimeEntriesIdentical': not any(runtime(n) for n in changed+added+removed),
              'added': added, 'removed': removed,
              'changed': [{'entry': n, 'baseline': before[n], 'candidate': after[n],
                           'onlyCrLfDifference': before[n].get('lfSha256') is not None and
                           before[n]['lfSha256'] == after[n].get('lfSha256')} for n in changed],
              'metadataOnlyChanges': [{'entry': n, 'baseline': before[n], 'candidate': after[n]} for n in common
                                      if n not in changed and before[n] != after[n]],
              'capacityClaimTransferred': False,
              'meaning': 'Whole JAR hash, decompressed member bytes and ZIP metadata are distinct identities. No new hour was run.'}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k not in ('changed', 'metadataOnlyChanges')}, indent=2))


if __name__ == '__main__':
    main()

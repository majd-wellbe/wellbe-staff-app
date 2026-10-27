# Splits import.sql into numbered parts for the Supabase SQL tool, statement order kept.
# Consecutive inserts into the same table with the same column list are merged into one multi-row insert (same rows, same order).
# The _used_flags temp-table check is dropped here and run as a plain query after loading.
# --seq-uuid: the random ids made by import.js become short sequential ones (00000000-0000-4000-8000-000000000001, ...),
# same id everywhere it appears, so links stay intact. Shorter text to paste, and a copy mistake breaks a link loudly.
# Usage: python3 split.py import.sql <out folder> <max chars per part> [--seq-uuid]
import re, sys
src, outdir, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
lines = open(src, encoding='utf-8').read().split('\n')
body = [l for l in lines if l.startswith('insert ') or l.startswith('update ')]
if '--seq-uuid' in sys.argv:
    uu, m = re.compile(r"'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'"), {}
    def rep(x):
        k = x.group(1)
        if k not in m: m[k] = '00000000-0000-4000-8000-%012d' % (len(m) + 1)
        return "'" + m[k] + "'"
    body = [uu.sub(rep, l) for l in body]
pat = re.compile(r'^(insert into public\.\w+ \([^)]*\) values )(\(.*\));$', re.S)
stm, prev = [], None
for l in body:
    mm = pat.match(l) if 'on conflict' not in l else None
    if mm and prev == mm.group(1) and len(stm[-1]) < 20000:
        stm[-1] = stm[-1][:-1] + ',\n' + mm.group(2) + ';'
    else:
        stm.append(l); prev = mm.group(1) if mm else None
parts, cur, size = [], [], 0
for l in stm:
    if cur and size + len(l) > limit: parts.append(cur); cur, size = [], 0
    cur.append(l); size += len(l) + 1
if cur: parts.append(cur)
for i, p in enumerate(parts, 1):
    open('%s/part%02d.sql' % (outdir, i), 'w', encoding='utf-8').write('\n'.join(p) + '\n')
print(len(body), 'statements ->', len(stm), 'merged,', len(parts), 'parts')

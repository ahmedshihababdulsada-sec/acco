#!/usr/bin/env python3
"""فحص ساكن لـ schema.sql (ما يحتاج PostgreSQL): ترتيب الجداول، المراجع، توازن الأقواس.
الفحص الحقيقي يصير على PostgreSQL فعلي بالمرحلة 1أ."""
import re, sys, pathlib

src = pathlib.Path(__file__).with_name('schema.sql').read_text(encoding='utf-8')
code = re.sub(r'--[^\n]*', '', src)                 # شيل التعليقات
code_nostr = re.sub(r"'(?:[^']|'')*'", "''", code)   # شيل النصوص

errors = []
if code_nostr.count('(') != code_nostr.count(')'):
    errors.append(f"unbalanced parentheses: {code_nostr.count('(')} vs {code_nostr.count(')')}")
if code_nostr.count('$$') % 2:
    errors.append('unbalanced $$ blocks')

# الجداول بترتيب التعريف + أعمدتها
tables, order = {}, []
for m in re.finditer(r'create table (\w+) \(', code_nostr):
    name = m.group(1)
    i, depth = m.end(), 1
    while depth:
        c = code_nostr[i]
        depth += (c == '(') - (c == ')')
        i += 1
    body = code_nostr[m.end():i-1]
    cols, d, cur = [], 0, ''
    for ch in body:                                   # قسّم على الفواصل بالمستوى الأول
        if ch == '(' : d += 1
        if ch == ')' : d -= 1
        if ch == ',' and d == 0:
            cols.append(cur.strip()); cur = ''
        else:
            cur += ch
    cols.append(cur.strip())
    colnames = set()
    for c in cols:
        w = c.split()[0] if c else ''
        if w and w not in ('check','unique','primary','exclude','constraint','foreign'):
            colnames.add(w)
    if name in tables:
        errors.append(f'duplicate table {name}')
    tables[name] = (colnames, body)
    order.append((m.start(), name))

pos = {n: p for p, n in order}
for name, (cols, body) in tables.items():
    for ref in re.finditer(r'references (\w+)\((\w+)\)', body):
        t, c = ref.groups()
        if t not in tables:
            errors.append(f'{name}: references unknown table {t}')
        elif pos[t] > pos[name] and t != name:
            errors.append(f'{name}: references {t} which is created later')
        elif c not in tables[t][0]:
            errors.append(f'{name}: references {t}({c}) but column does not exist')

# كل جدول عنده primary key
for name, (cols, body) in tables.items():
    if 'primary key' not in body:
        errors.append(f'{name}: no primary key')

# مراجع الجداول بالـ views والـ triggers موجودة
for m in re.finditer(r'\b(?:from|join|on|update|into) (\w+)\b', code_nostr):
    w = m.group(1)
    if w.startswith('v_') or w in ('select','all','each','public','clinic_app','begin','only'):
        continue

known_sql = {'lateral','unnest','generate_series','new','old','period_month'}  # new/old: plpgsql، period_month: extract(day from ...)
refd = set(re.findall(r'\b(?:from|join) ([a-z_]+)\b', code_nostr))
for t in sorted(refd):
    if t not in tables and not t.startswith('v_') and t not in known_sql and t not in ('select',):
        errors.append(f'view/function references unknown relation: {t}')

print(f'tables: {len(tables)}')
if errors:
    print('ERRORS:'); [print(' -', e) for e in errors]; sys.exit(1)
print('OK: no static errors found')

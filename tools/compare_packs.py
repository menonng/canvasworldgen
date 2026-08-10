import json, sys, os

def norm(x):
    if isinstance(x, bool): return x
    if isinstance(x, (int, float)): return round(float(x), 9)
    if isinstance(x, list): return [norm(v) for v in x]
    if isinstance(x, dict): return {k: norm(v) for k, v in x.items()}
    return x

def walk(root):
    out = {}
    for base, _, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            out[os.path.relpath(p, root)] = p
    return out

a, b, label = sys.argv[1], sys.argv[2], sys.argv[3]
fa, fb = walk(a), walk(b)
problems = []
for missing in sorted(set(fa) - set(fb)): problems.append(f"only in python: {missing}")
for extra in sorted(set(fb) - set(fa)): problems.append(f"only in typescript: {extra}")
for rel in sorted(set(fa) & set(fb)):
    ta, tb = open(fa[rel]).read(), open(fb[rel]).read()
    if rel.endswith(".json"):
        if norm(json.loads(ta)) != norm(json.loads(tb)):
            problems.append(f"value differs: {rel}")
    elif ta.strip() != tb.strip():
        problems.append(f"text differs: {rel}")
print(f"{'MATCH ' if not problems else 'DIFFER'} {label}  ({len(fa)} files)")
for p in problems[:6]: print("    ", p)
sys.exit(1 if problems else 0)

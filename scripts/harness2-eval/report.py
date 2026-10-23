"""Summarize a harness2-eval state file (documentation chapter 13 §10): per-arm accuracy on fresh
attempts, paired deltas with a 95% bootstrap CI over tasks, and what each adopted harness did.

Usage: python3 scripts/harness2-eval/report.py <state>/units.json"""
import json
import random
import sys

state = json.load(open(sys.argv[1]))
ARMS = [a for a in ["base", "handwritten", "solo-blind", "solo-told", "chain-blind", "chain-told"] if any(k.startswith(a + "/") for k in state)]
tasks = sorted({k.split("/")[1] for k in state}, key=lambda t: int(t.split("-")[1]))


def acc(arm, task):
    u = state.get(f"{arm}/{task}")
    if not u or not u.get("attempts"):
        return None
    a = u["attempts"]
    return sum(x["correct"] for x in a) / len(a)


print("per-task accuracy on fresh attempts (correct / attempts):")
print("task      " + "".join(f"{a:>13}" for a in ARMS))
for t in tasks:
    print(f"{t:<10}" + "".join(f"{'' if acc(a, t) is None else f'{acc(a, t):.2f}':>13}" for a in ARMS))
means = {}
for a in ARMS:
    xs = [acc(a, t) for t in tasks if acc(a, t) is not None]
    means[a] = sum(xs) / len(xs) if xs else None
    n_att = sum(len(state[f"{a}/{t}"]["attempts"]) for t in tasks if acc(a, t) is not None)
    n_ok = sum(sum(x["correct"] for x in state[f"{a}/{t}"]["attempts"]) for t in tasks if acc(a, t) is not None)
    calc = sum(sum(1 for x in state[f"{a}/{t}"]["attempts"] if x.get("calc", 0) > 0) for t in tasks if acc(a, t) is not None)
    tot = sum(sum(1 for x in state[f"{a}/{t}"]["attempts"] if x["totalOk"]) for t in tasks if acc(a, t) is not None)
    dup = sum(sum(1 for x in state[f"{a}/{t}"]["attempts"] if x["dupsOk"]) for t in tasks if acc(a, t) is not None)
    if xs:
        print(f"{a:<12} mean {means[a]:.3f} over {len(xs)} tasks; pooled {n_ok}/{n_att}; total right {tot}, ids right {dup}, used calculator {calc}")
        used = {}
        for t in tasks:
            for x in (state.get(f"{a}/{t}") or {}).get("attempts") or []:
                for name in x.get("tools", {}):
                    used[name] = used.get(name, 0) + 1
        if used:
            print(f"{'':<12} attempts calling each tool: " + ", ".join(f"{k} {v}" for k, v in sorted(used.items(), key=lambda kv: -kv[1])))


def paired(x, y, only=None):
    ts = [t for t in tasks if acc(x, t) is not None and acc(y, t) is not None and (only is None or t in only)]
    d = [acc(x, t) - acc(y, t) for t in ts]
    if not d:
        return None
    rnd = random.Random(7)
    boots = sorted(sum(rnd.choice(d) for _ in d) / len(d) for _ in range(10_000))
    return {"n": len(d), "mean": sum(d) / len(d), "lo": boots[249], "hi": boots[9749],
            "better": sum(1 for v in d if v > 0), "worse": sum(1 for v in d if v < 0), "same": sum(1 for v in d if v == 0)}


print("\npaired deltas (mean over tasks, 95% bootstrap CI over tasks; tasks better/worse/same):")
later = set(tasks[1:])
pairs = [("handwritten", "base", None, "hand-written harness vs base (headroom)")]
for v in ["blind", "told"]:
    pairs += [(f"solo-{v}", "base", None, f"loop ({v}) vs base, empty library"), (f"chain-{v}", "base", None, f"loop ({v}) + library vs base"),
              (f"chain-{v}", f"solo-{v}", later, f"library effect ({v}), tasks 2..n")]
for x, y, only, label in pairs:
    p = paired(x, y, only)
    if p:
        print(f"  {label}: {p['mean']:+.3f} [{p['lo']:+.3f}, {p['hi']:+.3f}] n={p['n']} ({p['better']}/{p['worse']}/{p['same']})")

print("\nloop runs:")
for arm in [a for a in ARMS if "-" in a]:
    for t in tasks:
        u = state.get(f"{arm}/{t}", {})
        L = u.get("loop")
        if not L:
            continue
        tree = "\n".join((L.get("adoptedTree") or {}).values())
        print(f"  {arm}/{t}: {L['status']} delivered={'right' if L['deliveredCorrect'] else 'wrong'} chosen={L['chosen']} base={L['chosenTreeIsBase']} "
              f"files={sorted((L.get('adoptedTree') or {}).keys())} mentions_calculator={'evaluate_expression' in tree} "
              f"library_before={L.get('libraryBefore')} learned={L['learned']} in-loop={L['inLoop']} {round(L['loopMs'] / 1000)}s")
        if L.get("toolNoteSeen"):
            print(f"      tool note in prompts: {L['toolNoteSeen']}")
        if arm.startswith("chain") and L.get("lesson"):
            print(f"      lesson ({L['lesson']['confidence'].split()[0]}): {L['lesson']['lesson'][:220]}")

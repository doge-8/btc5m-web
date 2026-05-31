"""
回测分析脚本
用法: cd backtest-data && python3 analyze.py

功能:
1. 建立 diff → 合理概率 映射（按 rem 分段）
2. 计算当前概率与合理概率的偏差
3. 找出最优入场偏差阈值
4. 模拟策略1（常规加强）的历史表现
"""

import json
import glob
import sys
from collections import defaultdict

# ── 1. 加载数据 ──────────────────────────────────────────────

ticks = []
for f in sorted(glob.glob("*.jsonl")) + sorted(glob.glob("ticks-*.jsonl")):
    for line in open(f):
        try:
            r = json.loads(line)
            if r.get("type") == "tick":
                ticks.append(r)
            elif "diff" in r and "upPct" in r and "type" not in r:
                # 兼容旧格式（无 type 字段）
                ticks.append(r)
        except:
            pass

if not ticks:
    print("没有找到 tick 数据")
    sys.exit(1)

windows = sorted(set(t["windowStart"] for t in ticks))
print(f"总 tick 数: {len(ticks)}")
print(f"覆盖窗口数: {len(windows)}")
print(f"时间范围: {ticks[0]['ts']} ~ {ticks[-1]['ts']}")
print()

# ── 2. 建立 diff → 合理概率 映射 ─────────────────────────────

# 按 (diff 桶, rem 段) 分组
DIFF_BUCKET = 5  # 每5一档
REM_BINS = [(0, 30), (30, 60), (60, 120), (120, 180), (180, 300)]

def diff_bucket(d):
    return round(d / DIFF_BUCKET) * DIFF_BUCKET

def rem_bin(r):
    for lo, hi in REM_BINS:
        if lo <= r < hi:
            return f"{lo}-{hi}"
    return "300+"

mapping = defaultdict(list)  # (diff_bucket, rem_bin) -> [upPct, ...]

for t in ticks:
    db = diff_bucket(t["diff"])
    rb = rem_bin(t["rem"])
    mapping[(db, rb)].append(t["upPct"])

print("=" * 70)
print("diff → 合理概率 映射（中位数，按 rem 分段）")
print("=" * 70)
print(f"{'diff':>6}  ", end="")
for lo, hi in REM_BINS:
    print(f"  {lo}-{hi}s", end="")
print(f"  {'样本':>6}")
print("-" * 70)

all_buckets = sorted(set(db for db, _ in mapping))
for db in all_buckets:
    total = 0
    row = f"{db:+6d}  "
    for lo, hi in REM_BINS:
        rb = f"{lo}-{hi}"
        vals = mapping.get((db, rb), [])
        total += len(vals)
        if vals:
            vals_sorted = sorted(vals)
            median = vals_sorted[len(vals_sorted) // 2]
            row += f"  {median:5d}%"
        else:
            row += f"      —"
    row += f"  {total:6d}"
    if total >= 5:  # 只显示有足够样本的
        print(row)

# ── 3. 计算偏差分布 ──────────────────────────────────────────

print()
print("=" * 70)
print("偏差分析：实际概率 vs 合理概率（中位数）")
print("=" * 70)

biases = []
for t in ticks:
    db = diff_bucket(t["diff"])
    rb = rem_bin(t["rem"])
    vals = mapping.get((db, rb), [])
    if len(vals) < 10:
        continue
    vals_sorted = sorted(vals)
    fair_prob = vals_sorted[len(vals_sorted) // 2]
    bias = fair_prob - t["upPct"]
    biases.append({
        "bias": bias,
        "diff": t["diff"],
        "upPct": t["upPct"],
        "fair": fair_prob,
        "rem": t["rem"],
        "windowStart": t["windowStart"],
        "ts": t["ts"],
    })

if biases:
    abs_biases = [abs(b["bias"]) for b in biases]
    print(f"有效样本数: {len(biases)}")
    print(f"偏差均值: {sum(b['bias'] for b in biases) / len(biases):.1f}%")
    print(f"偏差绝对值均值: {sum(abs_biases) / len(abs_biases):.1f}%")
    print(f"偏差绝对值中位数: {sorted(abs_biases)[len(abs_biases)//2]:.1f}%")
    print()

    # 偏差分布
    print("偏差分布:")
    from collections import Counter
    bias_bins = Counter()
    for b in biases:
        bb = round(b["bias"] / 2) * 2
        bias_bins[bb] += 1
    for bb in sorted(bias_bins):
        pct = bias_bins[bb] / len(biases) * 100
        bar = "█" * int(pct)
        print(f"  {bb:+4d}%: {bias_bins[bb]:5d} ({pct:4.1f}%) {bar}")

# ── 4. 入场机会分析 ──────────────────────────────────────────

print()
print("=" * 70)
print("入场机会分析：偏差超过阈值时概率后续走势")
print("=" * 70)

# 按窗口分组
window_ticks = defaultdict(list)
for t in ticks:
    window_ticks[t["windowStart"]].append(t)

for threshold in [5, 8, 10, 12, 15]:
    entries = []
    for b in biases:
        if abs(b["bias"]) >= threshold and 50 <= b["rem"] <= 200:
            entries.append(b)

    if not entries:
        print(f"\n偏差阈值 {threshold}%: 无入场机会")
        continue

    # 看入场后概率是否回归
    convergences = []
    for entry in entries:
        ws = entry["windowStart"]
        wticks = window_ticks.get(ws, [])
        # 找入场后10秒、30秒的概率变化
        entry_ts = entry["ts"]
        for dt_label, dt_ms in [("10s", 10000), ("30s", 30000)]:
            future = [t for t in wticks if 0 < t["ts"] - entry_ts <= dt_ms]
            if future:
                future_prob = future[-1]["upPct"]
                prob_change = future_prob - entry["upPct"]
                # 如果偏差为正（市场低估涨），概率应该涨
                expected_dir = 1 if entry["bias"] > 0 else -1
                correct = (prob_change * expected_dir) > 0
                convergences.append({
                    "dt": dt_label,
                    "change": prob_change,
                    "correct": correct,
                    "bias_dir": "低估" if entry["bias"] > 0 else "高估",
                })

    if convergences:
        for dt_label in ["10s", "30s"]:
            dt_items = [c for c in convergences if c["dt"] == dt_label]
            if dt_items:
                correct_count = sum(1 for c in dt_items if c["correct"])
                avg_change = sum(abs(c["change"]) for c in dt_items) / len(dt_items)
                print(f"\n偏差阈值 {threshold}%: {len(entries)} 次入场机会")
                print(f"  {dt_label}后回归率: {correct_count}/{len(dt_items)} ({correct_count/len(dt_items)*100:.0f}%)")
                print(f"  {dt_label}后平均概率变化: {avg_change:.1f}%")

# ── 5. 策略1模拟回测 ─────────────────────────────────────────

print()
print("=" * 70)
print("策略1（常规加强）模拟回测")
print("=" * 70)

ENTRY_DIFF = 35
ENTRY_PROB_CAP = 80
WINDOW_MAX_REM = 210
WINDOW_MIN_REM = 50
TRAILING_STOP_RETRACEMENT = 20
TRAILING_STOP_MIN_DIFF = 5
PROB_PEAK_MIN = 85
PROB_PEAK_RETRACEMENT = 8
FORCE_EXIT_REM = 10

trades = []
for ws in windows:
    wticks = sorted(window_ticks[ws], key=lambda t: t["ts"])
    if len(wticks) < 10:
        continue

    last_diff = None
    holding = False
    direction = None
    entry_price = None
    peak_diff = None
    peak_prob = None

    for t in wticks:
        diff = t["diff"]
        upPct = t["upPct"]
        rem = t["rem"]

        if not holding:
            # 检查入场
            if rem <= WINDOW_MAX_REM and rem > WINDOW_MIN_REM and last_diff is not None:
                # 买涨穿越
                if last_diff <= ENTRY_DIFF and diff > ENTRY_DIFF and upPct < ENTRY_PROB_CAP:
                    holding = True
                    direction = "up"
                    entry_price = upPct / 100  # 简化：用概率作为买入价
                    peak_diff = diff
                    peak_prob = upPct
                # 买跌穿越
                elif last_diff >= -ENTRY_DIFF and diff < -ENTRY_DIFF and (100 - upPct) < ENTRY_PROB_CAP:
                    holding = True
                    direction = "down"
                    entry_price = (100 - upPct) / 100
                    peak_diff = -diff
                    peak_prob = 100 - upPct
        else:
            my_pct = upPct if direction == "up" else (100 - upPct)
            fav_diff = diff if direction == "up" else -diff

            # 更新峰值
            if fav_diff > peak_diff:
                peak_diff = fav_diff
            if my_pct > peak_prob:
                peak_prob = my_pct

            exit_reason = None
            exit_signal = None

            # 强制平仓
            if rem <= FORCE_EXIT_REM and rem > 0:
                exit_signal = "tp" if my_pct >= 70 else "sl"
                exit_reason = f"强制平仓 rem={rem}"

            # 阶梯止盈
            if not exit_reason and rem >= FORCE_EXIT_REM:
                span = WINDOW_MAX_REM - FORCE_EXIT_REM
                elapsed = max(0, WINDOW_MAX_REM - rem)
                tp_thr = 90 + int(elapsed / span * 10)
                tp_capped = min(tp_thr, 100)
                if my_pct >= tp_capped:
                    exit_signal = "tp"
                    exit_reason = f"阶梯止盈 {my_pct}%>={tp_capped}%"

            # 回撤止盈
            if not exit_reason and peak_prob >= PROB_PEAK_MIN and my_pct <= peak_prob - PROB_PEAK_RETRACEMENT:
                exit_signal = "tp"
                exit_reason = f"回撤止盈 {my_pct}% 峰{peak_prob}%"

            # 兜底止损
            if not exit_reason:
                if direction == "up" and diff <= TRAILING_STOP_MIN_DIFF:
                    exit_signal = "sl"
                    exit_reason = f"兜底止损 diff={diff:.0f}"
                elif direction == "down" and diff >= -TRAILING_STOP_MIN_DIFF:
                    exit_signal = "sl"
                    exit_reason = f"兜底止损 diff={diff:.0f}"

            # 追踪止损
            if not exit_reason and peak_diff - fav_diff >= TRAILING_STOP_RETRACEMENT:
                exit_signal = "sl"
                exit_reason = f"追踪止损 回撤{peak_diff - fav_diff:.0f}"

            if exit_reason:
                exit_price = my_pct / 100
                pnl = exit_price - entry_price
                trades.append({
                    "window": ws,
                    "direction": direction,
                    "entry_price": entry_price,
                    "exit_price": exit_price,
                    "pnl": pnl,
                    "signal": exit_signal,
                    "reason": exit_reason,
                })
                holding = False
                direction = None

        last_diff = diff

if trades:
    wins = [t for t in trades if t["pnl"] > 0]
    losses = [t for t in trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in trades)

    print(f"总交易次数: {len(trades)}")
    print(f"盈利次数: {len(wins)} ({len(wins)/len(trades)*100:.0f}%)")
    print(f"亏损次数: {len(losses)} ({len(losses)/len(trades)*100:.0f}%)")
    print(f"总 PnL: {total_pnl:+.4f}")
    if wins:
        print(f"平均盈利: +{sum(t['pnl'] for t in wins)/len(wins):.4f}")
    if losses:
        print(f"平均亏损: {sum(t['pnl'] for t in losses)/len(losses):.4f}")
    print()

    # 按出场原因统计
    reason_stats = defaultdict(lambda: {"count": 0, "pnl": 0})
    for t in trades:
        key = t["reason"].split(" ")[0] + " " + t["reason"].split(" ")[1] if len(t["reason"].split(" ")) > 1 else t["reason"]
        # 简化为类型
        if "阶梯" in t["reason"]:
            key = "阶梯止盈"
        elif "回撤止盈" in t["reason"]:
            key = "回撤止盈"
        elif "兜底" in t["reason"]:
            key = "兜底止损"
        elif "追踪" in t["reason"]:
            key = "追踪止损"
        elif "强制" in t["reason"]:
            key = "强制平仓"
        reason_stats[key]["count"] += 1
        reason_stats[key]["pnl"] += t["pnl"]

    print("按出场原因统计:")
    for key in sorted(reason_stats, key=lambda k: -reason_stats[k]["count"]):
        s = reason_stats[key]
        print(f"  {key}: {s['count']}次, PnL {s['pnl']:+.4f}")

    print()
    print("逐笔明细:")
    for t in trades:
        dir_zh = "涨" if t["direction"] == "up" else "跌"
        print(f"  窗口{t['window']} 买{dir_zh} 入{t['entry_price']:.2f}→出{t['exit_price']:.2f} PnL{t['pnl']:+.4f} {t['reason']}")
else:
    print("无交易触发")

# ── 6. 策略2（常规）模拟回测 ──────────────────────────────────

print()
print("=" * 70)
print("策略2（常规）模拟回测")
print("=" * 70)

S2_ENTRY_DIFF = 40
S2_ENTRY_PROB_CAP = 75
S2_WINDOW_MAX_REM = 168
S2_WINDOW_MIN_REM = 48
S2_STOP_LOSS_DIFF = 5
S2_TP_LADDER_FLOOR = 8

trades2 = []
for ws in windows:
    wticks = sorted(window_ticks[ws], key=lambda t: t["ts"])
    if len(wticks) < 10:
        continue

    last_diff = None
    holding = False
    direction = None
    entry_price = None

    for t in wticks:
        diff = t["diff"]
        upPct = t["upPct"]
        rem = t["rem"]

        if not holding:
            if rem <= S2_WINDOW_MAX_REM and rem > S2_WINDOW_MIN_REM and last_diff is not None:
                if last_diff <= S2_ENTRY_DIFF and diff > S2_ENTRY_DIFF and upPct < S2_ENTRY_PROB_CAP:
                    holding = True
                    direction = "up"
                    entry_price = upPct / 100
                elif last_diff >= -S2_ENTRY_DIFF and diff < -S2_ENTRY_DIFF and (100 - upPct) < S2_ENTRY_PROB_CAP:
                    holding = True
                    direction = "down"
                    entry_price = (100 - upPct) / 100
        else:
            my_pct = upPct if direction == "up" else (100 - upPct)
            exit_reason = None
            exit_signal = None

            # 阶梯止盈（固定公式：168→8，每16s升1%）
            if rem >= S2_TP_LADDER_FLOOR:
                span = S2_WINDOW_MAX_REM - S2_TP_LADDER_FLOOR
                elapsed = max(0, S2_WINDOW_MAX_REM - max(rem, S2_TP_LADDER_FLOOR))
                tp_thr = 90 + int(elapsed / span * 10)
                tp_capped = min(tp_thr, 100)
                if my_pct >= tp_capped:
                    exit_signal = "tp"
                    exit_reason = f"阶梯止盈 {my_pct}%>={tp_capped}%"

            # 止损
            if not exit_reason:
                if direction == "up" and diff <= S2_STOP_LOSS_DIFF:
                    exit_signal = "sl"
                    exit_reason = f"止损 diff={diff:.0f}"
                elif direction == "down" and diff >= -S2_STOP_LOSS_DIFF:
                    exit_signal = "sl"
                    exit_reason = f"止损 diff={diff:.0f}"

            if exit_reason:
                exit_price = my_pct / 100
                pnl = exit_price - entry_price
                trades2.append({
                    "window": ws,
                    "direction": direction,
                    "entry_price": entry_price,
                    "exit_price": exit_price,
                    "pnl": pnl,
                    "signal": exit_signal,
                    "reason": exit_reason,
                })
                holding = False
                direction = None

        last_diff = diff

if trades2:
    wins2 = [t for t in trades2 if t["pnl"] > 0]
    losses2 = [t for t in trades2 if t["pnl"] <= 0]
    total_pnl2 = sum(t["pnl"] for t in trades2)

    print(f"总交易次数: {len(trades2)}")
    print(f"盈利次数: {len(wins2)} ({len(wins2)/len(trades2)*100:.0f}%)")
    print(f"亏损次数: {len(losses2)} ({len(losses2)/len(trades2)*100:.0f}%)")
    print(f"总 PnL: {total_pnl2:+.4f}")
    if wins2:
        print(f"平均盈利: +{sum(t['pnl'] for t in wins2)/len(wins2):.4f}")
    if losses2:
        print(f"平均亏损: {sum(t['pnl'] for t in losses2)/len(losses2):.4f}")
    print()

    reason_stats2 = defaultdict(lambda: {"count": 0, "pnl": 0})
    for t in trades2:
        if "阶梯" in t["reason"]:
            key = "阶梯止盈"
        elif "止损" in t["reason"]:
            key = "止损"
        else:
            key = t["reason"]
        reason_stats2[key]["count"] += 1
        reason_stats2[key]["pnl"] += t["pnl"]

    print("按出场原因统计:")
    for key in sorted(reason_stats2, key=lambda k: -reason_stats2[k]["count"]):
        s = reason_stats2[key]
        print(f"  {key}: {s['count']}次, PnL {s['pnl']:+.4f}")

    print()
    print("逐笔明细:")
    for t in trades2:
        dir_zh = "涨" if t["direction"] == "up" else "跌"
        print(f"  窗口{t['window']} 买{dir_zh} 入{t['entry_price']:.2f}→出{t['exit_price']:.2f} PnL{t['pnl']:+.4f} {t['reason']}")
else:
    print("无交易触发")

# ── 7. 对比总结 ──────────────────────────────────────────────

print()
print("=" * 70)
print("策略对比")
print("=" * 70)
s1_pnl = sum(t["pnl"] for t in trades) if trades else 0
s2_pnl = sum(t["pnl"] for t in trades2) if trades2 else 0
s1_wins = sum(1 for t in trades if t["pnl"] > 0) if trades else 0
s2_wins = sum(1 for t in trades2 if t["pnl"] > 0) if trades2 else 0
print(f"{'':15} {'常规加强':>10} {'常规':>10}")
print(f"{'交易次数':15} {len(trades):>10} {len(trades2):>10}")
print(f"{'胜率':15} {(s1_wins/len(trades)*100 if trades else 0):>9.0f}% {(s2_wins/len(trades2)*100 if trades2 else 0):>9.0f}%")
print(f"{'总PnL':15} {s1_pnl:>+10.4f} {s2_pnl:>+10.4f}")

# ── 8. 波动率分析 ─────────────────────────────────────────────

print()
print("=" * 70)
print("波动率分析（每个窗口内 diff 标准差）")
print("=" * 70)

import math

vol_data = []
for ws in windows:
    wticks = window_ticks[ws]
    if len(wticks) < 10:
        continue
    diffs = [t["diff"] for t in wticks]
    mean = sum(diffs) / len(diffs)
    variance = sum((d - mean) ** 2 for d in diffs) / len(diffs)
    std = math.sqrt(variance)
    vol_data.append({"window": ws, "std": std, "count": len(wticks)})

if vol_data:
    stds = [v["std"] for v in vol_data]
    print(f"窗口数: {len(vol_data)}")
    print(f"diff 标准差 范围: {min(stds):.1f} ~ {max(stds):.1f}")
    print(f"diff 标准差 均值: {sum(stds)/len(stds):.1f}")
    print(f"diff 标准差 中位数: {sorted(stds)[len(stds)//2]:.1f}")

    # 高波动 vs 低波动时的概率偏差
    median_std = sorted(stds)[len(stds) // 2]
    high_vol_windows = set(v["window"] for v in vol_data if v["std"] > median_std)
    low_vol_windows = set(v["window"] for v in vol_data if v["std"] <= median_std)

    if biases:
        high_biases = [b for b in biases if b["windowStart"] in high_vol_windows]
        low_biases = [b for b in biases if b["windowStart"] in low_vol_windows]
        if high_biases and low_biases:
            print(f"\n高波动窗口 偏差绝对值均值: {sum(abs(b['bias']) for b in high_biases)/len(high_biases):.1f}%")
            print(f"低波动窗口 偏差绝对值均值: {sum(abs(b['bias']) for b in low_biases)/len(low_biases):.1f}%")

# ── 9. 参数优化（常规加强） ───────────────────────────────────

print()
print("=" * 70)
print("参数优化：常规加强策略 — 遍历参数组合找最优")
print("=" * 70)

def run_backtest(params):
    """用给定参数跑一遍回测，返回交易列表"""
    ed = params["entry_diff"]
    epc = params["entry_prob_cap"]
    wmx = params["window_max_rem"]
    wmn = params["window_min_rem"]
    tsr = params["trailing_stop_ret"]
    tsm = params["trailing_stop_min"]
    ppm = params["prob_peak_min"]
    ppr = params["prob_peak_ret"]
    fer = params["force_exit_rem"]
    tps = params["tp_start"]
    tpn = 100 - tps  # 从起始值到100%的百分点数，每1%一档

    result = []
    for ws in windows:
        wticks = sorted(window_ticks[ws], key=lambda t: t["ts"])
        if len(wticks) < 10:
            continue

        last_diff = None
        holding = False
        direction = None
        entry_price = None
        peak_diff = None
        peak_prob = None

        for t in wticks:
            diff = t["diff"]
            upPct = t["upPct"]
            rem = t["rem"]

            if not holding:
                if rem <= wmx and rem > wmn and last_diff is not None:
                    if last_diff <= ed and diff > ed and upPct < epc:
                        holding = True
                        direction = "up"
                        entry_price = upPct / 100
                        peak_diff = diff
                        peak_prob = upPct
                    elif last_diff >= -ed and diff < -ed and (100 - upPct) < epc:
                        holding = True
                        direction = "down"
                        entry_price = (100 - upPct) / 100
                        peak_diff = -diff
                        peak_prob = 100 - upPct
            else:
                my_pct = upPct if direction == "up" else (100 - upPct)
                fav_diff = diff if direction == "up" else -diff

                if fav_diff > peak_diff: peak_diff = fav_diff
                if my_pct > peak_prob: peak_prob = my_pct

                exit_reason = None

                # 强制平仓
                if rem <= fer and rem > 0:
                    exit_reason = "强制平仓"

                # 阶梯止盈
                if not exit_reason and rem >= fer:
                    span = wmx - fer
                    elapsed = max(0, wmx - rem)
                    tp_capped = min(tps + int(elapsed / span * tpn), 100)
                    if my_pct >= tp_capped:
                        exit_reason = "阶梯止盈"

                # 回撤止盈
                if not exit_reason and peak_prob >= ppm and my_pct <= peak_prob - ppr:
                    exit_reason = "回撤止盈"

                # 兜底止损
                if not exit_reason:
                    if direction == "up" and diff <= tsm:
                        exit_reason = "兜底止损"
                    elif direction == "down" and diff >= -tsm:
                        exit_reason = "兜底止损"

                # 追踪止损
                if not exit_reason and peak_diff - fav_diff >= tsr:
                    exit_reason = "追踪止损"

                if exit_reason:
                    exit_price = my_pct / 100
                    pnl = exit_price - entry_price
                    result.append(pnl)
                    holding = False
                    direction = None

            last_diff = diff
    return result

# 参数搜索空间
param_grid = {
    "entry_diff":       [25, 30, 35, 40, 45],
    "entry_prob_cap":   [75, 80, 85],
    "window_max_rem":   [190, 210, 240],
    "window_min_rem":   [30, 50],
    "trailing_stop_ret":[15, 20, 25],
    "trailing_stop_min":[5],              # 上轮不敏感，固定
    "prob_peak_min":    [80, 85],
    "prob_peak_ret":    [5, 8, 10],
    "force_exit_rem":   [8, 10],
    "tp_start":         [88, 90, 92, 95],
}

# 生成所有组合
from itertools import product
import multiprocessing as mp
mp.set_start_method("fork", force=True)
from multiprocessing import Pool, cpu_count

keys = list(param_grid.keys())
combos = list(product(*[param_grid[k] for k in keys]))
print(f"总参数组合数: {len(combos)}, 使用 {cpu_count()} 核并行计算")
print("计算中...")

def eval_combo(combo):
    params = dict(zip(keys, combo))
    pnls = run_backtest(params)
    if not pnls:
        return None
    total = sum(pnls)
    wins = sum(1 for p in pnls if p > 0)
    return {
        "params": params,
        "total_pnl": total,
        "trades": len(pnls),
        "win_rate": wins / len(pnls) * 100,
    }

with Pool(cpu_count()) as pool:
    raw_results = pool.map(eval_combo, combos)

top_results = [r for r in raw_results if r is not None]

# 按 PnL 排序，显示 Top 15
top_results.sort(key=lambda x: -x["total_pnl"])

best = top_results[0] if top_results else None

print(f"\n{'排名':>4} {'交易':>4} {'胜率':>6} {'总PnL':>8}  参数")
print("-" * 100)
for i, r in enumerate(top_results[:15]):
    p = r["params"]
    param_str = f"diff={p['entry_diff']} cap={p['entry_prob_cap']} win={p['window_max_rem']}-{p['window_min_rem']} ts={p['trailing_stop_ret']}/{p['trailing_stop_min']} pp={p['prob_peak_min']}/{p['prob_peak_ret']} fer={p['force_exit_rem']} tp={p['tp_start']}→100%"
    marker = " ★" if i == 0 else ""
    print(f"{i+1:>4} {r['trades']:>4} {r['win_rate']:>5.0f}% {r['total_pnl']:>+8.4f}  {param_str}{marker}")

if best:
    print(f"\n最优参数:")
    for k, v in best["params"].items():
        label = {
            "entry_diff": "ENTRY_DIFF（入场差价阈值）",
            "entry_prob_cap": "ENTRY_PROB_CAP（入场概率上限）",
            "window_max_rem": "WINDOW_MAX_REMAINING（扫描起始）",
            "window_min_rem": "WINDOW_MIN_REMAINING（扫描截止）",
            "trailing_stop_ret": "TRAILING_STOP_RETRACEMENT（追踪止损回撤）",
            "trailing_stop_min": "TRAILING_STOP_MIN_DIFF（兜底止损）",
            "prob_peak_min": "PROB_PEAK_MIN_THRESHOLD（回撤止盈门槛）",
            "prob_peak_ret": "PROB_PEAK_RETRACEMENT（回撤止盈幅度）",
            "force_exit_rem": "FORCE_EXIT_REM（强制平仓秒数）",
            "tp_start": "阶梯止盈起始概率（每1%一档升至100%）",
        }.get(k, k)
        print(f"  {label}: {v}")
    print(f"  总PnL: {best['total_pnl']:+.4f}, 交易{best['trades']}笔, 胜率{best['win_rate']:.0f}%")
    print(f"  总PnL: {best_pnl:+.4f}, 交易{len(best_trades)}笔, 胜率{sum(1 for p in best_trades if p>0)/len(best_trades)*100:.0f}%")

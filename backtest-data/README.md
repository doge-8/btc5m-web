# 回测数据与分析方案

## 数据格式

文件命名：
- BTC：`YYYY-MM-DD.jsonl`（保留旧命名，向后兼容历史数据）
- 其他币种：`YYYY-MM-DD-{sym}.jsonl`（如 `2026-04-26-eth.jsonl`、`2026-04-26-sol.jsonl`）

每行一条 JSON：

```json
{"type":"tick","ts":1775195098289,"symbol":"btc","windowStart":1775194800,"diff":51.16,"upPct":100,"rem":2}
```

| 字段 | 含义 |
|---|---|
| ts | 时间戳（毫秒） |
| symbol | 币种（btc/eth/sol）。**老数据无此字段时默认 btc** |
| windowStart | 所属5分钟窗口的起始时间（秒） |
| diff | 参考价 - (priceToBeat - 偏移)，正值=涨，负值=跌 |
| upPct | Polymarket 涨概率（0-100整数） |
| rem | 窗口剩余秒数 |

采样频率：每秒1条，每天约86400条，约4MB。

## 分析目标

找到 diff 和 upPct 之间的历史映射关系，当实际概率偏离历史均值时入场。

## 分析步骤

### 1. 建立 diff → 合理概率 映射

将 diff 按区间分桶（如每5一档：-60~-55, -55~-50, ..., 55~60），统计每个桶内 upPct 的中位数，得到"在某个 diff 水平下，市场通常给出的概率"。

```python
import json, glob
import pandas as pd

ticks = []
for f in sorted(glob.glob('*.jsonl')):
    for line in open(f):
        row = json.loads(line)
        if row.get('type') == 'tick':
            ticks.append(row)

df = pd.DataFrame(ticks)

# 按 diff 分桶，rem 分段
df['diff_bin'] = (df['diff'] / 5).round() * 5
df['rem_bin'] = pd.cut(df['rem'], bins=[0, 30, 60, 120, 180, 300], labels=['0-30','30-60','60-120','120-180','180-300'])

# 每个 (diff_bin, rem_bin) 的概率中位数
mapping = df.groupby(['diff_bin', 'rem_bin'])['upPct'].agg(['median', 'mean', 'std', 'count'])
```

### 2. 计算偏差

```python
# 对每条 tick，查找对应的合理概率
fair_prob = mapping.loc[(diff_bin, rem_bin), 'median']
bias = fair_prob - actual_upPct

# bias > 0：市场低估涨（买涨机会）
# bias < 0：市场高估涨（买跌机会）
```

### 3. 确定入场阈值

统计不同 bias 阈值下的入场次数和后续概率走势：

```python
# 找出 bias > N 的时刻，看之后概率是否向合理概率回归
for threshold in [5, 8, 10, 12, 15]:
    entries = df[df['bias'] > threshold]
    # 看入场后 10s/30s/60s 概率变化
    # 如果概率确实向 fair_prob 回归 → 该阈值可用
```

### 4. 考虑波动率

用 diff 序列的标准差衡量波动率：

```python
# 每个窗口内 diff 的标准差
vol = df.groupby('windowStart')['diff'].std()

# 高波动 vs 低波动时，同样 diff 对应的概率分布是否不同
# 如果不同，映射关系需要加入波动率维度
```

### 5. 输出

- diff → 合理概率 的映射表（按 rem 分段）
- 最优入场偏差阈值
- 波动率是否需要作为额外维度
- 模拟入场后的概率回归速度和幅度

## 注意事项

- 数据至少收集 2-3 天再分析（需要覆盖不同时段和市场状态）
- diff 极端值（>80 或 <-80）样本可能很少，映射不可靠
- rem 对映射有影响：窗口早期（rem>180）概率波动大，晚期（rem<30）概率趋于收敛
- 分析脚本在 backtest-data/ 目录下运行

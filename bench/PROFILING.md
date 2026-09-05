# VM 性能剖析与优化（非编译器热点）— Surge Editor scratch-vm

日期：2026-08-31 ｜ 分支：surge-editor ｜ 起点 HEAD：895d114a ｜ 基线：95081b2b ｜ 对照：TurboWarp 43f13efd

## 方法

- 负载：`bench/workloads.js` 生成 8 个代表性工程（内存构建 → sb3 zip → `vm.loadProject`），
  每个都有独立 JS 期望值校验（`verify(runtime)`），任何一次运行校验失败即整体失败退出。
- 计时：`process.cpuUsage()`（CPU 时间），1 warmup + ≥5 timed 取中位数，报 min/max。
- 构建：三线均 `NODE_ENV=production npx webpack --bail` 的 `dist/node/scratch-vm.js`（git worktree）。
- Profiling：`node --cpu-prof` + `bench/analyze-profile.js`（自耗时聚合 top-N）；
  为保留函数名用 `bench/webpack.profile.js`（production 模式、不压缩）单独构建。
  原始火焰图数据在 `bench/prof/*.cpuprofile`（Chrome DevTools → Performance 可直接打开）。
- 确定性：帧环吞吐类负载把 `runtime.currentStepTime` 压到极小（sequencer 每帧固定预算）；
  w4b 用固定帧数模式（每帧工作量与 VM 速度无关）。

## 测量协议要点（本机教训）

1. **同进程交替 A/B**（`bench/ab-suite.js`：两构建 ABABAB 交替配对）是唯一可信信号；
   本机跨进程/跨时段绝对值漂移可达 ±150%（同一构建 2.6s↔6.6s）。
2. **Windows cpuUsage 粒度 ~15.6ms**：<300ms 的负载量化噪音 ±10-17%，会伪造"回归"。
   所有负载最终放大到 ≥450ms/次。放大后 w5/w7 的"+11-17% 回归"消失（实为 −2~−3%）。
3. 热路径对象（Thread）新增字段必须在构造函数声明，否则 hidden-class 迁移吃掉全部收益
   （Opt B 第一版实测 +0.6%，修正后 −9.5%）。

## 工作负载与场景

| 名称 | 场景 | 度量 |
|---|---|---|
| w1-many-sprites | 30 角色 × repeat 40000 {change x; if x>1e9}（编译开） | 多线程帧环吞吐 |
| w2-interpreter | 编译关，warp 过程 2M {change x by 1; if gt; set} + 20 广播 | primitive 分发/参数装箱 |
| w3-clone-storm | 250 常驻克隆 + 20000 快生快灭 | 克隆生命周期与 hat 扫描 |
| w4-sensing-edge | 5 角色 × 400000 {timer; mouse x; key pressed?} | 每帧感知读取 |
| w4b-frame-overhead | 50 角色 50 edge hat + 20 可见监视器，5000 空转帧 | 每帧固定开销 |
| w5-broadcast | 两角色 ping-pong 250000×2 广播 | 事件分派 |
| w6-list-head | 40000 长列表 × 40000 次 insert@1 + delete@1 | 非数值索引路径 |
| w7-string-join | 10M × (letter of + join + change) | 字符串拼接与内存 |

## Top 非编译器热点（profiling 结论）

| 负载 | 热点（自耗时占比） | 处置 |
|---|---|---|
| w2 | stepThread 27.7% + execute 25.0%（分发骨架）；**timeElapsed 7.3%**；**lookupVariableById+lookupOrCreateVariable 8.2%** | Opt B、D；分发骨架不动（风险>收益） |
| w3 | **uid() crypto ~20-28%**（randomFillSync 12.1% + uid 7.7%）；Clone.simple(JSON round-trip) 8.9%；**disposeTarget filter 分配 4.7%** | Opt A；Clone.simple 不动（对象极小） |
| w4b | GC 10.9%；_pushThread 7.6%；startHats 7.6%；tryCompile 3.6%；allScriptsByOpcodeDo 3.2% | Opt C（去 for-in/去每帧 spread）；线程池化否决（见下） |
| w5 | stepThread 11.8%；GC 10.3%；_pushThread 6.0%；startHats 4.1%；匹配回调 4.0% | Opt C |
| w1/w4/w6/w7 | 编译产物内部（gen*_hot、splice/join 原生）+ node loader 噪音 | 无显著非编译器热点（前次编译器工作已覆盖） |

## 优化项（每项一个 commit）

| # | commit | 内容 | 主目标 | 实测（交替 A/B，head-pre→final） |
|---|---|---|---|---|
| A | `d838e8c5` | 克隆进程内快速 ID（免 crypto）+ disposeTarget 原地删除 | w3 | **−43.6%**（1391→500ms 单测口径；全量 610→344ms） |
| B | `70f29f28` | 解释器 warp 计时器节流（每 32 查钟，近 80% 预算逐次）+ Thread 字段构造期声明 | w2 | **−9.5%**（单独）；与 D 合计 −23.9% |
| C | `fb799275` | 帧环固定开销：edge-hat 列表缓存、_step 去每帧双 spread、startHats for 替 forEach | w4b/w1 | w1 **−6.0%**；w4b −3.3%（累计口径 −13.7%） |
| D | `5eed8f09` | variables 空原型字典 + lookupVariableById 直读（免双 hasOwnProperty） | w2/w4/w6 | w2 合计 −23.9%；w4 −0.3%、w6 +0.2%（中性） |

最终全量（放大后负载，pairs=7，head-pre vs final）：
w1 −6.0% ｜ w2 −23.9% ｜ w3 −43.6% ｜ w4 −0.3% ｜ w4b ≈0 ｜ w5 −2.1% ｜ w6 +0.2% ｜ w7 −3.3%

## 红线（不得退步）

10M 快排（warp-on，src 交替 A/B，9 对）：head-copy(干净HEAD) 中位 5828ms → final 5703ms =
**−2.1%（无退步，略升）**；warp-off 3 对：4141→3875ms = **−6.4%（无退步）**。
绝对值 ~5.7s 与前次会话 6.5s 口径一致（机器负载差异内）。

## 帧环平滑度（跑酷类）

`bench/frame-jitter.js`（30 角色工程，600 帧逐帧间隔，head-pre/final 各 2 轮交替）：
mean 0.015/0.016 vs 0.009/0.014ms，p99 0.094-0.11 vs 0.059-0.159ms，同量级无系统性恶化；
tw-frame-loop.js 未改动，_step 只减分配（GC 压力下降）。

## 放弃项与原因

- **startHats threadId 缓存到 RuntimeScriptCache**：克隆共享 blocks 容器 → 缓存条目跨 target
  复用，克隆会拿到原角色的 threadMap 键 → 语义破坏。实现后回退。
- **Thread 对象池**：broadcastAndWait 跨帧持有线程引用并做 `threads.indexOf(thread)`，
  回收对象会造成假命中 → 死等/行为改变。否决。
- **感知键名缓存（w4 ~2%）、Clone.simple 手写克隆（w3 ~9%）**：低于噪音线或收益/风险比差。
- **stepThread/execute 分发骨架重构**：27.7%+25% 的大头，但任何改动都触及全部语义路径，
  单独立项才可行。

## 受益作品类型

- **克隆密集型**（射击弹幕、粒子、平台跳跃刷怪）：Opt A，−40%+ 克隆生命周期开销。
- **解释器重计算**（未用 warp 编译优化的老作品、大量自定义过程在编译失败回退时）：Opt B+D，−24%。
- **多角色 60fps 跑酷/群戏**：Opt C 每帧固定开销 −6%，GC 抖动源减少。
- **广播驱动状态机**（菜单/关卡切换）：Opt C/D 小幅收益。
- 纯编译计算路径（列表排序、字符串处理）：持平（前次会话已优化，本次未动不退步）。

## 复现

```sh
node bench/gen-workloads.js            # 无需——负载在内存构建
node bench/run-workload.js w3-clone-storm --runs 6            # 默认 src
node bench/run-workload.js w3-clone-storm --vm dist/node/scratch-vm.js
node --expose-gc bench/ab-suite.js --vmA <A.js> --vmB <B.js> --pairs 7
node --expose-gc bench/ab-quicksort.js --vmA <head-src> --vmB src/index.js --pairs 9
node bench/frame-jitter.js --vm dist/node/scratch-vm.js
# profiling:
npx webpack --config bench/webpack.profile.js --bail
node --expose-gc --cpu-prof --cpu-prof-dir bench/prof bench/run-workload.js <name> --vm bench/dist-profile/scratch-vm.js --runs 2
node bench/analyze-profile.js bench/prof/<file>.cpuprofile 25
```

## 回滚

```sh
git revert 5eed8f09   # D 变量字典
git revert fb799275   # C 帧环固定开销
git revert 70f29f28   # B warp 计时器节流
git revert d838e8c5   # A 克隆快速 ID
# 或整体：git revert --no-commit 5eed8f09 fb799275 70f29f28 d838e8c5 && git commit -m "revert perf batch"
```

## 门禁记录（每 commit）

- `npx eslint src/`：0 错误（每次提交时）。
- `test/integration/execute.js`：224/224（A/B/C/D 各自验证；机器满载时 5s 线程排空限制会偶发
  "time limit reached" 假阳性，空闲复跑即过，head-copy 干净 HEAD 同机对照确认非回归）。
- `test/unit/*.js`：95/97（project_changed_state、tw_stored_settings 为预存 renderer 失败；
  沙箱内 dispatch.js worker-spawn EPERM 属环境限制，沙箱外通过）。
- 编译快照（test/snapshot）：本次 4 项均不改 codegen，快照零变化（未 --update）。

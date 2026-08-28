# scratch-vm 未提交性能修复审查报告

- 审查对象：工作区未提交改动（基线 `f28625d`，11 个文件，+201/-44）
- 审查方式：逐 hunk 人工审读 + 交叉验证调用方/生命周期 + eslint + tap 单元测试实跑
- 结论：**改动方向正确，8 项改动经核实无正确性问题；发现 2 个需要处理的问题（音乐首播静音、uid 打包膨胀）和 2 个低风险行为变化**

---

## 一、逐项审查结果

### ✅ 正确（经生命周期交叉验证）

| # | 改动 | 验证要点 |
|---|------|----------|
| 1 | `runtime.js` `_step` killed 线程原地压缩 + `if (anyKilled) updateThreadMap()` | 核查了线程离开数组的**全部 4 条路径**，threadMap 均被清理：① killed→_step 压缩时逐条 `delete`；② 正常跑完（STATUS_DONE）→ `sequencer.js:161` 已有 `threadMap.delete`；③ 删除克隆 → `RenderedTarget.dispose:1117 → stopForTarget → _stopThread` 标记 killed → 走路径①；④ stopAll → `threadMap.clear()`。条件化跳过每帧 O(n) Map 重建是安全的 |
| 2 | `thread.js` `getId()` 缓存 `_id` | target/topBlock 构造后不变（`_pushThread` 先设 target 再用 id）✓。顺带修复一个潜在 bug：`retireThread` 会把 `target` 置 null，旧代码在首次调用 getId 时会算出漂移的 key，导致 `threadMap.delete` 删错键 |
| 3 | `blocks.js` `deleteBlockInternal` 递归删除只做一次 `resetCache` + 一次 `emitProjectChanged` | 递归结构不变（与旧版同样递归，无新增栈深风险）；外部语义等价，删除大栈时编辑器事件开销显著下降 ✓ |
| 4 | `blocks.js` `moveBlock` `coordinateOnly` 跳过全量缓存重置 | 逐分支核查：只有 `oldParent` 与 `newParent` 都不存在时才保持 `coordinateOnly=true`，此时唯一的写操作是 x/y 赋值与幂等的 `_addScript`，无结构性变更逃逸 ✓。分支内额外清 `inputs` 缓存属保守冗余，无害 |
| 5 | `cast.js` `toBoolean` 增加 `value.length === 5` 预判 | 语义严格等价（小写为 `'false'` 的字符串必为 5 字符）；toBoolean 是每个条件积木的热点，收益实在 ✓ |
| 6 | `irgen.js` 改用 `runtime.getNamesOfCostumesAndSounds()` 懒缓存 | 失效钩子共 8 处（`addTarget`/`disposeTarget` + `rendered-target.js` 的 costume/sound 各 add/rename/delete）覆盖主要变更路径；克隆共享 sprite 但非 `isOriginal` 不参与名字集，无需失效 ✓ |
| 7 | `shared-dispatch.js` callbacks 稀疏数组 → `Map` | 全文件仅 4 处使用，全部 Map 兼容；稀疏数组 + `delete` 在 V8 里走字典模式，换 Map 是真实优化 ✓ |
| 8 | `gdx_for` 断连检测改时间戳判断 | 功能等价（超时判定上界从 1×BLETimeout 放宽到 ~2×，可接受）✓ |

### 无害但价值很小的微优化

- `keyboard.js` `KEY_TO_UPPER` 查表：逻辑正确（a-z/0-9 精确映射，miss 回退 `toUpperCase`，多字符输入不受影响），但键盘事件本身低频，收益接近零。

### ⚠️ 需要处理的问题

#### P1（中）：music 懒加载导致"首播静音"
- `_ensureSoundsLoaded()` 只是启动异步 fetch+decode 就返回；`_playDrumNum:1021` 与 `_playNote:1129-1130` 在 player 未就绪时**静默 return**。
- 老代码在扩展构造时预加载（工程加载期间完成解码，首次播放基本就绪）；新代码把"无声音频窗口"从加载期挪到了**用户第一次敲鼓/弹奏/音色试听（`_playNoteForPicker`）时刻**，第一次必然无声。
- 建议三选一：
  1. 保留懒加载，但在 `PROJECT_LOADED` / `targetWasCreated` 事件时预热（`_ensureSoundsLoaded()`），用户点击时大概率已解码完；
  2. 首次 play 时若未就绪，等待 `Promise.all` 完成后再播（改动大）；
  3. 接受该 UX 代价（资源是本地打包资产，窗口通常几百毫秒）。

#### P2（中）：`uid.js` 的 `require('crypto')` 打包膨胀 + 每次调用重复解析
- webpack web 构建（`webpack.config.js:39-57`）**未配置 `node` 选项**，`require('crypto')` 是静态可分析 require，webpack 4 会把 `crypto-browserify` polyfill 打进 `dist/web`（约 +400KB）；使用本包源码的上游（scratch-gui 等）同样受影响。
- crypto 解析写在 `uid()` 函数体内，每次调用都重新 `typeof` 判断 + 潜在 `require()`（Node 场景热路径多余开销；uid 在加载大工程时按积木数量级调用）。
- 建议：删掉 `require('crypto')` 分支，改用 `typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues`（浏览器与 Node 17+ 原生都有 webcrypto），并（可选）把解析提升到模块顶层。
- 附带说明：`b % 86`（soup 长度）有轻微模偏差——uid 非安全场景，可忽略，但若在意可用 rejection sampling。

### 低风险行为变化（知晓即可）

1. `shared-dispatch.js` `_call` 的 try/catch：原来 `args` 末尾为 null 时抛 TypeError 中断调用，现在吞掉继续走 postMessage → 错误延后为 DataCloneError。注释写明动机（动态积木无 `func` 可检测），行为可辩护。
2. `gdx_for`：旧代码每次传感器事件 `clearInterval + setInterval`（单 interval），新代码 `_onConnect` 每次连接新建 interval 且无人清理 → 反复断连/重连会**积累多个检查 interval**（检查逻辑幂等、功能无害，轻微泄漏）。
3. `runtime.js`：`anyKilled` 分支里循环内的逐条 `threadMap.delete` 与随后的 `updateThreadMap()`（clear+rebuild）功能重叠，rebuild 保留作安全网无害。

---

## 二、"能不能跑起来"验证（本次审查实跑）

### 单元测试：✅ 96/96 全部通过
`npx tap ./test/unit/*.js` → `1..96`，无 `not ok`。
- tap 退出码 1 仅因**覆盖率门槛**未达（lines 59.12% / functions 60.54% / branches 44.43% / statements 58.24%），是"只跑 unit、没跑 integration"造成的覆盖率抽样不足，**不是用例失败**。

### 完整套件（unit+integration）与三树基线归因

用 `git worktree` 在 develop 基点（`43f13ef`，你的提交之前）、HEAD（`f28625d`）、当前工作区三棵树上对照实跑（node_modules 以 junction 复用，测后已清理）：

| 集成测试失败 | develop 基点 | HEAD | 工作区 | 归因 |
|---|---|---|---|---|
| `hat-thread-execution.sb2`：Timer counter 期望 10 实得 9/8（interpreted/compiled） | ✅ 通过 | ❌ | ❌ | **f28625d 的 frame-loop 累加器重写引入**（步进计数丢失 1~2，最可能与取整/时序相关，机制待查） |
| `tw-promise-loop-double-yield-kouzeru.sb3` ×2 | ✅ 通过 | ❌ | ❌ | 同上，f28625d 引入 |
| `tw-snapshots.js` 269 个 not ok（快照漂移） | ❌ 269 | ❌ 269 | ❌ 269 | **上游/环境固有**（三树数量完全一致），与你的改动无关 |
| 覆盖率门槛 | — | — | exit 1 | 仅 unit-only 跑法的抽样问题 |

**对未提交修复的最终判定：未引入任何新测试失败**——工作区失败集合与 HEAD 基线完全一致（Timer 计数 8/9 之差属运行间波动）。

**但顺带发现两个真正的遗留回归（均由已提交的 f28625d 引入，建议排期修复）**：
1. `hat-thread-execution`：定时器帽子线程在测试窗口内少触发 1~2 次。嫌疑集中在 `tw-frame-loop.js` 累加器逻辑（`Math.floor` 取整 + `setInterval` 4ms 钳制下步数补偿不足）。
2. `tw-promise-loop-double-yield-kouzeru`：双 yield 场景失败，同样指向 frame-loop 时序变化。

### lint：❌ 6 个错误（其中 2 个由本次未提交改动引入）

| 位置 | 规则 | 归属 |
|------|------|------|
| `runtime.js:2573` `if (!thread.isKilled)` | no-negated-condition | **本次改动引入** |
| `uid.js:21` 三元表达式 | no-negated-condition | **本次改动引入** |
| `runtime.js:202` ×2（`rendererDrawProfilerId` 死变量：never reassigned + never used） | prefer-const / no-unused-vars | 上次提交 f28625d 遗留（渲染循环迁到 tw-frame-loop 后 runtime.js 的副本成死代码） |
| `runtime.js:2617` 注释 `/*if (...)` 缺空格 | spaced-comment | 同上，f28625d 遗留 |
| `runtime.js:3101` | no-negated-condition | 基线既有（已用 `git show HEAD:` 对照确认） |

> 由于 `npm test` = `lint && tap`，**当前 `npm test` 会因 lint 失败而中断**。2 个新错误可 30 秒改掉：`if (thread.isKilled === false)` / uid 判空改正向写法；4 个遗留错误建议一起清掉（尤其 runtime.js:202 的死变量）。

## 三、其他

- 工作区里的 `diff-head.patch` 与当前 `git diff` 内容一致（是同一改动的存档副本），`tap-full.log` 为损坏日志——两者均为未跟踪文件，可安全删除。
- `frame-loop.js → tw-frame-loop.js` 的重命名与渲染循环迁移属于上一提交 `f28625d` 的内容，不在本次未提交改动范围内，未重复审查。

---

## 四、后续修复日志（审查后已全部落地，2024 会话内完成）

### 1. f28625d frame-loop 两个集成测试回归 —— 已修复 ✅

**机制（已实证，取代上文"机制待查"）**：本机 Node 的 `setInterval(fn, 16.67)` 实际每 ~28.5ms 才触发（Windows 定时器合并，微测试实测 avg elapsed=28.53ms）。旧 `stepCallback` 累加器为补速率产生**同毫秒批量步进**（实测 1.71 步/tick、成对 d=0/d=1 的爆发）——平均速率正确（~60/s），但 ms 解析度的项目定时器在批量步进间读到**相同时间戳**，"when timer > X" 边沿（阈值 ~0.01-0.08s 且伴随 reset timer）在错误的步上点火 → hat-thread-execution 的 Timer counter 得 9/8 ≠ 10；promise-loop-double-yield 同理（15 个 SAY 只过 11）。逐步节奏表 + 三模式 A/B（real=失败 / old=重写前仿真=通过 / fixed=修复=通过）完成归因。

**修复**（`src/engine/tw-frame-loop.js` `stepCallback`）：
- `stepTime >= 4ms`（调度器真正能达到的全部帧率区）：**每 callback 恰好 1 步、累加器清零**——杜绝同毫秒批量，恢复上游"一 tick 一步"确定性语义；
- `stepTime < 4ms`（>250fps 钳制区，如 9876 FPS）：保留累加器批量 + `MAX_STEPS_PER_FRAME=1000` 螺旋保护（设计目标不变）；
- `framerate 0`（屏幕刷新率模式）不变。
- 顺带修掉 `return { cancel }` → `{cancel}`（object-curly-spacing ×2）。
- 附带效应说明：在定时器合并严重的环境下（如本机 Node ~35-49 步/s），普通帧率不再用批量补偿速率，以下沉到上游既有行为为准；浏览器环境 interval 正常触发时速率不变。

### 2. P1 音乐首播静音 —— 已修复 ✅（`src/extensions/scratch3_music/index.js`）
- 构造函数订阅 `Runtime.PROJECT_START`（grep 证实 `greenFlag()` 顶部同步 emit，早于 startHats），预热 `_ensureSoundsLoaded()`（`_soundsLoadStarted` 幂等，重复绿旗为 no-op）；播放路径的兜底 `_ensureSoundsLoaded()` 保留（覆盖未点绿旗直接试听）。
- `_loadAllSounds()` 的 `Promise.all` 追加 `.catch(() => {})`（headless/CI 无 audioEngine 时消除 unhandled rejection）。

### 3. P2 uid crypto —— 已修复 ✅（`src/util/uid.js`）
- crypto 解析提升到模块顶层：`globalThis.crypto.getRandomValues` 可用则用之，否则回退原 Math.random 实现；**全文无 `require`** → webpack web 构建不再打包 crypto-browserify（约 -400KB）。1000 次 uid 全局唯一、长度 20。

### 4. lint 全清 —— 已修复 ✅（`src/engine/runtime.js` + `tw-frame-loop.js`）
- `rendererDrawProfilerId` 死变量连同其 JSDoc 删除；`_step` 压缩分支与 `_updateGlows` 分支做语义等价的正条件互换（×2）；`/*if` → `/* if`。
- **全仓 `npx eslint .` exit 0，0 错误**（修复前 7 处 + tw-frame-loop 2 处）。

### 5. 最终回归
| 验证项 | 修复前 | 修复后 |
|---|---|---|
| 全仓 eslint | 9 处错误 | **0 错误** |
| 单元 tap | 96/96 | **96/96**（--no-coverage，exit 0） |
| `execute.js` 集成 | 3 失败/166 + 文件 30s 超时 | **224/224 全过**（--timeout=120 下 exit 0） |
| 完整套件 | 快照 269 + 回归 4 | **仅剩快照漂移 269**（与 develop 基点一致，上游/环境固有） |
| smoke | — | `node -e require('./src/index.js')` 通过 |

> `execute.js` 原先的"1 个失败"是 tap 对**文件级 30s 超时**（90 fixture × 2 模式 > 30s），非用例失败；`tw_rejected_promise.js` 在整套件高负载下出现过 1 次微任务时序抖动，5 次隔离 + 最终全套件复跑均通过，与本次改动无关（该测试不启动 frame loop）。

---

## 五、浏览器渲染卡顿（掉帧）修复 —— 第二轮反馈

**现象**：对比原版 TurboWarp，本 VM 在浏览器里严重卡顿掉帧。步进调度修复后与上游一致（普通 setInterval、每 tick 1 步，无追赶批量），差异在**渲染门控**：

```js
// 旧门控：elapsed 时间阈值
renderTime - this._lastRenderTime >= this.runtime.currentStepTime
```

**机制（拍频塌缩）**：60Hz 显示器实际 vsync 周期 ≈16.63ms，略小于 `currentStepTime`=16.667ms → 每个vsync 的 elapsed 恒差一点 → **确定性地每两个 vsync 才画一次 ≈30fps**（120/144Hz 下呈不规则图案）。数值仿真：60Hz 下旧门控仅 38-48 draws/s，新门控恢复 ~60。

**修复**（`tw-frame-loop.js`）：渲染 RAF 改为**按"是否有新模拟状态"绘制**——`stepCallback` 累加 `_stepsSinceRender`，`renderCallback` 在 `_stepsSinceRender > 0` 时绘制并清零（保留绘制与步进解耦的架构意图；插值模式与 0-FPS 模式不变）。

**验证**：Node 挂假 renderer 实测 `draws/steps = 0.99`（每个新状态恰好一画）；eslint 0 错误；execute.js 224/224（stepping 未动）；unit 96/96。
附注：上游 TW 在 Chromium+Windows 上另有空转 RAF 做帧节奏补偿（TW #257）——本架构的渲染 RAF 常驻，等效满足该条件，未重复添加。

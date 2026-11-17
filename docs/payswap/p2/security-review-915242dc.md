# 915242dc 独立安全复审记录（PR #46 合并前置项）

> **复审人**：TL · **日期**：2026-11-17（晚间）· **对象**：commit `915242dc`
> （acceptance runner fail-closed hardening — 三架构评审缺陷关闭）在**当前拆分面**
> 上的行为：`scripts/payswap/windows/runner-redaction.cjs` / `manual-evidence.cjs` +
> `scripts/payswap/acceptance-verdicts.cjs` + 两 runner 的接线（windows
> `run-p2-acceptance.cjs` / linux `run-p2-acceptance.cjs`）。
> **方法**：逐行通读 + **独立对抗样本**（不复用仓库矩阵，自建探针脚本已入仓：
> `scripts/payswap/security-review-915242dc.probes.mjs`）+ 双矩阵复跑 + lint 基线核对。

## 结论（一句话）

**有条件通过 → 条件已在本分支内修复**：核心防线（跨 chunk 脱敏、退出码闭集、
preflight 失败关闭）在 2036 次对抗攻击下零泄露；但复审发现 **2 个真实缺陷**
（均在人工回执校验面，非脱敏引擎），已修复并带回归覆盖。修复后：windows 矩阵
**25/25**、linux 矩阵 **19/19**、探针 **2052/2052 全挡**、改动文件 **0 新增
lint 警告**。

## 发现

### F1（高，已修复）—— Linux 腿人工回执被 win32 硬编码卡死

- **症状**：`validateManualEvidence` 的 Platform attestation 校验硬编码
  winver 形态 `10.0.\d+`；linux runner（`stageConversationAcceptance`）原样调用
  → **Linux 验收机的 13 步回执永远 FAIL**（除非操作者伪填 Windows 版本号 =
  不诚实证据）。连带：`renderManualChecklist` 在 Linux 腿发出的清单头部印着
  **windows runner 路径（反斜杠）+ "winver" 字样** —— 自相矛盾的操作面。
- **影响面**：P2-Linux 关闭路径的最后一个阶段（conversation-acceptance 的
  `--manual-evidence` 回执校验）—— 正是交接文档 §1C 登记的操作者路径。
- **修复**：`manual-evidence.cjs` 平台参数化 ——
  `renderManualChecklist(platform)` / `validateManualEvidence(text, secret, platform)`；
  缺省 `"win32"`（= windows runner 与其 24 例矩阵的既有契约，逐字节不变）；
  两 runner **显式**传参（不允许按宿主静默推断 —— 跨平台跑矩阵会漂移）。
  linux 分支：Platform 行须含内核版本（uname 形态 `\d+\.\d+\.\d+`）且**拒绝
  Windows 字样**（两腿互不替代是登记条款）。清单模板按腿生成（Linux 腿：
  linux runner 路径 + `uname -a output` 标签）。
- **回归**：linux 矩阵 +5 例（合法 Linux 回执过 / Windows 形态被拒 / 缺内核
  版本被拒 / 缺省仍 win32 契约 / 清单头部指向正确）。

### F2（中，已修复）—— attestation 空值检查的跨行借用（\s* 缺陷类残留）

- **症状**：`Operator` 与 `Date/time` 的空值检查仍是 `\s*\S` —— `\s*` 跨行
  吞掉换行后把**下一行首字符当值**，空 Operator/Date 行照样过。这正是
  915242dc 缺陷 B 在 Observed 上修掉的同类问题（`[ \t]` 作用域），但 attestation
  两项漏修。另发现 Date/time 的 alternation 顺序缺陷：`(Date\/time|Date\/time
  \(local\))` 先匹配短形态，令 `"(local)"` 后缀本身成为"值" —— 空值 +
  `(local)` 形态也过。
- **发现方式**：本复审的独立探针（探针 2036+16 次，唯一命中的两个绕过即此）。
- **修复**：`Operator:[ \t]*\S` + `(?:Date\/time \(local\)|Date\/time):[ \t]*\S`
  （长形态优先 + `[ \t]` 作用域）。
- **回归**：windows 矩阵 +B10（4 断言：空 Operator / 空 Date(local) / 值在
  下一行 / 空值+(local) 形态）。

### F3（无发现）—— RedactingLog 跨 chunk 置换引擎

2036 次对抗攻击零泄露、输出与一次性置换**逐字节一致**：
全部单点分裂边界（0..len）、逐字节投喂、单 chunk 多次出现、跨 chunk 多次
出现、自重叠凭据（`abab` in `aabababb`）、2000 轮随机 fuzz（随机文本 ×
随机次数 × 随机切分）。尾部扣留（`longestSecretPrefixSuffix`）、flush 兜底
置换、落盘前不变量硬失败（宁可不写也不写原文）均按设计成立。引擎经受住
复审，无需改动。

### F4（无发现）—— 裁决闭集与 fail-closed 接线

`acceptance-verdicts.cjs`：NOT-RUN 按失败序（`?? 1`）、假设集合把退出码
钉到 ≥2（永不转绿）、泄漏翻盘（所有 PASS→FAIL）均为纯函数且两 runner 共享
（防漂移的本意成立）。两 runner 的 preflight 接线核对：不可用 preflight →
无阶段执行（fail-closed）、缺记录 → FAIL（absence is never permission）、
`executable:false` → 诚实 SKIP。与 915242dc 缺陷 C 的承诺一致。

## 复现

```bash
node scripts/payswap/security-review-915242dc.probes.mjs   # 退出 0 = 全部探针被挡
node --test scripts/payswap/windows/run-p2-acceptance.test.mjs   # 25/25
node --test scripts/payswap/linux/run-p2-acceptance.test.mjs     # 19/19
```

## 裁决

- 915242dc 的**三缺陷修复本体**（跨 chunk 脱敏 / 13 步严格校验 / preflight
  失败关闭）复审通过；两个新缺陷（F1/F2）为拆分复用面上的遗漏，**已在本
  分支修复**（`manual-evidence.cjs` 平台参数化 + attestation 作用域修复 +
  双矩阵回归覆盖）。
- 合并建议：PR #46 在操作者终局验收 run（键供给 + onboarding 完成后）通过、
  退出码 0 后合并；本复审不再阻塞合并。
- 本记录与 [live-acceptance-evidence.md](live-acceptance-evidence.md) §8.5、
  [LINUX-P2-CLOSURE-HANDOFF.md](LINUX-P2-CLOSURE-HANDOFF.md) §1 同链。

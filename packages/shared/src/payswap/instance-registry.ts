/**
 * PaySwap 实例注册表（契约 w2-01 §10；host 进程私有、内存态）。
 *
 * 纪律（§10.1，normative）：append/tombstone only —— 条目**永不就地改写**（re-spawn 是
 * 新 instanceId，旧条目 tombstone）。注册发生在 spawn 时：token、instance id、child pid、
 * plugin registration identity、workspace、session scope、spawn time 同批入表。
 *
 * 纪律（§10.2(1) rev 2a，F13）：tombstone 带**原因**，且原因在 tombstone 时一次性设定
 * （append-only：重复 tombstone 不改写原因）—— 原因选择该实例残留调用收到的拒绝：
 * exit-tombstoned → `instance_unknown`；disable-tombstoned → `financial_mode_disabled`。
 *
 * 纪律（§10.2(2)）：插件 disable/uninstall 在 host 侧撤销其全部 live 绑定
 * （revokePluginInstances，reason "disabled"）—— 其它插件的实例不受影响。
 *
 * 未知 id 的 lookup 返回 undefined 且**不产生任何状态**；状态只经 register 产生。
 */

/** 注册表条目（§10.1；冻结存储，永不就地改写）。 */
export interface PayswapInstanceRegistryEntry {
  instanceId: string;
  /** per-instance 256-bit hex token（§4.1；仅 host 内存，绝不外泄）。 */
  token: string;
  childPid: number;
  /**
   * 子进程可执行映像路径（spawn 观察面记录；ADR-14 D14.8）。win32 §5.3(1) 管道口门的
   * 期望映像输入（stdio transport 的 spawnfile）；POSIX 臂忽略此字段（§5.1 的
   * pid/uid 凭据读取不含映像维度）。缺省/缺席 = win32 门无法核验映像 → 该 pid 的
   * 客户端在管道口被弃（§5.3(4) fail-closed）。
   */
  childImagePath?: string;
  /** 官方插件注册身份（host 验证过的 identity，§1.5；如 `payswap@zcode-plugins-official`）。 */
  pluginRegistrationIdentity: string;
  workspace: string;
  sessionScope: string;
  /** spawn 时间（epoch ms）。 */
  spawnedAt: number;
}

/** tombstone 原因闭集（§10.2：exit = 子进程退出；disabled = 插件禁用/卸载；superseded = 重启取代）。 */
export type PayswapInstanceTombstoneReason = "exit" | "disabled" | "superseded";

export type PayswapInstanceLookupResult =
  | { status: "live"; entry: Readonly<PayswapInstanceRegistryEntry> }
  | { status: "tombstoned"; reason: PayswapInstanceTombstoneReason };

export interface PayswapInstanceRegistry {
  /** 注册一个 live 实例（条目冻结存储；append-only —— 已 tombstone 的 id 不复活）。 */
  register(entry: PayswapInstanceRegistryEntry): void;
  /** live → `{status:"live", entry}`；tombstoned → `{status:"tombstoned", reason}`；未知 → undefined。 */
  lookup(instanceId: string): PayswapInstanceLookupResult | undefined;
  /**
   * tombstone 一个 live 实例（原因一次性设定，重复 tombstone 返回 false 且不改写）。
   * 未知 id 返回 false 且不产生状态（§10.1）。
   */
  tombstone(instanceId: string, reason: PayswapInstanceTombstoneReason): boolean;
  /** 撤销某插件身份的全部 live 实例（reason "disabled"），返回被撤销的 instanceId 列表。 */
  revokePluginInstances(pluginRegistrationIdentity: string): string[];
  /** 全部 live 条目（冻结对象；新数组）。 */
  listLive(): Readonly<PayswapInstanceRegistryEntry>[];
}

type RegistryRecord =
  | { status: "live"; entry: Readonly<PayswapInstanceRegistryEntry> }
  | { status: "tombstoned"; reason: PayswapInstanceTombstoneReason };

export function createPayswapInstanceRegistry(): PayswapInstanceRegistry {
  // Map 保插入序（listLive 的顺序即 spawn 顺序）；host 进程私有，无持久化（§10.3）。
  const records = new Map<string, RegistryRecord>();

  return {
    register(entry) {
      const existing = records.get(entry.instanceId);
      if (existing?.status === "tombstoned") {
        // append-only：tombstone 是该 id 的终局；re-spawn 必须用新 instanceId（§10.1）。
        return;
      }
      // 冻结快照：注册表拥有自己的副本，调用方引用无法穿透改写表内状态。
      records.set(entry.instanceId, { status: "live", entry: Object.freeze({ ...entry }) });
    },
    lookup(instanceId) {
      return records.get(instanceId);
    },
    tombstone(instanceId, reason) {
      const record = records.get(instanceId);
      if (!record || record.status !== "live") {
        // 未知 id 不产生状态；已 tombstone 的不改写原因（append-only，§10.2(1) rev 2a）。
        return false;
      }
      records.set(instanceId, { status: "tombstoned", reason });
      return true;
    },
    revokePluginInstances(pluginRegistrationIdentity) {
      const revoked: string[] = [];
      for (const [instanceId, record] of records) {
        if (record.status !== "live") continue;
        if (record.entry.pluginRegistrationIdentity !== pluginRegistrationIdentity) continue;
        records.set(instanceId, { status: "tombstoned", reason: "disabled" });
        revoked.push(instanceId);
      }
      return revoked;
    },
    listLive() {
      const live: Readonly<PayswapInstanceRegistryEntry>[] = [];
      for (const record of records.values()) {
        if (record.status === "live") live.push(record.entry);
      }
      return live;
    },
  };
}

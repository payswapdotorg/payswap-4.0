/**
 * payswap-broker 对外契约（P1.3 Step 3，契约 w2-01 §3、§5、§10、§11）。
 *
 * 本模块是 PaySwap broker 的 **host 侧运行时**：UDS 端点落位与引导（含启动期自探针）、
 * §5.5 检查序（对等验证 → 解析+上限 → token → 实例/注册表绑定）、签名响应、生命周期与
 * 审计 ingress。协议数学（canonical JSON / 信封签名 / 注册表）在 `@zcode/shared/payswap`
 * —— 两处不得漂移（§6.4(5) 单一实现纪律）。
 *
 * 不变量（违反即实现缺陷，不是风格问题）：
 * 1. §5.5 检查序不可重排：未知 pid 在**任何载荷字节被解析之前**丢弃；token 比对对象是
 *    对端 pid 映射实例的 token（claim 永不被采纳，§5.2(3)）。
 * 2. §5.4 fail-closed：对等凭据子系统不可用 → degraded_refusing（socket 照常绑定，
 *    每个请求 peer gate 即拒）；token-only 回退被禁止。
 * 3. 一切响应经 signResponseEnvelope 签名（§6.5(2) v1 无未签名模式）；pre-binding 拒绝
 *    一律 null-bound（§6.4(3)）。
 * 4. failPeer = end + resume（D5.4）：错误行完整可达对端，剩余字节消费-丢弃、绝不解析。
 * 5. close()：先摘 socket 路径，live 连接宽限（默认 250 ms）后强断，finally 无条件清理
 *    端点文件与 per-boot 目录（ADR-6）；幂等。
 * 6. 审计 ingress 只记 typed code（§11），token / verify key / endpoint path 永不入审计。
 *
 * 幂等/持久化：全部内存态、无持久化（§10.3：重启即全新 instanceId 空间）；per-boot 目录
 * 随 close() 消亡。事件：auditSink 回调（boot / dispatched / refused / shutdown）。
 *
 * 后续（不在本步）：Step 6 的重放引擎（§9 水标）、Step 5 的权威 session 解析（§8）、
 * P1.3b 的 Windows native helper（§5.3）。Step 4（请求 schema / 闭集 dispatch /
 * 三码法则 / 宿主接线）已落地：dispatch.ts + payswap-broker/spawn-wiring.ts。
 */
export interface PayswapBrokerContract {
  // 公共面即 index.ts 再导出的具名导出（见各文件 per-method 契约注释）；本接口保留为
  // managed-module 惯例占位，不聚合方法签名。
}

/**
 * server-payswap 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 消费方是 packages/server/src/http.ts（financial 部署装配：中间件变体 + /ws 守卫 +
 * operator-session 端点）与 entry-http.ts（部署级激活）；本示例只触达模块自有面 ——
 * 激活法则 + 状态 owner 的 admin API（网络端点永不承载 provisioning —— D11.7）。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPayswapOperatorStore,
  resolvePayswapFinancialActivation,
} from "./index.js";

export async function examplePayswapOperatorLifecycle(): Promise<void> {
  // (1) 部署级激活（N27）：financial 是显式请求 + deployment 凭据前置 —— 拒绝即
  //     非零退出，绝不弱姿态启动（entry-http 的调用形态）。
  const activation = resolvePayswapFinancialActivation({
    requested: true,
    deploymentAuthToken: process.env["ZCODE_SERVER_AUTH_TOKEN"],
  });
  if (activation.status === "refused") {
    throw new Error(`financial activation refused: ${activation.code}`);
  }

  // (2) 状态 owner（持久化：0600 + 原子写；digest-only —— 状态里只有 sha256(token)；
  //     sessions/challenges 内存态，重启即失效）。
  const store = createPayswapOperatorStore({
    stateFilePath: join(await mkdtemp(join(tmpdir(), "payswap-")), "operators.json"),
  });

  // (3) admin API（宿主进程内 —— 网络端点永不承载 provisioning）：provision 的明文
  //     token 恰在此一次性返回；http.ts 侧的两级握手由此 store 驱动
  //     （payswapFinancial: { store }）。
  const operator = await store.provisionOperator({
    name: "alice",
    roleBindings: [{ ledgerId: "default", roles: ["approver", "viewer"] }],
  });
  void operator.token;

  // (4) 生命周期：rotation 窗口内新旧皆有效；撤销立即关闭该 principal 的全部连接
  //     与 pending challenges（principal 域 —— D11.3）。
  const rotated = await store.rotateOperatorCredential(operator.operatorId);
  void rotated.token;
  await store.revokeOperatorCredential(operator.recordId);
}

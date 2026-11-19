using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// PaySwap P1.3 Windows §5.3 native peer-verification helper (contract w2-01 §3.2/§5.3; ADR-14).
//
// 与 windows-browser-import-helper 同族纪律（Program.cs:1031-1057 DACL、1095-1127 管道口
// 客户端验证、1213-1265 FixedTimeEquals/一次性 token、--parent-pid 父绑定）—— 把该族作为
// 金融 broker 的对等验证 relay 应用是 PaySwap 新工作（契约 §5.3(3) 标注）。
//
// argv：--endpoint <公共管道名> --ingress <ingress 管道名> --parent-pid <host pid>
//       --parent-image <host 可执行路径>   （无秘密走 argv —— 命令行对同用户进程可见）
// 或：  --describe-security（建一枚生产纪律管道，回读 SDDL/SID/实例数后退出 —— 平台行）
//
// stdin：首行 = 一次性 32 字节 token（64 hex；匿名管道对第三方不可读，ADR-14 D14.5）；
//        此后 append-only 控制行 {"v":1,"add":<pid>,"image":"<path>"|null}（严格闭键集）
//        —— host 的 spawn 表推送（registerInstance → 管道口门，§5.3(1)）。
//
// 行为：hash 验证的 host spawn 本进程（host 侧纪律）→ 看门狗线程核验父存活（250ms 界；
// 父亡即退 —— §3.1(3)/§10.3 端点随 host 消亡）→ 建公共管道（DACL：当前用户 SID
// ReadWrite、LocalSystem FullControl、无继承、单实例 —— §3.2(2)）→ 服务循环：
// WaitForConnection → GetNamedPipeClientProcessId（内核事实，非线上声明）→ 管道口门
//（父臂：pid=parent 且映像=parent-image；表臂：pid∈表 且映像=该条目 image；否则
// Disconnect 即弃 —— §5.3(1)/(4)，绝不读载荷字节）→ 连 ingress → 写 v1 头行
// {"v":1,"t":"<token>","pid":<clientPid>,"uid":0}（uid=0 是 win32 哨兵：同用户边界由
// DACL 承担，ADR-14 D14.7）→ 双向泵直至双向 EOF（先 Flush 再 Dispose —— 在途字节不丢）。
//
// 安全边界：stdout 只用于 --describe-security 的 SDDL 行；stderr 只输出稳定错误码，绝不
// 输出 token、路径或系统异常文本；一切失败 = 退出非零（host 探针超时 → degraded_refusing）。

namespace PayswapBrokerPeerHelper
{
    internal static class Program
    {
        private const int ParentPollMs = 250;           // 看门狗界（D14.6：macOS 250ms getppid 轮询的 win32 形态）
        private const int WaitForConnectionTimeoutMs = 60000;
        private const int IngressConnectTimeoutMs = 5000;
        private const int IngressConnectRetryMs = 25;
        private const int PipeBufferSize = 4096;        // 先例 CreatePipeServer 同款
        private const int MaxControlLineLength = 4096;  // 控制行上限（host 侧同款 Belt）
        private const int PumpWaitSliceMs = 1000;       // 泵等待切片（darwin poll 1000ms 同款）
        private const int PumpIdleCapMs = 35000;        // 泵空闲上限（§3.3(4) helper 侧镜像；darwin PUMP_IDLE_CAP_MS 同款，host 30s 之上）

        private static readonly ManualResetEvent Shutdown = new ManualResetEvent(false);

        // --diag <file>（诊断缝，ADR-14 D14.10 平台行的 CI 诊断面）：决策行追加写文件；
        // 不含 token/密钥材料（pid/原因/方向即可定位）。生产不传 = 零开销（null 检查）。
        private static readonly object DiagLock = new object();
        private static string diagPath;

        private static int Main(string[] args)
        {
            try
            {
                if (HasArgument(args, "--describe-security"))
                {
                    DescribeSecurity();
                    return 0;
                }
                if (HasArgument(args, "--harden-path")) return HardenPath(args);
                if (HasArgument(args, "--spawn-restricted")) return SpawnRestricted(args);
                if (HasArgument(args, "--harden-child")) return HardenChild(args);
                if (HasArgument(args, "--svc-install")) return SvcInstall(args);
                if (HasArgument(args, "--svc-uninstall")) return SvcUninstall(args);
                if (HasArgument(args, "--svc-run")) return SvcRun(args);
                if (HasArgument(args, "--svc-console")) return SvcConsole(args);
                if (HasArgument(args, "--custodian-register")) return CustodianClient(args, "register");
                if (HasArgument(args, "--custodian-push")) return CustodianClient(args, "push");
                if (HasArgument(args, "--custodian-get")) return CustodianClient(args, "get");
                if (HasArgument(args, "--custodian-drop")) return CustodianClient(args, "drop");
                return RunRelay(args);
            }
            catch
            {
                // 安全边界：异常只转为稳定退出码（host 侧 stderr 尾迹带诊断）；无任何细节外泄。
                Console.Error.WriteLine("helper_failed");
                return 1;
            }
        }

        // ------------------------------------------------------------------
        // argv 解析（先例 ParseArguments/RequireArgument 同款）
        // ------------------------------------------------------------------

        private static Dictionary<string, string> ParseArguments(string[] args)
        {
            Dictionary<string, string> parsed = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 0; i < args.Length; i++)
            {
                if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    parsed[args[i]] = args[++i];
                else parsed[args[i]] = string.Empty;
            }
            return parsed;
        }

        private static string RequireArgument(Dictionary<string, string> args, string key)
        {
            string value;
            if (!args.TryGetValue(key, out value) || string.IsNullOrWhiteSpace(value))
                throw new InvalidDataException();
            return value;
        }

        private static bool HasArgument(string[] args, string target)
        {
            foreach (string value in args) if (value == target) return true;
            return false;
        }

        /** 剥掉 \\.\pipe\ / \\?\pipe\ 前缀，返回裸管道名（.NET Framework 两侧 API 的期望形态）。 */
        private static string NormalizePipeName(string value)
        {
            if (value.StartsWith("\\\\.\\pipe\\", StringComparison.Ordinal)) return value.Substring(9);
            if (value.StartsWith("\\\\?\\pipe\\", StringComparison.Ordinal)) return value.Substring(9);
            return value;
        }

        /** 诊断行（--diag 缺省 = no-op）；IO 失败吞没 —— 诊断绝不影响服务路径。
            内容纪律（A2）：只含稳定决策事实（pid/原因/长度/结果码），绝不含 token、
            密钥、操作载荷或异常消息。1MB 上限轮转（防无界增长）。 */
        private static void Diag(string line)
        {
            if (diagPath == null) return;
            try
            {
                lock (DiagLock)
                {
                    try
                    {
                        FileInfo info = new FileInfo(diagPath);
                        if (info.Exists && info.Length > CustodianDiagMaxBytes) info.Delete();
                    }
                    catch
                    {
                    }
                    File.AppendAllText(diagPath,
                        DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                }
            }
            catch
            {
            }
        }

        // ------------------------------------------------------------------
        // A4 ACL 纪律（显式设定 + 启动自检 —— 绝不从「进程是 SYSTEM」推断边界）
        // ------------------------------------------------------------------

        private static IdentityReference IdentityAdministrators()
        {
            return new NTAccount("BUILTIN", "Administrators");
        }

        /** 目录 ACL：SYSTEM + Administrators 全控；关继承；Users/Everyone 零访问。 */
        private static void HardenDirectorySystemAdminsOnly(string path)
        {
            DirectorySecurity security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                IdentityAdministrators(), FileSystemRights.FullControl, AccessControlType.Allow));
            Directory.SetAccessControl(path, security);
        }

        /** 文件 ACL：SYSTEM + Administrators 全控（服务映像/config —— 用户零访问）。 */
        private static void HardenFileSystemAdminsOnly(string path)
        {
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(
                IdentityAdministrators(), FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(security);
        }

        /** 文件 ACL：仅 SYSTEM 全控（密钥 blob —— 用户与管理员读都不需要）。 */
        private static void HardenFileSystemOnly(string path)
        {
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(security);
        }

        /** 端点文件 ACL：SYSTEM 全控 + 记录用户读写（main 必须读 pipe+token）。 */
        private static void HardenEndpointFileAcl()
        {
            FileSecurity security = new FileSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            if (custodianUserSid != null)
            {
                security.AddAccessRule(new FileSystemAccessRule(
                    new SecurityIdentifier(custodianUserSid),
                    FileSystemRights.Read | FileSystemRights.Write, AccessControlType.Allow));
            }
            new FileInfo(CustodianEndpointFile).SetAccessControl(security);
        }

        /** 边界自检：Users/Everyone/Authenticated Users 不得对文件持有任何 Allow
            访问（服务映像 ACL 弱化检测 —— 安装/更新后运行前验证）。 */
        private static bool VerifyNoUserAccess(string path)
        {
            try
            {
                FileSecurity security = new FileInfo(path).GetAccessControl();
                foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(NTAccount)))
                {
                    if (rule.AccessControlType != AccessControlType.Allow) continue;
                    string name = rule.IdentityReference.Value;
                    if (name.IndexOf("Users", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        name.IndexOf("Everyone", StringComparison.OrdinalIgnoreCase) >= 0)
                        return false;
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        // ------------------------------------------------------------------
        // 主路径：stdin token → 看门狗 → 公共管道服务循环
        // ------------------------------------------------------------------

        private static int RunRelay(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            diagPath = parsed.ContainsKey("--diag") ? parsed["--diag"] : null;
            // 管道名规范化（round-2 CI 根因修复）：.NET Framework 的 NamedPipeClientStream
            // 无条件自拼 \\[server]\pipe\[name] —— 带前缀的 ingress 名会被拼成畸形路径，
            // Connect 永远失败（探针拿不到头行 → degraded）。两侧统一剥掉 \\.\pipe\ /
            // \\?\pipe\ 前缀，以裸名供 API 使用（server 侧前缀直通与拼名行为不作假设）。
            string endpoint = NormalizePipeName(RequireArgument(parsed, "--endpoint"));
            string ingress = NormalizePipeName(RequireArgument(parsed, "--ingress"));
            int parentPid = ParsePositiveInt(RequireArgument(parsed, "--parent-pid"));
            string parentImage = RequireArgument(parsed, "--parent-image");

            // (1) 一次性 token：stdin 首行（D14.5）。形状不符 = fail-closed（65）。
            string token = Console.In.ReadLine();
            if (token == null || !IsHexToken(token.Trim())) return 65;
            token = token.Trim();

            // (2) 看门狗：父亡即退（§3.1(3)/§10.3 —— 公共管道随本进程句柄消亡）。
            Thread watchdog = new Thread(delegate() { MonitorParent(parentPid); });
            watchdog.IsBackground = true;
            watchdog.Start();

            // (3) stdin 控制行读取线程（token 行已消费；EOF = host 终结 → 退出）。
            SpawnTable table = new SpawnTable();
            Thread control = new Thread(delegate() { ReadControlLines(table); });
            control.IsBackground = true;
            control.Start();

            // (4) 服务循环：单实例管道 —— 一条客户端连接服务完（双向 EOF）再建下一枚实例
            //     （§3.2(2) 单实例 = 串行服务，D14.9 记录在案）。
            while (!Shutdown.WaitOne(0))
            {
                NamedPipeServerStream pipe = CreatePipeServerWithRetry(endpoint);
                if (pipe == null)
                {
                    // 建管持续失败 = 名字被占/系统拒绝 —— fail-closed（§3.4 win32 形态）。
                    Diag("pipe:create-failed name=" + endpoint);
                    return 1;
                }
                try
                {
                    if (!WaitForConnection(pipe, WaitForConnectionTimeoutMs))
                    {
                        Diag("conn:wait-timeout");
                        pipe.Dispose();
                        continue;
                    }
                    if (Shutdown.WaitOne(0)) { pipe.Dispose(); break; }
                    uint clientPid;
                    if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientPid))
                    {
                        // 事实不可建立 = 不可验证 = 弃（§5.3(4)）—— 绝不读载荷。
                        Diag("gate:drop pid=" + clientPid + " reason=facts");
                        DisconnectAndRecreate(pipe);
                        continue;
                    }
                    string arm;
                    if (!GateAllows((int)clientPid, parentPid, parentImage, table, out arm))
                    {
                        // 管道口门拒绝：Disconnect 即弃（§5.3(1)/(4) —— 无 relay、无拒绝行）。
                        Diag("gate:drop pid=" + clientPid + " reason=" + arm);
                        DisconnectAndRecreate(pipe);
                        continue;
                    }
                    Diag("gate:allow pid=" + clientPid + " arm=" + arm);
                    // 放行 → ingress relay（D14.4：一条公共连接 = 一条 ingress 连接）。
                    ServeRelayedConnection(pipe, ingress, token, (int)clientPid);
                }
                finally
                {
                    try { pipe.Dispose(); } catch { }
                }
            }
            Diag("exit:clean");
            return 0;
        }

        /** 管道口门（§5.3(1)，D14.3）：父臂（pid+映像）或表臂（pid+映像）；否则弃。arm 输出诊断原因。 */
        private static bool GateAllows(
            int clientPid, int parentPid, string parentImage, SpawnTable table, out string arm)
        {
            if (clientPid == parentPid)
            {
                bool ok = VerifyProcessImagePath(clientPid, parentImage);
                arm = ok ? "parent" : "parent-image-mismatch";
                return ok;
            }
            string expected;
            if (!table.TryLookup(clientPid, out expected))
            {
                arm = "not-in-table";
                return false;
            }
            if (expected == null)
            {
                arm = "image-null"; // image=null = 无法核验 = 不可验证 = 弃（§5.3(4)）
                return false;
            }
            bool imageOk = VerifyProcessImagePath(clientPid, expected);
            arm = imageOk ? "table" : "image-mismatch";
            return imageOk;
        }

        /** 已验证连接的 ingress relay：头行 + 单线程双向泵（D14.4：一条公共连接 =
            一条 ingress 连接）。 */
        private static void ServeRelayedConnection(
            NamedPipeServerStream client,
            string ingressName,
            string token,
            int clientPid)
        {
            NamedPipeClientStream ingress = null;
            try
            {
                ingress = ConnectIngress(ingressName);
                if (ingress == null)
                {
                    Diag("ingress:fail pid=" + clientPid);
                    client.Dispose();
                    return;
                }
                Diag("ingress:ok pid=" + clientPid);
                // v1 头行（peer-relay-protocol.ts 严格形状；uid=0 win32 哨兵，D14.7）。
                byte[] header = Encoding.UTF8.GetBytes(
                    "{\"v\":1,\"t\":\"" + token + "\",\"pid\":" + clientPid.ToString() + ",\"uid\":0}\n");
                ingress.Write(header, 0, header.Length);
                ingress.Flush();

                PumpBoth(client, ingress);
            }
            catch
            {
                // 传输故障 = 该连接终局；两侧 Dispose 由 finally 收口。
            }
            finally
            {
                try { if (ingress != null) ingress.Dispose(); } catch { }
                try { client.Dispose(); } catch { }
            }
        }

        /** 单线程双向泵（APM 复用 —— .NET Framework 的 poll 等价物；darwin helper 的
            poll 环同款纪律：方向性 EOF + 错误双侧同亡 + 空闲上限）。

            round-8 CI 根因：旧实现是两条阻塞读线程 + 先破侧 Dispose 双流 —— 同步句柄
            上 CloseHandle-during-ReadFile 的唤醒是未定义行为，对侧 Read 可能永不返回
            （持有者死后服务循环卡死：控制行照收、公共管道实例永不重建 —— busy 行正面
            臂的 ENOENT 即其形）。两流均须 Asynchronous：重叠句柄的关闭取消在途 I/O
            是文档化保证 —— Dispose 确定唤醒对侧在途读，循环确定性终结。

            半关平台差（darwin 的 shutdown(SHUT_WR) 不可表达）：方向性 EOF 时全关对侧。
            协议族无需半关 —— §3.3 一请求一连接，客户端在响应到达前不 FIN（bridge 与
            测试客户端都是 write 后等响应；先 FIN 后等响应的形态不存在于此家族）。 */
        private static void PumpBoth(NamedPipeServerStream client, NamedPipeClientStream ingress)
        {
            byte[] clientBuffer = new byte[PipeBufferSize];
            byte[] ingressBuffer = new byte[PipeBufferSize];
            IAsyncResult clientRead = null;
            IAsyncResult ingressRead = null;
            bool clientOpen = true;   // client → ingress 方向
            bool ingressOpen = true;  // ingress → client 方向
            DateTime lastActivity = DateTime.UtcNow;
            while (clientOpen || ingressOpen)
            {
                if (clientOpen && clientRead == null)
                {
                    try { clientRead = client.BeginRead(clientBuffer, 0, clientBuffer.Length, null, null); }
                    catch { clientOpen = false; }
                }
                if (ingressOpen && ingressRead == null)
                {
                    try { ingressRead = ingress.BeginRead(ingressBuffer, 0, ingressBuffer.Length, null, null); }
                    catch { ingressOpen = false; }
                }
                if (!clientOpen && !ingressOpen) break;

                WaitHandle[] handles = new WaitHandle[(clientRead != null ? 1 : 0) + (ingressRead != null ? 1 : 0)];
                int index = 0;
                if (clientRead != null) handles[index++] = clientRead.AsyncWaitHandle;
                if (ingressRead != null) handles[index++] = ingressRead.AsyncWaitHandle;
                if (handles.Length == 0) break;

                if (WaitHandle.WaitAny(handles, PumpWaitSliceMs) == WaitHandle.WaitTimeout)
                {
                    // 空闲上限（§3.3(4) 的 helper 侧镜像，darwin PUMP_IDLE_CAP_MS 同款界）。
                    if ((DateTime.UtcNow - lastActivity).TotalMilliseconds > PumpIdleCapMs) break;
                    continue;
                }
                lastActivity = DateTime.UtcNow;
                if (clientRead != null && clientRead.IsCompleted)
                {
                    int read;
                    try { read = client.EndRead(clientRead); } catch { read = 0; }
                    clientRead = null;
                    if (read <= 0)
                    {
                        // client 方向终结 → 全关 ingress（半关不可表达；Dispose 取消在途
                        // ingress 读 —— 重叠句柄的文档化取消语义）。
                        clientOpen = false;
                        try { ingress.Dispose(); } catch { }
                    }
                    else
                    {
                        try { ingress.Write(clientBuffer, 0, read); ingress.Flush(); }
                        catch { clientOpen = false; ingressOpen = false; } // 写破 = 双侧同亡
                    }
                }
                if (ingressRead != null && ingressRead.IsCompleted)
                {
                    int read;
                    try { read = ingress.EndRead(ingressRead); } catch { read = 0; }
                    ingressRead = null;
                    if (read <= 0)
                    {
                        ingressOpen = false;
                        try { client.Dispose(); } catch { }
                    }
                    else
                    {
                        try { client.Write(ingressBuffer, 0, read); client.Flush(); }
                        catch { clientOpen = false; ingressOpen = false; } // 写破 = 双侧同亡
                    }
                }
            }
            // 在途字节收口（D14.4：先 Flush 再 Dispose —— Dispose 由调用方 finally 统一）。
            try { client.Flush(); } catch { }
            try { ingress.Flush(); } catch { }
        }

        /** ingress 连接（host 先建 listener 再 spawn 本进程 —— 小窗口重试吸收调度延迟）。
            Asynchronous（round-8）：泵的 Dispose-取消在途读需要重叠句柄 —— 同步句柄的
            CloseHandle-during-ReadFile 唤醒未定义（服务循环卡死根因）。 */
        private static NamedPipeClientStream ConnectIngress(string ingressName)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(IngressConnectTimeoutMs);
            while (true)
            {
                int remaining = (int)deadline.Subtract(DateTime.UtcNow).TotalMilliseconds;
                if (remaining < 1) return null;
                try
                {
                    NamedPipeClientStream stream = new NamedPipeClientStream(
                        ".", ingressName, PipeDirection.InOut, PipeOptions.Asynchronous,
                        TokenImpersonationLevel.Identification);
                    stream.Connect(remaining);
                    return stream;
                }
                catch (Exception)
                {
                    if (DateTime.UtcNow >= deadline) return null;
                    Thread.Sleep(IngressConnectRetryMs);
                }
            }
        }

        /** 弃连接（Disconnect 即弃 —— 不读载荷；外层循环随后建下一枚服务实例）。 */
        private static void DisconnectAndRecreate(NamedPipeServerStream pipe)
        {
            try { pipe.Disconnect(); } catch { }
            try { pipe.Dispose(); } catch { }
        }

        // ------------------------------------------------------------------
        // stdin 控制行（D14.5 严格形状：恰三键 v/add/image；add 正整数；image string|null）
        // ------------------------------------------------------------------

        private static void ReadControlLines(SpawnTable table)
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null) break; // stdin EOF = host 终结 → 干净退出
                    line = line.Trim();
                    if (line.Length == 0) continue;
                    if (line.Length > MaxControlLineLength) continue; // 形状破坏 → 放弃本行（fail-closed）
                    int add;
                    string image;
                    if (!ParseControlLine(line, out add, out image))
                    {
                        Diag("control:reject " + (line.Length > 96 ? line.Substring(0, 96) + "..." : line));
                        continue;
                    }
                    table.Add(add, image);
                    Diag("control:add pid=" + add + " image=" + (image == null ? "null" : image));
                }
            }
            catch
            {
                // 读取故障 = host 终结等价 —— 下方硬终止收口
            }
            // stdin EOF = host 终结（stop() 的优雅先行或 host 死亡）—— 与看门狗同理：
            // accept 循环可能正阻塞，事件信号不可见，硬终止（host 的 kill 是 belt）。
            Environment.Exit(0);
        }

        private static bool ParseControlLine(string line, out int add, out string image)
        {
            add = 0;
            image = null;
            try
            {
                // 严格闭键集手解析（先例族同款纪律 —— 不引 JSON 库，形状破坏一律拒绝）：
                // {"v":1,"add":<int>,"image":<string|null>}
                //
                // round-5 CI 根因（--diag 落地 control:reject，非推测）：两枚差一错误叠加 ——
                // (a) 前缀 "{\"v\":1,\"add\":" 长 13，IndexOf/Substring 误用 14 起：
                //     吞 pid 首位数字（6164 → 164）；
                // (b) tail = "<body>"} 需剥 3 字符（开引号+收引号+}），Substring(1,
                //     Length-2) 只剥 2：body 残留收引号 → IndexOf('"') 恒真 → 一切
                //     非空映像控制行被拒（表永不落 → 全部 not-in-table 弃）。修复：13 起 +
                //     显式收引号位校验 + 剥 3 + 空映像拒收（合法哨兵是 null，D14.5）。
                if (!line.StartsWith("{\"v\":1,\"add\":", StringComparison.Ordinal)) return false;
                int rest = line.IndexOf(",\"image\":", 13, StringComparison.Ordinal);
                if (rest < 0) return false;
                string addText = line.Substring(13, rest - 13);
                if (!ParsePositiveInt(addText, out add)) return false;
                string imageKey = ",\"image\":";
                string tail = line.Substring(rest + imageKey.Length);
                if (tail == "null}") { image = null; return true; }
                if (!tail.StartsWith("\"", StringComparison.Ordinal)) return false;
                if (!tail.EndsWith("}", StringComparison.Ordinal)) return false;
                // 收引号必须恰在 } 前（破损形状不得被静默截断采纳）。
                if (tail.Length < 3 || tail[tail.Length - 2] != '"') return false;
                string body = tail.Substring(1, tail.Length - 3);
                if (body.Length == 0) return false; // 空映像 = 破损形状（哨兵是 null）
                if (body.IndexOf('"') >= 0) return false; // 内嵌引号 = 非最简形状
                image = UnescapeJsonString(body);
                return image != null;
            }
            catch
            {
                return false;
            }
        }

        /** 最简 JSON 字符串反转义（仅接受 \\ 与 \" —— 其余转义一律拒绝：路径的合法面）。 */
        private static string UnescapeJsonString(string body)
        {
            if (body.IndexOf('\\') < 0) return body;
            StringBuilder sb = new StringBuilder(body.Length);
            for (int i = 0; i < body.Length; i++)
            {
                char c = body[i];
                if (c != '\\') { sb.Append(c); continue; }
                i++;
                if (i >= body.Length) return null;
                if (body[i] == '\\') { sb.Append('\\'); continue; }
                if (body[i] == '"') { sb.Append('"'); continue; }
                return null; // \n、\uXXXX 等 = 拒绝（Windows 路径不需要它们）
            }
            return sb.ToString();
        }

        private static bool IsHexToken(string value)
        {
            if (value.Length != 64) return false;
            foreach (char c in value)
            {
                bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                if (!ok) return false;
            }
            return true;
        }

        private static int ParsePositiveInt(string value)
        {
            int parsed;
            if (!int.TryParse(value, out parsed) || parsed <= 0) throw new InvalidDataException();
            return parsed;
        }

        private static bool ParsePositiveInt(string value, out int parsed)
        {
            parsed = 0;
            if (!int.TryParse(value, out parsed) || parsed <= 0) return false;
            return true;
        }

        // ------------------------------------------------------------------
        // 看门狗（D14.6）：父进程存活核验 —— 250ms 界轮询（macOS getppid 轮询同款界）。
        // ------------------------------------------------------------------

        private static void MonitorParent(int parentPid)
        {
            while (true)
            {
                bool alive;
                try
                {
                    Process parent = Process.GetProcessById(parentPid);
                    try
                    {
                        alive = !parent.HasExited;
                    }
                    finally
                    {
                        parent.Dispose();
                    }
                }
                catch
                {
                    alive = false; // 进程不存在（ArgumentException）= 父亡
                }
                if (!alive) break;
                if (Shutdown.WaitOne(ParentPollMs)) return; // 其它路径已请求停机
            }
            // 父亡：立即终止（round-2 CI 教训：accept 循环可能正阻塞在 60s 界的
            // WaitForConnection 里，事件信号对它不可见）—— 硬终止才是 §3.1(3)/§10.3
            // 端点随 host 消亡的保证；host 侧的 kill 只是 belt。
            Environment.Exit(0);
        }

        // ------------------------------------------------------------------
        // 管道创建（§3.2(2)，先例 CreatePipeServer 的严格形态：无 admins/authenticated 开关）
        // ------------------------------------------------------------------

        private static NamedPipeServerStream CreatePipeServer(string pipeName)
        {
            try
            {
                PipeSecurity security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false); // 无继承（显式 DACL）
                SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
                if (currentUser == null) return null;
                security.AddAccessRule(new PipeAccessRule(
                    currentUser, PipeAccessRights.ReadWrite, AccessControlType.Allow));
                security.AddAccessRule(new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    PipeAccessRights.FullControl, AccessControlType.Allow));
                return new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    1, // 单实例（§3.2(2) normative；串行服务记录于 D14.9）
                    PipeTransmissionMode.Byte,
                    // 先例 CreatePipeServer 同款标志（Begin/End WaitForConnection 需要
                    // Asynchronous —— 同步管道会在接入前抛 InvalidOperationException）。
                    PipeOptions.Asynchronous,
                    PipeBufferSize,
                    PipeBufferSize,
                    security);
            }
            catch
            {
                return null; // 名字被占（§3.4 win32：不可静默采纳）或系统拒绝 —— fail-closed
            }
        }

        /** 建管（带限重试）：弃连接后旧实例对象可能被客户端句柄短暂保活（单实例上限的
            瞬时窗口，round-4 CI 的放大器）—— 50ms×10 重试吸收；持续失败才 fail-closed。 */
        private static NamedPipeServerStream CreatePipeServerWithRetry(string pipeName)
        {
            for (int attempt = 0; attempt < 10; attempt++)
            {
                NamedPipeServerStream pipe = CreatePipeServer(pipeName);
                if (pipe != null) return pipe;
                if (attempt > 0) Diag("pipe:create-retry attempt=" + attempt);
                Thread.Sleep(50);
            }
            return null;
        }

        private static bool WaitForConnection(NamedPipeServerStream pipe, int timeoutMs)
        {
            // 先例 WaitForConnection 同款：Begin/End 异步等待 + 硬超时（同步管道会在
            // controller/service 接入前抛 InvalidOperationException）。
            IAsyncResult wait = pipe.BeginWaitForConnection(null, null);
            if (!wait.AsyncWaitHandle.WaitOne(timeoutMs)) return false;
            pipe.EndWaitForConnection(wait);
            return true;
        }

        // ------------------------------------------------------------------
        // 内核事实（先例 VerifyPipeClient/VerifyProcessImagePath 逐字同款纪律）
        // ------------------------------------------------------------------

        private const int ProcessQueryLimitedInformation = 0x1000;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint clientProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(int desiredAccess, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryFullProcessImageName(
            IntPtr process, int flags, StringBuilder imageName, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private static bool VerifyProcessImagePath(int processId, string expectedPath)
        {
            IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (process == IntPtr.Zero) return false;
            try
            {
                StringBuilder path = new StringBuilder(32768);
                int length = path.Capacity;
                return QueryFullProcessImageName(process, 0, path, ref length) &&
                    string.Equals(
                        Path.GetFullPath(path.ToString()),
                        Path.GetFullPath(expectedPath),
                        StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                CloseHandle(process);
            }
        }

        // ------------------------------------------------------------------
        // --describe-security（平台行）：生产纪律建管 + SDDL 回读，证明 §3.2(2) 落位。
        // ------------------------------------------------------------------

        private static void DescribeSecurity()
        {
            string pipeName = "payswap-broker-describe-" + Guid.NewGuid().ToString("N");
            using (NamedPipeServerStream pipe = CreatePipeServer(pipeName))
            {
                if (pipe == null) throw new InvalidOperationException();
                PipeSecurity security = pipe.GetAccessControl();
                string sddl = security.GetSecurityDescriptorSddlForm(AccessControlSections.All);
                SecurityIdentifier sid = WindowsIdentity.GetCurrent().User;
                Console.Out.WriteLine("SDDL:" + sddl);
                Console.Out.WriteLine("SID:" + (sid == null ? "" : sid.Value));
                Console.Out.WriteLine("MAXINSTANCES:1");
                // 语义面（round-2 CI 教训：SDDL 渲染因账户形态而异 —— 内建管理员 -500
                // 显示为 LA 速记、权利掩码显示为十六进制而非 GRGW 助记）—— 规则行直接
                // 给出 identity|mask|allow，断言据此做语义判定。
                Console.Out.WriteLine("READWRITE_MASK:" + ((int)PipeAccessRights.ReadWrite).ToString());
                foreach (PipeAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                {
                    SecurityIdentifier identity = rule.IdentityReference as SecurityIdentifier;
                    Console.Out.WriteLine("RULE:" + (identity == null ? "" : identity.Value) + "|" +
                        ((int)rule.PipeAccessRights).ToString() + "|" +
                        (rule.AccessControlType == AccessControlType.Allow ? "allow" : "deny"));
                }
            }
        }

        // ------------------------------------------------------------------
        // ADR-P2-3：凭据路径 deny-ACE 加固 + 受限令牌 spawn（P2-Windows 阻断项的强制面）。
        // stdout 纪律与 RunRelay 同族：只输出稳定判定行（harden:ok/violated/error、
        // "pid exit"），绝不含令牌/路径外泄面。受限令牌构造 = 经典 Chrome-sandbox
        // 原语：CreateRestrictedToken 的 restricting 集含用户自身 + Everyone（第二
        // 访问检查镜像正常授予）+ 应用固定 deny SID（deny ACE 只在受保护路径上成立）。
        // ------------------------------------------------------------------

        private const string PayswapIsolationSidString = "S-1-5-21-3057928939-948576043-2919049624-49667";

        private const uint TokenAssignPrimary = 0x0001;
        private const uint TokenDuplicate = 0x0002;
        private const uint TokenQuery = 0x0008;
        private const uint TokenAdjustPrivileges = 0x0020;
        private const uint CreateRestrictedTokenDisableMaxPrivilege = 0x00000001;
        private const uint SecurityIdentificationLevel = 1;
        private const uint TokenTypePrimary = 1;
        private const uint CreateProcessNoWindow = 0x08000000;
        private const uint WaitInfinite = 0xFFFFFFFF;
        private const uint SePrivilegeEnabled = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID
        {
            public uint LowPart;
            public int HighPart;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct LUID_AND_ATTRIBUTES
        {
            public LUID Luid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_PRIVILEGES
        {
            public uint PrivilegeCount;
            public LUID_AND_ATTRIBUTES Privileges;
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges, ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public uint cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        /// ADR-P2-3：启用自身令牌上的 SeIncreaseQuotaPrivilege（默认持有但禁用；
        /// CreateProcessAsUser 的主令牌配额检查需要它，无需提权 —— 已持有即启用）。
        private static void EnableQuotaPrivilege(IntPtr tokenHandle)
        {
            LUID luid;
            if (!LookupPrivilegeValue(null, "SeIncreaseQuotaPrivilege", out luid))
                throw new InvalidOperationException("lookup-privilege");
            var newState = new TOKEN_PRIVILEGES();
            newState.PrivilegeCount = 1;
            newState.Privileges.Luid = luid;
            newState.Privileges.Attributes = SePrivilegeEnabled;
            if (!AdjustTokenPrivileges(tokenHandle, false, ref newState, 0, IntPtr.Zero, IntPtr.Zero))
                throw new InvalidOperationException("adjust-privilege");
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool DuplicateTokenEx(IntPtr ExistingTokenHandle, uint DesiredAccess, IntPtr TokenAttributes, uint ImpersonationLevel, uint TokenType, out IntPtr NewTokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, uint DisableSidCount, IntPtr DisableSids, uint DeletePrivilegeCount, IntPtr DeletePrivileges, uint RestrictingSidCount, IntPtr RestrictingSids, out IntPtr NewTokenHandle);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr hMem);

        /// ADR-P2-3 Layer 1：对 --v2 指向的数据根 v2 目录（credentials.json、
        /// payswap-psp-safe-storage-key）追加应用固定 SID 的 deny ACE（Read 拒绝，
        /// 目录继承）。幂等：已存在即跳过。stdout 单行判定；exit 0 = 加固成立或
        /// 已成立，2 = 违约（对抗链恢复成立），3 = 参数/环境错误。
        private static int HardenPath(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            string v2Root = RequireArgument(parsed, "--v2");
            if (!Directory.Exists(v2Root)) throw new InvalidDataException();

            var sid = new SecurityIdentifier(PayswapIsolationSidString);
            int locked = 0;
            string[] targets = new string[]
            {
                Path.Combine(v2Root, "credentials.json"),
                Path.Combine(v2Root, "payswap-psp-safe-storage-key"),
            };
            foreach (string target in targets)
            {
                if (!File.Exists(target)) continue; // 撤销态：文件缺席 = 天然阻断，无需 ACE。
                FileSecurity security = File.GetAccessControl(target);
                bool present = false;
                foreach (FileSystemAccessRule existing in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
                {
                    if (existing.AccessControlType == AccessControlType.Deny &&
                        existing.IdentityReference.Value == PayswapIsolationSidString)
                    {
                        present = true;
                        break;
                    }
                }
                if (!present)
                {
                    var rule = new FileSystemAccessRule(
                        sid,
                        FileSystemRights.Read | FileSystemRights.ListDirectory,
                        InheritanceFlags.None,
                        PropagationFlags.None,
                        AccessControlType.Deny);
                    security.AddAccessRule(rule);
                    File.SetAccessControl(target, security);
                }
                locked++;
            }
            Console.Out.WriteLine("harden:ok locked=" + locked);
            return 0;
        }

        /// ADR-P2-3 Layer 2：--spawn-restricted <image> [childArgs…]。
        /// CreateRestrictedToken（restricting = 用户 SID + Everyone + 应用固定 deny SID；
        /// DISABLE_MAX_PRIVILEGE）→ CreateProcessAsUser → 等待退出 → stdout "pid exit"。
        /// exit 0 = 成功（child 退出码见 stdout）；2 = spawn 失败。
        private static int SpawnRestricted(string[] args)
        {
            int imageIndex = -1;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--spawn-restricted") { imageIndex = i + 1; break; }
            }
            if (imageIndex < 0 || imageIndex >= args.Length) throw new InvalidDataException();
            string image = args[imageIndex];
            string childArgs = string.Empty;
            if (imageIndex + 1 < args.Length)
            {
                var parts = new List<string>(args.Length);
                for (int i = imageIndex + 1; i < args.Length; i++) parts.Add(args[i]);
                childArgs = string.Join(" ", parts.ToArray());
            }

            IntPtr tokenHandle = IntPtr.Zero;
            IntPtr duplicateHandle = IntPtr.Zero;
            IntPtr restrictedHandle = IntPtr.Zero;
            IntPtr processHandle = IntPtr.Zero;
            IntPtr threadHandle = IntPtr.Zero;
            IntPtr userSidPtr = IntPtr.Zero;
            IntPtr everyoneSidPtr = IntPtr.Zero;
            IntPtr denySidPtr = IntPtr.Zero;
            try
            {
                IntPtr currentProcess = System.Diagnostics.Process.GetCurrentProcess().Handle;
                if (!OpenProcessToken(currentProcess, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustPrivileges, out tokenHandle))
                    throw new InvalidOperationException("open-token");
                EnableQuotaPrivilege(tokenHandle);

                if (!DuplicateTokenEx(tokenHandle, TokenAssignPrimary | TokenDuplicate | TokenQuery, IntPtr.Zero, SecurityIdentificationLevel, TokenTypePrimary, out duplicateHandle))
                    throw new InvalidOperationException("duplicate-token");

                var identity = WindowsIdentity.GetCurrent();
                string userSid = identity.User.Value;
                string everyoneSid = new SecurityIdentifier(WellKnownSidType.WorldSid, null).Value;

                if (!ConvertStringSidToSid(userSid, out userSidPtr)) throw new InvalidOperationException("user-sid");
                if (!ConvertStringSidToSid(everyoneSid, out everyoneSidPtr)) throw new InvalidOperationException("everyone-sid");
                if (!ConvertStringSidToSid(PayswapIsolationSidString, out denySidPtr)) throw new InvalidOperationException("deny-sid");

                var sidArray = new SID_AND_ATTRIBUTES[3];
                sidArray[0].Sid = userSidPtr; sidArray[0].Attributes = 0;
                sidArray[1].Sid = everyoneSidPtr; sidArray[1].Attributes = 0;
                sidArray[2].Sid = denySidPtr; sidArray[2].Attributes = 0;

                var handle = GCHandle.Alloc(sidArray, GCHandleType.Pinned);
                try
                {
                    IntPtr sidArrayPtr = handle.AddrOfPinnedObject();
                    if (!CreateRestrictedToken(duplicateHandle, CreateRestrictedTokenDisableMaxPrivilege, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)sidArray.Length, sidArrayPtr, out restrictedHandle))
                        throw new InvalidOperationException("restricted-token");
                }
                finally
                {
                    handle.Free();
                }

                var si = new STARTUPINFO();
                si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
                PROCESS_INFORMATION pi;
                string commandLine = "\"" + image + "\"" + (childArgs.Length > 0 ? " " + childArgs : string.Empty);
                if (!CreateProcessAsUser(restrictedHandle, image, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateProcessNoWindow, IntPtr.Zero, null, ref si, out pi))
                    throw new InvalidOperationException("create-process win32=" + Marshal.GetLastWin32Error());

                processHandle = pi.hProcess;
                threadHandle = pi.hThread;
                Console.Out.WriteLine(pi.dwProcessId);
                WaitForSingleObject(processHandle, WaitInfinite);
                uint exitCode;
                if (!GetExitCodeProcess(processHandle, out exitCode)) exitCode = 0;
                Console.Out.WriteLine(exitCode);
                return 0;
            }
            catch (InvalidOperationException e)
            {
                Console.Error.WriteLine("spawn-restricted:" + e.Message);
                Console.Out.WriteLine("-1 -1");
                return 2;
            }
            finally
            {
                if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
                if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
                if (restrictedHandle != IntPtr.Zero) CloseHandle(restrictedHandle);
                if (duplicateHandle != IntPtr.Zero) CloseHandle(duplicateHandle);
                if (tokenHandle != IntPtr.Zero) CloseHandle(tokenHandle);
                if (userSidPtr != IntPtr.Zero) LocalFree(userSidPtr);
                if (everyoneSidPtr != IntPtr.Zero) LocalFree(everyoneSidPtr);
                if (denySidPtr != IntPtr.Zero) LocalFree(denySidPtr);
            }
        }

        /// ADR-P2-3 Layer 1 验证：--harden-child --node <node.exe> --v2 <v2 根>。
        /// 受限令牌下运行对抗链（master key → file key → enc:v1 槽），stdout 单行 JSON；
        /// HardenPath 侧用 node 退出码/输出判定。exit 0 = 链被阻断；2 = 链恢复成立。
        private static int HardenChild(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            string nodePath = RequireArgument(parsed, "--node");
            string v2Root = RequireArgument(parsed, "--v2");

            string childSource =
                "const fs = require('fs');\n" +
                "const crypto = require('crypto');\n" +
                "const v2 = process.argv[2];\n" +
                "const out = { locked: false, chain: false, slot: false, reason: '' };\n" +
                "try {\n" +
                "  fs.accessSync(v2 + '/credentials.json', fs.constants.R_OK);\n" +
                "  const creds = JSON.parse(fs.readFileSync(v2 + '/credentials.json', 'utf8'));\n" +
                "  const slot = Object.keys(creds).find(k => k.startsWith('payswap:psp:stripe:') && k.endsWith(':api-key'));\n" +
                "  if (slot && typeof creds[slot] === 'string' && creds[slot].startsWith('enc:v1:')) {\n" +
                "    const wrapped = fs.readFileSync(v2 + '/payswap-psp-safe-storage-key');\n" +
                "    const body = wrapped.slice(3);\n" +
                "    out.locked = false; out.chain = true; out.slot = true; out.reason = 'full-chain-readable';\n" +
                "  } else { out.locked = false; out.chain = false; out.reason = 'slot-absent'; }\n" +
                "} catch (e) {\n" +
                "  out.locked = true; out.chain = false; out.slot = false; out.reason = String(e.code || e.message).slice(0, 60);\n" +
                "}\n" +
                "process.stdout.write(JSON.stringify(out));\n";

            string childPath = Path.Combine(Path.GetTempPath(), "payswap-isolation-child-" + Guid.NewGuid().ToString("N") + ".cjs");
            File.WriteAllText(childPath, childSource);
            try
            {
                var si = new STARTUPINFO();
                si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
                PROCESS_INFORMATION pi;
                string commandLine = "\"" + nodePath + "\" --enable-source-maps \"" + childPath + "\" \"" + v2Root + "\"";
                IntPtr tokenHandle = IntPtr.Zero;
                IntPtr duplicateHandle = IntPtr.Zero;
                IntPtr restrictedHandle = IntPtr.Zero;
                IntPtr processHandle = IntPtr.Zero;
                IntPtr threadHandle = IntPtr.Zero;
                IntPtr userSidPtr = IntPtr.Zero;
                IntPtr everyoneSidPtr = IntPtr.Zero;
                IntPtr denySidPtr = IntPtr.Zero;
                try
                {
                    IntPtr currentProcess = System.Diagnostics.Process.GetCurrentProcess().Handle;
                    if (!OpenProcessToken(currentProcess, TokenAssignPrimary | TokenDuplicate | TokenQuery | TokenAdjustPrivileges, out tokenHandle))
                        throw new InvalidOperationException("open-token");
                    EnableQuotaPrivilege(tokenHandle);
                    if (!DuplicateTokenEx(tokenHandle, TokenAssignPrimary | TokenDuplicate | TokenQuery, IntPtr.Zero, SecurityIdentificationLevel, TokenTypePrimary, out duplicateHandle))
                        throw new InvalidOperationException("duplicate-token");
                    var identity = WindowsIdentity.GetCurrent();
                    string userSid = identity.User.Value;
                    string everyoneSid = new SecurityIdentifier(WellKnownSidType.WorldSid, null).Value;
                    if (!ConvertStringSidToSid(userSid, out userSidPtr)) throw new InvalidOperationException("user-sid");
                    if (!ConvertStringSidToSid(everyoneSid, out everyoneSidPtr)) throw new InvalidOperationException("everyone-sid");
                    if (!ConvertStringSidToSid(PayswapIsolationSidString, out denySidPtr)) throw new InvalidOperationException("deny-sid");
                    var sidArray = new SID_AND_ATTRIBUTES[3];
                    sidArray[0].Sid = userSidPtr; sidArray[0].Attributes = 0;
                    sidArray[1].Sid = everyoneSidPtr; sidArray[1].Attributes = 0;
                    sidArray[2].Sid = denySidPtr; sidArray[2].Attributes = 0;
                    var handle = GCHandle.Alloc(sidArray, GCHandleType.Pinned);
                    try
                    {
                        if (!CreateRestrictedToken(duplicateHandle, CreateRestrictedTokenDisableMaxPrivilege, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)sidArray.Length, handle.AddrOfPinnedObject(), out restrictedHandle))
                            throw new InvalidOperationException("restricted-token");
                    }
                    finally
                    {
                        handle.Free();
                    }
                    if (!CreateProcessAsUser(restrictedHandle, nodePath, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateProcessNoWindow, IntPtr.Zero, null, ref si, out pi))
                        throw new InvalidOperationException("create-process win32=" + Marshal.GetLastWin32Error());
                    processHandle = pi.hProcess;
                    threadHandle = pi.hThread;
                    WaitForSingleObject(processHandle, WaitInfinite);
                    uint exitCode;
                    GetExitCodeProcess(processHandle, out exitCode);
                    return exitCode == 0 ? 0 : 2;
                }
                finally
                {
                    if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
                    if (threadHandle != IntPtr.Zero) CloseHandle(threadHandle);
                    if (restrictedHandle != IntPtr.Zero) CloseHandle(restrictedHandle);
                    if (duplicateHandle != IntPtr.Zero) CloseHandle(duplicateHandle);
                    if (tokenHandle != IntPtr.Zero) CloseHandle(tokenHandle);
                    if (userSidPtr != IntPtr.Zero) LocalFree(userSidPtr);
                    if (everyoneSidPtr != IntPtr.Zero) LocalFree(everyoneSidPtr);
                    if (denySidPtr != IntPtr.Zero) LocalFree(denySidPtr);
                    try { File.Delete(childPath); } catch { }
                }
            }
            catch (InvalidOperationException e)
            {
                Console.Error.WriteLine("harden-child:" + e.Message);
                return 3;
            }
        }

        // ------------------------------------------------------------------
        // ADR-P2-3 custodian service：SYSTEM 服务持有 PSP 密钥（SYSTEM-DPAPI 包装落盘
        // + 内存持有），具名管道只服务**已注册的 main pid**（内核事实 + electron 映像门
        // + helper 父进程门），有界五路只读 GET 代理（路径闭集）。秘密永不落可读文件。
        // ------------------------------------------------------------------

        private const string CustodianServiceName = "PayswapCustodianSvc";
        private const string CustodianPipeName = "payswap-custodian-v1";
        private const string CustodianProgramDataDir = "C:\\ProgramData\\payswap";
        private const string CustodianConfigFile = CustodianProgramDataDir + "\\custodian-config.json";
        private const string CustodianEndpointFile = CustodianProgramDataDir + "\\custodian-endpoint.json";
        private const string CustodianKeyBlobFile = CustodianProgramDataDir + "\\custodian-key.bin";
        private const string CustodianDiagFile = CustodianProgramDataDir + "\\custodian-diag.log";
        private const string CustodianAllowedPaths =
            "/v1/balance|/v1/charges|/v1/customers|/v1/disputes|/v1/account";
        // A4 服务可执行边界：服务二进制必须住在受保护目录（显式 ACL：SYSTEM +
        // Administrators 全控、Users/Everyone 零访问 —— 安装时复制 + 启动时自检，
        // 安装/更新绝不悄悄弱化 ACL）。用户可写的应用目录不被接受为 SYSTEM 服务宿主。
        private const string CustodianServiceBinDir = CustodianProgramDataDir + "\\svc-bin";
        private const string CustodianServiceImage = CustodianServiceBinDir + "\\payswap-custodian-svc.exe";
        private const long CustodianDiagMaxBytes = 1024 * 1024;

        private static volatile bool custodianStopping;
        private static readonly object CustodianStateLock = new object();
        private static int registeredMainPid = -1;
        // A0.5（评审跟进 W2 —— PID 复用）：注册时**保留在册主进程的内核句柄**。
        // 句柄引用的是「原始进程对象」—— 若该进程退出而 PID 被复用（哪怕复用者
        // 恰是同一 electron 映像），句柄变为 signaled（进程已死）→ 数据门拒绝。
        // 仅凭 pid 整数 + 映像路径无法区分「原进程」与「同 pid 同映像的复用者」；
        // 句柄活性 + pid 相等 + 映像核验三者合取才构成进程实例身份。
        private static IntPtr registeredMainHandle = IntPtr.Zero;
        private static string custodianKeyHex;
        private static string custodianElectronImage;      // 精确 electron 主进程映像（config image）
        private static string custodianClientHelperImage;  // 精确客户端 helper 映像（config clientHelper）
        private static string custodianUserSid;

        /** 关闭在册主句柄（rebind / 服务停止时；句柄泄漏 = 内核对象滞留）。 */
        private static void CloseRegisteredMainHandle()
        {
            IntPtr existing = registeredMainHandle;
            registeredMainHandle = IntPtr.Zero;
            if (existing != IntPtr.Zero) CloseHandle(existing);
        }

        private static int SvcInstall(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            string image = RequireArgument(parsed, "--image");
            string selfImage = System.Reflection.Assembly.GetExecutingAssembly().Location;
            // 客户端 helper = main 将 spawn 的 bundled-tools 二进制（默认 = 本映像，
            // console/SEA 语境）—— 服务端以精确映像核验连接进程身份。
            string clientHelper = parsed.ContainsKey("--client-helper") &&
                !string.IsNullOrWhiteSpace(parsed["--client-helper"])
                ? parsed["--client-helper"]
                : selfImage;
            string userSid = WindowsIdentity.GetCurrent().User.Value;
            Directory.CreateDirectory(CustodianProgramDataDir);
            // A4 服务二进制边界：复制到受保护目录（更新 = 覆盖复制），目录/文件 ACL
            // 显式收紧并当场验证（违者安装失败 —— 大声失败，不静默弱化）。
            Directory.CreateDirectory(CustodianServiceBinDir);
            HardenDirectorySystemAdminsOnly(CustodianServiceBinDir);
            File.Copy(selfImage, CustodianServiceImage, true);
            HardenFileSystemAdminsOnly(CustodianServiceImage);
            if (!VerifyNoUserAccess(CustodianServiceImage))
                throw new InvalidOperationException("svc-acl-verify-failed");
            File.WriteAllText(
                CustodianConfigFile,
                "{\"image\":\"" + image.Replace("\\", "\\\\") + "\",\"userSid\":\"" + userSid +
                "\",\"clientHelper\":\"" + clientHelper.Replace("\\", "\\\\") +
                "\",\"serviceImage\":\"" + CustodianServiceImage.Replace("\\", "\\\\") + "\"}");
            HardenFileSystemAdminsOnly(CustodianConfigFile);
            string binPath = "\"" + CustodianServiceImage + "\" --svc-run --image \"" + image + "\"";
            RunSc("create " + CustodianServiceName + " binPath= \"" + binPath + "\" start= demand DisplayName= \"PaySwap Credential Custodian\"");
            RunSc("start " + CustodianServiceName);
            Console.Out.WriteLine("svc-install:ok");
            return 0;
        }

        private static int SvcUninstall(string[] args)
        {
            RunSc("stop " + CustodianServiceName);
            RunSc("delete " + CustodianServiceName);
            try { File.Delete(CustodianKeyBlobFile); } catch { }
            try { File.Delete(CustodianServiceImage); } catch { }
            try { Directory.Delete(CustodianServiceBinDir); } catch { }
            Console.Out.WriteLine("svc-uninstall:ok");
            return 0;
        }

        private static void RunSc(string arguments)
        {
            var psi = new ProcessStartInfo("sc.exe", arguments);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            var p = Process.Start(psi);
            p.WaitForExit(30000);
            if (p.ExitCode != 0 && p.ExitCode != 1060 && p.ExitCode != 1062)
                throw new InvalidOperationException("sc-failed exit=" + p.ExitCode);
        }

        private static int SvcRun(string[] args)
        {
            diagPath = CustodianDiagFile;
            Diag("custodian:svc-start");
            Dictionary<string, string> parsed = ParseArguments(args);
            custodianElectronImage = RequireArgument(parsed, "--image").ToLowerInvariant();
            // A4 测试缝封闭：生产服务模式绝不接受 --test-gate —— 在场即拒绝启动
            //（门放松不可能以参数注入到达 SYSTEM 服务）。
            if (parsed.ContainsKey("--test-gate"))
            {
                Diag("custodian:svc-run-test-gate-refused");
                Console.Error.WriteLine("custodian:test-gate-not-allowed-in-service-mode");
                return 1;
            }
            // A4 服务可执行边界自检（fail-closed）：映像必须恰是受保护目录副本，
            // 且 ACL 未被削弱（安装/更新不悄悄弱化 —— 启动时验证，违者不起服务）。
            string selfImage = System.Reflection.Assembly.GetExecutingAssembly().Location;
            if (!string.Equals(Path.GetFullPath(selfImage), Path.GetFullPath(CustodianServiceImage), StringComparison.OrdinalIgnoreCase))
            {
                Diag("custodian:svc-image-not-protected");
                Console.Error.WriteLine("custodian:service-image-outside-protected-location");
                return 1;
            }
            if (!VerifyNoUserAccess(CustodianServiceImage))
            {
                Diag("custodian:svc-acl-weakened");
                Console.Error.WriteLine("custodian:service-image-acl-weakened");
                return 1;
            }
            // config（SYSTEM 可读）：userSid（DACL 授权面）+ clientHelper（客户端
            // 映像门事实）。config 缺席/不可解析 = 门事实不全 → 全门关死（fail-closed）。
            try
            {
                string configText = File.ReadAllText(CustodianConfigFile);
                custodianUserSid = ExtractJsonString(configText, "\"userSid\":\"");
                string clientHelper = ExtractJsonString(configText, "\"clientHelper\":\"");
                custodianClientHelperImage = clientHelper == null ? null : clientHelper.ToLowerInvariant();
            }
            catch
            {
                Diag("custodian:config-unreadable");
            }
            System.ServiceProcess.ServiceBase.Run(new CustodianService());
            return 0;
        }

        private static string custodianTestGateSubstring;
        // console 模式测试缝（协议探针隔离面）：管道名/端点文件/blob 路径可指到
        // 探针私有路径 —— 生产 --svc-run 不读这些参数（结构上不可达）。
        private static string custodianActivePipeName = CustodianPipeName;
        private static string custodianActiveEndpointFile = CustodianEndpointFile;
        private static string custodianActiveKeyBlobFile = CustodianKeyBlobFile;

        private static int SvcConsole(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            custodianElectronImage = RequireArgument(parsed, "--image").ToLowerInvariant();
            custodianClientHelperImage = System.Reflection.Assembly.GetExecutingAssembly().Location.ToLowerInvariant();
            if (parsed.ContainsKey("--pipe") && !string.IsNullOrWhiteSpace(parsed["--pipe"]))
                custodianActivePipeName = NormalizePipeName(parsed["--pipe"]);
            if (parsed.ContainsKey("--endpoint") && !string.IsNullOrWhiteSpace(parsed["--endpoint"]))
                custodianActiveEndpointFile = parsed["--endpoint"];
            if (parsed.ContainsKey("--blob") && !string.IsNullOrWhiteSpace(parsed["--blob"]))
                custodianActiveKeyBlobFile = parsed["--blob"];
            if (parsed.ContainsKey("--diag") && !string.IsNullOrWhiteSpace(parsed["--diag"]))
                diagPath = parsed["--diag"];
            // 测试缝（--diag 同族）：console 门以 --test-gate 子串放宽父映像匹配，
            // 仅供协议验证；生产 --svc-run 不读此参数且显式拒绝（见 SvcRun）。
            if (parsed.TryGetValue("--test-gate", out custodianTestGateSubstring) && custodianTestGateSubstring.Length == 0)
                custodianTestGateSubstring = null;
            CustodianServeLoop();
            return 0;
        }

        private sealed class CustodianService : System.ServiceProcess.ServiceBase
        {
            public CustodianService()
            {
                this.ServiceName = CustodianServiceName;
                this.CanStop = true;
            }

            protected override void OnStart(string[] args)
            {
                var thread = new Thread(CustodianServeLoop);
                thread.IsBackground = false;
                thread.Start();
            }

            protected override void OnStop()
            {
                custodianStopping = true;
                // A0.5 W2 纪律：服务停止时释放在册主句柄（进程退出亦会关闭 —— 双保险）。
                CloseRegisteredMainHandle();
            }
        }

        private static void CustodianServeLoop()
        {
            // SYSTEM-wrapped 密钥 blob 自举（跨重启持久； SYSTEM DPAPI 自解）。形状
            // 法则：64..512 可打印 ASCII（与 push 同一 PlausibleSecretKey 法则 ——
            // 旧「恰 64 hex」从未被真实验证过：blob 持久化本身一直是坏的）。否则不
            // 采用（fail-closed 保留现场；推送会原子覆盖）。
            try
            {
                if (File.Exists(custodianActiveKeyBlobFile))
                {
                    byte[] blob = File.ReadAllBytes(custodianActiveKeyBlobFile);
                    byte[] plain = CryptUnprotectBytes(blob);
                    string hex = System.Text.Encoding.UTF8.GetString(plain);
                    if (IsPlausibleSecretKey(hex))
                    {
                        lock (CustodianStateLock) { custodianKeyHex = hex; }
                        Diag("custodian:bootstrap-key-restored len=" + hex.Length);
                    }
                    else
                    {
                        Diag("custodian:bootstrap-blob-invalid len=" + hex.Length);
                    }
                }
            }
            catch
            {
                Diag("custodian:bootstrap-blob-unreadable");
            }

            // token + endpoint 文件（SYSTEM + 记录用户 RW —— main 读 pipe+token；
            // 管道门 + pid 门是真正的门）。启动即换 token：陈旧端点 ≠ 活性证据。
            string token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.GetDirectoryName(custodianActiveEndpointFile));
            File.WriteAllText(
                custodianActiveEndpointFile,
                "{\"pipe\":\"" + custodianActivePipeName + "\",\"token\":\"" + token + "\"}");
            if (custodianActiveEndpointFile == CustodianEndpointFile) HardenEndpointFileAcl();
            Diag("custodian:endpoint-written");

            while (!custodianStopping)
            {
                NamedPipeServerStream pipe = CreateCustodianPipe();
                if (pipe == null) { Console.Error.WriteLine("custodian:pipe-null"); Thread.Sleep(500); continue; }
                Console.Error.WriteLine("custodian:listening");
                IAsyncResult pending = pipe.BeginWaitForConnection(null, null);
                while (!pending.IsCompleted && !custodianStopping) Thread.Sleep(200);
                if (custodianStopping) { try { pipe.Dispose(); } catch { } break; }
                try
                {
                    pipe.WaitForConnection();
                    Console.Error.WriteLine("custodian:connection");
                    ServeCustodianConnection(pipe, token);
                }
                catch
                {
                }
                try { pipe.Disconnect(); } catch { }
                try { pipe.Dispose(); } catch { }
            }
        }

        private static NamedPipeServerStream CreateCustodianPipe()
        {
            try
            {
                PipeSecurity security = new PipeSecurity();
                security.SetAccessRuleProtection(true, false);
                security.AddAccessRule(new PipeAccessRule(
                    new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                    PipeAccessRights.ReadWrite, AccessControlType.Allow));
                // console 测试态：服务 = 当前用户（Lenovo）→ 授自身；SYSTEM 态下
                // current user = SYSTEM（与上条重复，无害）。userSid（安装时记录的
                // Lenovo SID）在场时也授 —— 覆盖 packaged 语境。
                SecurityIdentifier currentUser = WindowsIdentity.GetCurrent().User;
                if (currentUser != null)
                {
                    security.AddAccessRule(new PipeAccessRule(
                        currentUser, PipeAccessRights.ReadWrite, AccessControlType.Allow));
                }
                if (custodianUserSid != null)
                {
                    security.AddAccessRule(new PipeAccessRule(
                        new SecurityIdentifier(custodianUserSid),
                        PipeAccessRights.ReadWrite, AccessControlType.Allow));
                }
                return new NamedPipeServerStream(
                    custodianActivePipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    PipeBufferSize,
                    PipeBufferSize,
                    security);
            }
            catch { return null; }
        }

        /** 密钥形状法则（push 与 bootstrap 共用 —— 单一事实源）：32..512 可打印
            ASCII（provider 密钥形态 —— 下界对齐账户服务 formatCheck 可接受的
            最短形态：E2E 合成键 56 字符、真实受限键 107 字符；上界防滥用）。
            服务端形状检查是纵深防御 —— 身份门才是主边界；provider 语义权威在
            账户服务的 formatCheck/read-back（TS 侧）。 */
        private static bool IsPlausibleSecretKey(string value)
        {
            if (value == null || value.Length < 32 || value.Length > 512) return false;
            foreach (char c in value)
            {
                if (c < 0x21 || c > 0x7E) return false;
            }
            return true;
        }

        /** 客户端映像门：连接进程 == config clientHelper 全路径（精确，非子串）。
            未配置 = 门关死（fail-closed）。 */
        private static bool ImageGateAllowsClient(int clientPid)
        {
            if (custodianClientHelperImage == null) return false;
            return VerifyProcessImagePath(clientPid, custodianClientHelperImage);
        }

        /** 注册门（含 first-alive-wins，F6 修复）：父映像 == config electron 全路径
            且父进程活着；**在册主进程存活时拒绝 rebind** —— 单实例桌面法则
           （main/index.ts requestSingleInstanceLock）下，真实桌面在册即拥有服务；
            一个同用户进程用「同映像 electron + 攻击入口脚本」冒充桌面时，其注册
            被拒（在册主未死）。rebind 仅当在册主已死（陈旧注册 —— 应用重启/退
            出后的新注册）。残留窗口（ADR §A0.3/§A0.5）：服务重启/在册主死亡瞬间的注册
            竞态（先到先得，赢家拿到保管通道直到自身消亡 —— 该竞态的抢注会让真
            实桌面连接 typed 失败，响亮可见，非静默冒充）。
            在册主的「活着」判定用**保留句柄**（A0.5 W2 —— 句柄引用原始进程对象；
            PID 复用 → 原对象已死 → 句柄 signaled），不是 pid+映像的重新解析。 */
        private static bool RegisteredMainAlive()
        {
            if (registeredMainPid == -1 || registeredMainHandle == IntPtr.Zero) return false;
            // WAIT_OBJECT_0 = 进程已退出；WAIT_TIMEOUT = 仍在运行；WAIT_FAILED = 句柄失效（同样视为已死）。
            return WaitForSingleObject(registeredMainHandle, 0) == 0x00000102 /* WAIT_TIMEOUT */;
        }

        private static bool RegisterGateAllows(int parentPid, string parentImage)
        {
            if (custodianTestGateSubstring != null)
                return parentImage != null && parentImage.ToLowerInvariant().Contains(custodianTestGateSubstring);
            if (custodianElectronImage == null) return false;
            if (RegisteredMainAlive())
            {
                Diag("custodian:register-alive-exists registered=" + registeredMainPid);
                return false;
            }
            return VerifyProcessImagePath(parentPid, custodianElectronImage);
        }

        /** 客户端父进程门（数据操作，F6 修复核心 + A0.5 W2）：数据操作只接受
            **恰注册的桌面进程实例** —— 三重合取：
            ① helper 的父 pid == 在册 pid；② **保留句柄仍活跃**（WaitForSingleObject
            即时探测 —— PID 复用/原进程退出都使句柄 signaled → 拒绝，哪怕复用者
            恰是同映像 electron）；③ 当前持有该 pid 的进程映像 == config electron
            全路径（OpenProcess+QueryFullProcessImageName 内核事实）。 */
        private static bool IsAuthorizedCustodianParent(int parentPid, string parentImage)
        {
            if (custodianTestGateSubstring != null)
                return parentImage != null && parentImage.ToLowerInvariant().Contains(custodianTestGateSubstring);
            if (custodianElectronImage == null) return false;
            if (registeredMainPid == -1 || parentPid != registeredMainPid) return false;
            if (!RegisteredMainAlive()) return false;
            return VerifyProcessImagePath(parentPid, custodianElectronImage);
        }

        private static void ServeCustodianConnection(NamedPipeServerStream pipe, string token)
        {
            uint clientPid = 0;
            try
            {
                uint clientProcessId;
                if (GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientProcessId))
                    clientPid = clientProcessId;
            }
            catch { }
            Diag("custodian:conn pid=" + clientPid);

            // token 握手（真界 5s —— 超时/不匹配 = 静默断开，无应答行）。
            string tokenLine = ReadPipeLine(pipe, 5000);
            if (tokenLine == null || tokenLine.Trim() != token)
            {
                Diag("custodian:token-mismatch pid=" + clientPid);
                return;
            }

            // 操作行（真界 8s + 长度上限 —— 超长 = 断开，不读载荷余量）。
            string opLine = ReadPipeLine(pipe, 8000);
            if (opLine == null || opLine.Length > MaxControlLineLength * 8)
            {
                Diag("custodian:op-unreadable pid=" + clientPid);
                return;
            }
            string op = ExtractJsonString(opLine, "\"op\":\"");
            if (op == null) { Diag("custodian:op-unparsable pid=" + clientPid); return; }

            // A2 诊断纪律：绝不记录 opLine/token/载荷 —— 只记决策事实（pid/原因/长度）。
            // 客户端映像门（A4）：复制的 helper / 镜像进程不可达。
            if (!ImageGateAllowsClient((int)clientPid))
            {
                Diag("custodian:client-image-reject pid=" + clientPid);
                return;
            }

            // 父链事实：client pid 的父（内核 TOOLHELP 快照，非线上声明）。
            int parentPid;
            string parentImage;
            if (!GetParentProcessInfo((int)clientPid, out parentPid, out parentImage))
            {
                Diag("custodian:parent-unavailable pid=" + clientPid);
                return;
            }
            Diag("custodian:parent pid=" + parentPid);

            if (op == "register")
            {
                if (!RegisterGateAllows(parentPid, parentImage))
                {
                    Diag("custodian:register-gate-reject parent=" + parentPid);
                    return;
                }
                // A0.5 W2：保留在册主的内核句柄（SYNCHRONIZE | QueryLimited）——
                // 进程实例身份的锚。打开失败 = fail-closed（不接受无句柄注册）。
                IntPtr handle = OpenProcess(
                    0x00100000 /* SYNCHRONIZE */ | ProcessQueryLimitedInformation,
                    false, parentPid);
                if (handle == IntPtr.Zero)
                {
                    Diag("custodian:register-handle-failed parent=" + parentPid);
                    return;
                }
                bool rebind = registeredMainPid != -1;
                CloseRegisteredMainHandle();
                registeredMainPid = parentPid;
                registeredMainHandle = handle;
                Diag((rebind ? "custodian:register-rebind parent=" : "custodian:register-ok parent=") + parentPid);
                WritePipeLine(pipe, "{\"v\":1,\"ok\":true,\"registered\":" + parentPid + "}");
                return;
            }

            if (!IsAuthorizedCustodianParent(parentPid, parentImage))
            {
                Diag("custodian:data-gate-reject parent=" + parentPid);
                return;
            }

            if (op == "push") { ServeCustodianPush(pipe, opLine); return; }
            if (op == "drop") { ServeCustodianDrop(pipe); return; }
            if (op == "get") { ServeCustodianGet(pipe, opLine); return; }
            Diag("custodian:op-unknown");
        }

        /** 持久托管 push（A4）：protect → 原子写（tmp + Replace/Move + SYSTEM-only
            ACL）→ 回读解包逐字节验证 → 才改内存并应答 ok。任何失败 = ok:false
           （绝不把未证实持久化的密钥谎报为已保管）。 */
        private static void ServeCustodianPush(NamedPipeServerStream pipe, string opLine)
        {
            string key = ExtractJsonString(opLine, "\"key\":\"");
            if (!IsPlausibleSecretKey(key))
            {
                Diag("custodian:push-shape-invalid len=" + (key == null ? -1 : key.Length));
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"shape-invalid\"}");
                return;
            }
            byte[] plain = System.Text.Encoding.UTF8.GetBytes(key);
            byte[] blob;
            try { blob = CryptProtectBytes(plain); }
            catch
            {
                // A2 纪律：只记稳定事实（win32 错误码），不记任何密钥材料。
                Diag("custodian:push-protect-failed err=" + Marshal.GetLastWin32Error());
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                return;
            }
            string tmpPath = custodianActiveKeyBlobFile + ".tmp";
            try
            {
                File.WriteAllBytes(tmpPath, blob);
                if (File.Exists(custodianActiveKeyBlobFile)) File.Replace(tmpPath, custodianActiveKeyBlobFile, null);
                else File.Move(tmpPath, custodianActiveKeyBlobFile);
            }
            catch
            {
                Diag("custodian:push-persist-failed");
                try { File.Delete(tmpPath); } catch { }
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                return;
            }
            try
            {
                byte[] roundtrip = CryptUnprotectBytes(File.ReadAllBytes(custodianActiveKeyBlobFile));
                if (roundtrip.Length != plain.Length)
                {
                    Diag("custodian:push-verify-mismatch");
                    WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                    return;
                }
                for (int i = 0; i < plain.Length; i++)
                {
                    if (roundtrip[i] != plain[i])
                    {
                        Diag("custodian:push-verify-mismatch");
                        WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                        return;
                    }
                }
            }
            catch
            {
                Diag("custodian:push-verify-failed");
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                return;
            }
            // ACL 最后收紧（验证之后）：blob 是 SYSTEM-DPAPI 包装（用户即使临时可读
            // 也无法解包），稳态 = 仅 SYSTEM 可访问（A4 存储边界）。console 探针语境
            // （非 SYSTEM）在验证阶段需要自身可读 —— 收紧必须在验证之后。
            try { HardenFileSystemOnly(custodianActiveKeyBlobFile); }
            catch
            {
                Diag("custodian:push-acl-failed");
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"persist-failed\"}");
                return;
            }
            lock (CustodianStateLock) { custodianKeyHex = key; }
            Diag("custodian:push-ok len=" + key.Length);
            WritePipeLine(pipe, "{\"v\":1,\"ok\":true}");
        }

        /** 持久托管 drop（A4）：清内存 → 删 blob → 证实不存在 → 才应答 ok。清除
            不可证实 = ok:false（连接状态绝不被误认为成功撤销）。 */
        private static void ServeCustodianDrop(NamedPipeServerStream pipe)
        {
            lock (CustodianStateLock) { custodianKeyHex = null; }
            try
            {
                if (File.Exists(custodianActiveKeyBlobFile)) File.Delete(custodianActiveKeyBlobFile);
            }
            catch
            {
                Diag("custodian:drop-delete-failed");
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"drop-failed\"}");
                return;
            }
            if (File.Exists(custodianActiveKeyBlobFile))
            {
                Diag("custodian:drop-verify-failed");
                WritePipeLine(pipe, "{\"v\":1,\"ok\":false,\"error\":\"drop-failed\"}");
                return;
            }
            Diag("custodian:drop-ok");
            WritePipeLine(pipe, "{\"v\":1,\"ok\":true}");
        }

        /** 有界只读代理 GET（五路径闭集服务端强制；key 只进 Authorization 头）。 */
        private static void ServeCustodianGet(NamedPipeServerStream pipe, string opLine)
        {
            string path = ExtractJsonString(opLine, "\"path\":\"");
            if (path == null || path.Length > 256)
            {
                Diag("custodian:get-shape-invalid");
                return;
            }
            if (!CustodianAllowedPaths.Split('|').Contains(path.Split('?')[0]))
            {
                Diag("custodian:get-path-not-allowed");
                return;
            }
            string key;
            lock (CustodianStateLock) { key = custodianKeyHex; }
            if (key == null)
            {
                Diag("custodian:get-no-key");
                WritePipeLine(pipe, "{\"v\":1,\"status\":0,\"body\":\"no-key\"}");
                return;
            }
            try
            {
                // Stripe 需要 TLS 1.2+（.NET Framework 缺省不含 Tls12 —— 显式启用）；
                // Proxy=null（SYSTEM 下 WPAD/WinHTTP 代理故障是 status 0 的一类根因，
                // 直连消除该变量）；读写双 30s 界。有界重试（≤2 次，500ms 退避）只
                // 针对「无响应」类传输失败（DNS 瞬断/连接被断）—— 真实 HTTP 应答
                //（含 4xx/5xx）是权威结局，绝不重试。
                System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
                for (int attempt = 1; ; attempt++)
                {
                    try
                    {
                        var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("https://api.stripe.com" + path);
                        request.Method = "GET";
                        request.Headers.Add("Authorization", "Bearer " + key);
                        request.Timeout = 30000;
                        request.ReadWriteTimeout = 30000;
                        request.Proxy = null;
                        request.KeepAlive = false;
                        request.UserAgent = "payswap-custodian";
                        var response = (System.Net.HttpWebResponse)request.GetResponse();
                        string body = new StreamReader(response.GetResponseStream(), System.Text.Encoding.UTF8).ReadToEnd();
                        Diag("custodian:get-status=" + (int)response.StatusCode + " bodyLen=" + body.Length);
                        WritePipeLine(pipe, "{\"v\":1,\"status\":" + (int)response.StatusCode + ",\"body\":\"" + EscapeJson(body) + "\"}");
                        return;
                    }
                    catch (System.Net.WebException e)
                    {
                        var response = e.Response as System.Net.HttpWebResponse;
                        if (response != null)
                        {
                            string body = new StreamReader(response.GetResponseStream(), System.Text.Encoding.UTF8).ReadToEnd();
                            Diag("custodian:get-status=" + (int)response.StatusCode);
                            WritePipeLine(pipe, "{\"v\":1,\"status\":" + (int)response.StatusCode + ",\"body\":\"" + EscapeJson(body) + "\"}");
                            return;
                        }
                        // A2 诊断纪律：只记稳定枚举事实（WebException.Status），不记异常消息。
                        Diag("custodian:get-network-error status=" + e.Status + " attempt=" + attempt);
                        if (attempt < 3)
                        {
                            Thread.Sleep(500);
                            continue;
                        }
                        WritePipeLine(pipe, "{\"v\":1,\"status\":0,\"body\":\"network-error\"}");
                        return;
                    }
                }
            }
            catch
            {
                WritePipeLine(pipe, "{\"v\":1,\"status\":0,\"body\":\"network-error\"}");
            }
        }

        private static string EscapeJson(string value)
        {
            var sb = new StringBuilder(value.Length + 16);
            foreach (char c in value)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < ' ') sb.Append("\\u" + ((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static string ExtractJsonString(string line, string key)
        {
            try
            {
                int start = line.IndexOf(key, StringComparison.Ordinal);
                if (start < 0) return null;
                int valueStart = start + key.Length;
                int valueEnd = line.IndexOf('"', valueStart);
                if (valueEnd < 0) return null;
                return UnescapeJsonString(line.Substring(valueStart, valueEnd - valueStart));
            }
            catch { return null; }
        }

        private static bool ExtractJsonInt(string line, string key, out int value)
        {
            value = 0;
            try
            {
                int start = line.IndexOf(key, StringComparison.Ordinal);
                if (start < 0) return false;
                int valueStart = start + key.Length;
                int valueEnd = valueStart;
                while (valueEnd < line.Length && line[valueEnd] >= '0' && line[valueEnd] <= '9') valueEnd++;
                return ParsePositiveInt(line.Substring(valueStart, valueEnd - valueStart), out value);
            }
            catch { return false; }
        }

        private static bool GetParentProcessInfo(int pid, out int parentPid, out string parentImage)
        {
            parentPid = -1;
            parentImage = null;
            try
            {
                var snapshot = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
                if (snapshot == IntPtr.Zero) return false;
                try
                {
                    var entry = new PROCESSENTRY32();
                    entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                    if (Process32First(snapshot, ref entry))
                    {
                        do
                        {
                            if ((int)entry.th32ProcessID == pid)
                            {
                                parentPid = (int)entry.th32ParentProcessID;
                                break;
                            }
                        } while (Process32Next(snapshot, ref entry));
                    }
                }
                finally { CloseHandle(snapshot); }
                if (parentPid < 0) return false;
                IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, parentPid);
                if (process == IntPtr.Zero) return false;
                try
                {
                    var buffer = new StringBuilder(1024);
                    int size = 1024;
                    if (QueryFullProcessImageName(process, 0, buffer, ref size))
                    {
                        parentImage = buffer.ToString();
                        return true;
                    }
                    return false;
                }
                finally { CloseHandle(process); }
            }
            catch { return false; }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

        private static byte[] CryptProtectBytes(byte[] plain)
        {
            IntPtr buffer = Marshal.AllocHGlobal(plain.Length);
            try
            {
                Marshal.Copy(plain, 0, buffer, plain.Length);
                DATA_BLOB input;
                input.cbData = plain.Length;
                input.pbData = buffer;
                DATA_BLOB output;
                // CRYPTPROTECT_UI_FORBIDDEN（0x1）：服务/无界面进程纪律 —— DPAPI 绝不
                // 弹 UI（SYSTEM 桌面不可见，弹 UI = 永久挂起）。签名 = DATA_BLOB 结构
                // 指针（此前 byte[] 直传把明文当 blob 头解析 —— DPAPI 永久失败的根因，
                // 旧实现靠 catch 吞掉该失败伪装成功；本实现直面失败，A4 持久纪律）。
                if (!CryptProtectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0x1, out output))
                    throw new InvalidOperationException("protect err=" + Marshal.GetLastWin32Error());
                try
                {
                    byte[] result = new byte[output.cbData];
                    Marshal.Copy(output.pbData, result, 0, output.cbData);
                    return result;
                }
                finally
                {
                    if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static byte[] CryptUnprotectBytes(byte[] blob)
        {
            IntPtr buffer = Marshal.AllocHGlobal(blob.Length);
            try
            {
                Marshal.Copy(blob, 0, buffer, blob.Length);
                DATA_BLOB input;
                input.cbData = blob.Length;
                input.pbData = buffer;
                DATA_BLOB output;
                string descrOut;
                // CRYPTPROTECT_UI_FORBIDDEN（0x1）—— 与 protect 同纪律。
                if (!CryptUnprotectData(ref input, out descrOut, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0x1, out output))
                    throw new InvalidOperationException("unprotect err=" + Marshal.GetLastWin32Error());
                try
                {
                    byte[] result = new byte[output.cbData];
                    Marshal.Copy(output.pbData, result, 0, output.cbData);
                    return result;
                }
                finally
                {
                    if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DATA_BLOB
        {
            public int cbData;
            public IntPtr pbData;
        }

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out DATA_BLOB pDataOut);

        [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, out string ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out DATA_BLOB pDataOut);

        /** 真界管道读（A4 修复）：deadline 由 Task.WaitAny 强制 —— 底层读阻塞不再
            能挂死服务（广告超时即真超时）。超时返回 null，断开由调用方执行；放弃
            的挂起读经续体观测，未观察异常不逃逸。 */
        private static string ReadPipeLine(NamedPipeServerStream pipe, int timeoutMs)
        {
            var sb = new StringBuilder();
            var buffer = new byte[1];
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0 || !pipe.IsConnected) return null;
                System.Threading.Tasks.Task<int> readTask = pipe.ReadAsync(buffer, 0, 1);
                var unused = readTask.ContinueWith(
                    t => { var ignored = t.Exception; },
                    System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted |
                    System.Threading.Tasks.TaskContinuationOptions.ExecuteSynchronously);
                int winnerIndex = System.Threading.Tasks.Task.WaitAny(
                    new System.Threading.Tasks.Task[] { readTask }, remaining);
                if (winnerIndex != 0) return null;
                int read;
                try { read = readTask.GetAwaiter().GetResult(); }
                catch { return null; }
                if (read == 0) return null;
                char c = (char)buffer[0];
                if (c == '\n') return sb.ToString();
                if (c != '\r') sb.Append(c);
                if (sb.Length > MaxControlLineLength * 8) return null;
            }
        }

        private static void WritePipeLine(NamedPipeServerStream pipe, string line)
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(line + "\n");
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
            // DisconnectNamedPipe 会丢弃对端未读的字节 —— 不等排空就断开 = 竞态丢
            // 应答（快客户端侥幸，慢客户端 EOF）。有界等待对端读尽（5s 界，绝不挂死）。
            try
            {
                System.Threading.Tasks.Task drain = System.Threading.Tasks.Task.Run(
                    new Action(pipe.WaitForPipeDrain));
                var unused = drain.ContinueWith(
                    t => { var ignored = t.Exception; },
                    System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted |
                    System.Threading.Tasks.TaskContinuationOptions.ExecuteSynchronously);
                System.Threading.Tasks.Task.WaitAny(new System.Threading.Tasks.Task[] { drain }, 5000);
            }
            catch
            {
            }
        }

        // ------------------------------------------------------------------
        // custodian helper 客户端（退出码契约：0 = 成功 + stdout reply；70 = 门拒
        //（EOF 无应答）；71 = 服务不可达；72 = 协议失败/未证实；1 = 用法。stderr
        // 只有稳定码 —— 绝不回显 reply 内容/密钥/路径）。push/drop/register 以
        // reply ok:true 为成功 —— 服务端已含持久纪律，客户端绝不为 ok:false 谎报。
        // ------------------------------------------------------------------

        private static int CustodianClient(string[] args, string op)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            // console 探针隔离缝：--endpoint-file 指到探针私有端点（生产无此参数 =
            // 生产端点文件）。
            string endpointFile = parsed.ContainsKey("--endpoint-file") &&
                !string.IsNullOrWhiteSpace(parsed["--endpoint-file"])
                ? parsed["--endpoint-file"]
                : custodianActiveEndpointFile;
            string endpointText;
            try { endpointText = File.ReadAllText(endpointFile); }
            catch { Console.Error.WriteLine("custodian_client:endpoint-absent"); return 71; }
            string pipeName = ExtractJsonString(endpointText, "\"pipe\":\"");
            string token = ExtractJsonString(endpointText, "\"token\":\"");
            if (pipeName == null || token == null)
            {
                Console.Error.WriteLine("custodian_client:endpoint-unparsable");
                return 71;
            }

            NamedPipeClientStream pipe;
            try
            {
                pipe = new NamedPipeClientStream(".", NormalizePipeName(pipeName), PipeDirection.InOut);
                pipe.Connect(10000);
            }
            catch
            {
                Console.Error.WriteLine("custodian_client:service-unreachable");
                return 71;
            }

            try
            {
                byte[] tokenBytes = System.Text.Encoding.UTF8.GetBytes(token + "\n");
                pipe.Write(tokenBytes, 0, tokenBytes.Length);
                pipe.Flush();

                string opLine;
                if (op == "register")
                {
                    int parentPid;
                    string parentImage;
                    GetParentProcessInfo(System.Diagnostics.Process.GetCurrentProcess().Id, out parentPid, out parentImage);
                    opLine = "{\"op\":\"register\",\"pid\":" + parentPid + "}";
                }
                else if (op == "drop")
                {
                    opLine = "{\"op\":\"drop\"}";
                }
                else if (op == "push")
                {
                    string key = Console.In.ReadLine();
                    if (string.IsNullOrWhiteSpace(key))
                    {
                        Console.Error.WriteLine("custodian_client:missing-key");
                        return 1;
                    }
                    key = key.Trim();
                    opLine = "{\"op\":\"push\",\"key\":\"" + key + "\"}";
                }
                else
                {
                    string path = RequireArgument(parsed, "--path");
                    opLine = "{\"op\":\"get\",\"path\":\"" + path + "\"}";
                }
                byte[] opBytes = System.Text.Encoding.UTF8.GetBytes(opLine + "\n");
                pipe.Write(opBytes, 0, opBytes.Length);
                pipe.Flush();

                // 有界读应答（40s —— 服务端各界之和之上；EOF 无应答 = 门拒）。
                string reply = ReadClientReply(pipe, 40000);
                if (reply == null)
                {
                    Console.Error.WriteLine("custodian_client:gate-refused");
                    return 70;
                }
                if (!reply.StartsWith("{", StringComparison.Ordinal) ||
                    reply.IndexOf("\"v\":1", StringComparison.Ordinal) < 0)
                {
                    Console.Error.WriteLine("custodian_client:protocol-failed");
                    return 72;
                }
                if (op == "get")
                {
                    Console.Out.WriteLine(reply.Trim());
                    return 0;
                }
                if (reply.IndexOf("\"ok\":true", StringComparison.Ordinal) < 0)
                {
                    Console.Error.WriteLine("custodian_client:op-not-confirmed");
                    return 72;
                }
                Console.Out.WriteLine(reply.Trim());
                return 0;
            }
            catch
            {
                Console.Error.WriteLine("custodian_client:io-failed");
                return 72;
            }
            finally
            {
                try { pipe.Dispose(); } catch { }
            }
        }

        /** 客户端有界行读（真界 Task.WaitAny 形态 —— 与服务端 ReadPipeLine 同纪律）。 */
        private static string ReadClientReply(NamedPipeClientStream pipe, int timeoutMs)
        {
            var sb = new StringBuilder();
            var buffer = new byte[1];
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0) return null;
                System.Threading.Tasks.Task<int> readTask = pipe.ReadAsync(buffer, 0, 1);
                var unused = readTask.ContinueWith(
                    t => { var ignored = t.Exception; },
                    System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted |
                    System.Threading.Tasks.TaskContinuationOptions.ExecuteSynchronously);
                int winnerIndex = System.Threading.Tasks.Task.WaitAny(
                    new System.Threading.Tasks.Task[] { readTask }, remaining);
                if (winnerIndex != 0) return null;
                int read;
                try { read = readTask.GetAwaiter().GetResult(); }
                catch { return null; }
                if (read == 0) return null;
                char c = (char)buffer[0];
                if (c == '\n') return sb.ToString();
                if (c != '\r') sb.Append(c);
                if (sb.Length > MaxControlLineLength * 64) return null;
            }
        }

        // ------------------------------------------------------------------
        // spawn 表（D14.5/D14.8）：pid → 期望映像（null = 无法核验）；append/replace-only。
        // ------------------------------------------------------------------

        private sealed class SpawnTable
        {
            private readonly Dictionary<int, string> entries = new Dictionary<int, string>();

            public void Add(int pid, string image)
            {
                lock (entries)
                {
                    entries[pid] = image; // 同 pid 后推覆盖（host spawn 表是 pid→实例路由）
                }
            }

            public bool TryLookup(int pid, out string image)
            {
                lock (entries)
                {
                    return entries.TryGetValue(pid, out image);
                }
            }
        }
    }
}

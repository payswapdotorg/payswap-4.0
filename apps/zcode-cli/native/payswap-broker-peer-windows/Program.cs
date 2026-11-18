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

        /** 诊断行（--diag 缺省 = no-op）；IO 失败吞没 —— 诊断绝不影响服务路径。 */
        private static void Diag(string line)
        {
            if (diagPath == null) return;
            try
            {
                lock (DiagLock)
                {
                    File.AppendAllText(diagPath,
                        DateTime.UtcNow.ToString("o") + " " + line + Environment.NewLine);
                }
            }
            catch
            {
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
        private const string CustodianAllowedPaths =
            "/v1/balance|/v1/charges|/v1/customers|/v1/disputes|/v1/account";

        private static volatile bool custodianStopping;
        private static readonly object CustodianStateLock = new object();
        private static int registeredMainPid = -1;
        private static string custodianKeyHex;
        private static string custodianElectronImage;
        private static string custodianHelperImage;
        private static string custodianUserSid;

        private static int SvcInstall(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            string image = RequireArgument(parsed, "--image");
            string helperPath = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string userSid = WindowsIdentity.GetCurrent().User.Value;
            Directory.CreateDirectory(CustodianProgramDataDir);
            File.WriteAllText(
                CustodianConfigFile,
                "{\"image\":\"" + image.Replace("\\", "\\\\") + "\",\"userSid\":\"" + userSid +
                "\",\"helper\":\"" + helperPath.Replace("\\", "\\\\") + "\"}");
            string binPath = "\"" + helperPath + "\" --svc-run --image \"" + image + "\"";
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
            Dictionary<string, string> parsed = ParseArguments(args);
            custodianElectronImage = RequireArgument(parsed, "--image").ToLowerInvariant();
            custodianHelperImage = System.Reflection.Assembly.GetExecutingAssembly().Location.ToLowerInvariant();
            // config 里的 userSid（Lenovo SID）：DACL 授权面（endpoint 文件 + 管道）。
            try
            {
                string configText = File.ReadAllText(CustodianConfigFile);
                custodianUserSid = ExtractJsonString(configText, "\"userSid\":\"");
            }
            catch { }
            System.ServiceProcess.ServiceBase.Run(new CustodianService());
            return 0;
        }

        private static string custodianTestGateSubstring;

        private static int SvcConsole(string[] args)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            custodianElectronImage = RequireArgument(parsed, "--image").ToLowerInvariant();
            custodianHelperImage = System.Reflection.Assembly.GetExecutingAssembly().Location.ToLowerInvariant();
            // 测试缝（--diag 同族）：console 门以 --test-gate 子串放宽父映像匹配，仅供
            // 协议验证；生产 --svc-run 不传（门走 electron 全路径）。
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
            }
        }

        private static void CustodianServeLoop()
        {
            // SYSTEM-wrapped 密钥 blob 自举（跨重启持久； SYSTEM DPAPI 自解）。
            try
            {
                if (File.Exists(CustodianKeyBlobFile))
                {
                    byte[] blob = File.ReadAllBytes(CustodianKeyBlobFile);
                    byte[] plain = CryptUnprotectBytes(blob);
                    string hex = System.Text.Encoding.UTF8.GetString(plain);
                    if (hex.Length == 64) lock (CustodianStateLock) { custodianKeyHex = hex; }
                }
            }
            catch { }

            // token + endpoint 文件（Lenovo 可读 → main 读；管道门 + pid 门是真正的门）。
            string token = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(CustodianProgramDataDir);
            File.WriteAllText(
                CustodianEndpointFile,
                "{\"pipe\":\"" + CustodianPipeName + "\",\"token\":\"" + token + "\"}");

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
                    CustodianPipeName,
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

        /** 单连接服务：token 握手 → 注册/数据操作。门 = 内核 client pid + 映像 + 父链。 */
        /** 客户端父进程门：测试缝 = 父映像子串（MSYS fork 使测试父 pid 不稳定）；
            生产 = 精确 registered pid + electron 全路径。 */
        private static bool IsAuthorizedCustodianParent(int parentPid, string parentImage)
        {
            if (parentImage == null) return false;
            string lower = parentImage.ToLowerInvariant();
            if (custodianTestGateSubstring != null)
                return lower.Contains(custodianTestGateSubstring);
            return parentPid == registeredMainPid && lower.Contains("electron.exe");
        }

        private static void ServeCustodianConnection(NamedPipeServerStream pipe, string token)
        {
            Console.Error.WriteLine("custodian:serve");
            uint clientPid = 0;
            try
            {
                uint clientProcessId;
                if (GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientProcessId))
                    clientPid = clientProcessId;
            }
            catch { }
            Console.Error.WriteLine("custodian:clientPid=" + clientPid);

            string tokenLine = ReadPipeLine(pipe, 5000);
            Console.Error.WriteLine("custodian:token=" + (tokenLine == null ? "null" : (tokenLine.Trim() == token ? "match" : "mismatch-len" + tokenLine.Trim().Length)));
            if (tokenLine == null || tokenLine.Trim() != token) return;

            string opLine = ReadPipeLine(pipe, 8000);
            Console.Error.WriteLine("custodian:op=" + (opLine == null ? "null" : opLine));
            if (opLine == null) return;
            string op = ExtractJsonString(opLine, "\"op\":\"");
            if (op == null) { Console.Error.WriteLine("custodian:op-unparsable"); return; }

            // 父链事实：client pid 的父 = main（electron 映像）。所有操作共用此门。
            int parentPid;
            string parentImage;
            if (!GetParentProcessInfo((int)clientPid, out parentPid, out parentImage)) { Console.Error.WriteLine("custodian:parent-unavailable"); return; }
            Console.Error.WriteLine("custodian:parent=" + parentPid + " image=" + parentImage);
            if (!IsAuthorizedCustodianParent(parentPid, parentImage)) { Console.Error.WriteLine("custodian:gate-reject"); return; }

            if (op == "register")
            {
                // 注册 = 自报内核父 pid（client 用 TOOLHELP 查自己的父）+ electron 映像门
                //（父映像由服务用 QueryFullProcessImageName 核验 —— 线上声明不参与）。
                registeredMainPid = parentPid;
                WritePipeLine(pipe, "{\"v\":1,\"ok\":true,\"registered\":" + parentPid + "}");
                return;
            }
            // 生产 = registered pid 精确门；测试缝（MSYS fork 使父 pid 不稳定）= 映像门。
            if (custodianTestGateSubstring == null && parentPid != registeredMainPid)
            { Console.Error.WriteLine("custodian:not-registered-parent pid=" + parentPid); return; }

            if (op == "push")
            {
                string key = ExtractJsonString(opLine, "\"key\":\"");
                if (key == null || key.Length < 64) { Console.Error.WriteLine("custodian:push-shape-invalid len=" + (key == null ? -1 : key.Length)); return; }
                lock (CustodianStateLock) { custodianKeyHex = key; }
                try
                {
                    byte[] plain = System.Text.Encoding.UTF8.GetBytes(key);
                    byte[] blob = CryptProtectBytes(plain);
                    File.WriteAllBytes(CustodianKeyBlobFile, blob);
                }
                catch (Exception e) { Console.Error.WriteLine("custodian:blob-write-failed " + e.Message); }
                Console.Error.WriteLine("custodian:push-ok len=" + key.Length);
                WritePipeLine(pipe, "{\"v\":1,\"ok\":true}");
                return;
            }

            if (op == "drop")
            {
                lock (CustodianStateLock) { custodianKeyHex = null; }
                try { File.Delete(CustodianKeyBlobFile); } catch { }
                WritePipeLine(pipe, "{\"v\":1,\"ok\":true}");
                return;
            }

            if (op == "get")
            {
                string path = ExtractJsonString(opLine, "\"path\":\"");
                if (path == null) return;
                if (!CustodianAllowedPaths.Split('|').Contains(path.Split('?')[0])) { Console.Error.WriteLine("custodian:get-path-not-allowed " + path); return; }
                string key;
                lock (CustodianStateLock) { key = custodianKeyHex; }
                if (key == null) { Console.Error.WriteLine("custodian:get-no-key"); WritePipeLine(pipe, "{\"v\":1,\"status\":0,\"body\":\"no-key\"}"); return; }
                try
                {
                    // Stripe 需要 TLS 1.2+（.NET Framework 缺省不含 Tls12 —— 显式启用）。
                    System.Net.ServicePointManager.SecurityProtocol |= System.Net.SecurityProtocolType.Tls12;
                    var request = (System.Net.HttpWebRequest)System.Net.WebRequest.Create("https://api.stripe.com" + path);
                    request.Method = "GET";
                    request.Headers.Add("Authorization", "Bearer " + key);
                    request.Timeout = 30000;
                    var response = (System.Net.HttpWebResponse)request.GetResponse();
                    string body = new StreamReader(response.GetResponseStream(), System.Text.Encoding.UTF8).ReadToEnd();
                    Console.Error.WriteLine("custodian:get-status=" + (int)response.StatusCode + " bodyLen=" + body.Length);
                    WritePipeLine(pipe, "{\"v\":1,\"status\":" + (int)response.StatusCode + ",\"body\":\"" + EscapeJson(body) + "\"}");
                }
                catch (System.Net.WebException e)
                {
                    var response = e.Response as System.Net.HttpWebResponse;
                    if (response != null)
                    {
                        string body = new StreamReader(response.GetResponseStream(), System.Text.Encoding.UTF8).ReadToEnd();
                        WritePipeLine(pipe, "{\"v\":1,\"status\":" + (int)response.StatusCode + ",\"body\":\"" + EscapeJson(body) + "\"}");
                    }
                    else
                    {
                        Console.Error.WriteLine("custodian:get-network-error " + e.Message);
                        WritePipeLine(pipe, "{\"v\":1,\"status\":0,\"body\":\"network-error\"}");
                    }
                }
                return;
            }
            Console.Error.WriteLine("custodian:op-unknown " + op);
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
            IntPtr desc = IntPtr.Zero;
            byte[] output;
            if (!CryptProtectData(plain, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output))
                throw new InvalidOperationException("protect");
            return output;
        }

        private static byte[] CryptUnprotectBytes(byte[] blob)
        {
            byte[] output;
            string descrOut; if (!CryptUnprotectData(blob, out descrOut, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, out output))
                throw new InvalidOperationException("unprotect");
            return output;
        }

        [DllImport("crypt32.dll", SetLastError = true)]
        private static extern bool CryptProtectData(byte[] pDataIn, string szDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out byte[] pDataOut);

        [DllImport("crypt32.dll", SetLastError = true)]
        private static extern bool CryptUnprotectData(byte[] pDataIn, out string ppszDataDescr, IntPtr pOptionalEntropy, IntPtr pvReserved, IntPtr pPromptStruct, uint dwFlags, out byte[] pDataOut);

        private static string ReadPipeLine(NamedPipeServerStream pipe, int timeoutMs)
        {
            var sb = new StringBuilder();
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            var buffer = new byte[1];
            while (DateTime.UtcNow < deadline)
            {
                if (!pipe.IsConnected) return null;
                int read = pipe.ReadAsync(buffer, 0, 1).GetAwaiter().GetResult();
                if (read == 0) return null;
                char c = (char)buffer[0];
                if (c == '\n') return sb.ToString();
                if (c != '\r') sb.Append(c);
                if (sb.Length > MaxControlLineLength * 8) return null;
            }
            return null;
        }

        private static void WritePipeLine(NamedPipeServerStream pipe, string line)
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(line + "\n");
            pipe.WriteAsync(bytes, 0, bytes.Length).GetAwaiter().GetResult();
            pipe.Flush();
        }

        private static int CustodianClient(string[] args, string op)
        {
            Dictionary<string, string> parsed = ParseArguments(args);
            string endpointText = File.ReadAllText(CustodianEndpointFile);
            string pipeName = ExtractJsonString(endpointText, "\"pipe\":\"");
            string token = ExtractJsonString(endpointText, "\"token\":\"");
            if (pipeName == null || token == null) throw new InvalidDataException();

            var pipe = new NamedPipeClientStream(".", NormalizePipeName(pipeName), PipeDirection.InOut);
            pipe.Connect(10000);

            byte[] tokenBytes = System.Text.Encoding.UTF8.GetBytes(token + "\n");
            pipe.Write(tokenBytes, 0, tokenBytes.Length);

            string opLine;
            if (op == "register")
            {
                int parentPid;
                string parentImage;
                GetParentProcessInfo(System.Diagnostics.Process.GetCurrentProcess().Id, out parentPid, out parentImage);
                opLine = "{\"op\":\"register\",\"pid\":" + parentPid + "}";
            }
            else if (op == "push")
            {
                string key = Console.In.ReadLine();
                if (string.IsNullOrWhiteSpace(key)) throw new InvalidDataException();
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

            var sb = new StringBuilder();
            var buffer = new byte[4096];
            while (true)
            {
                int read = pipe.Read(buffer, 0, buffer.Length);
                if (read == 0) break;
                sb.Append(System.Text.Encoding.UTF8.GetString(buffer, 0, read));
                if (sb.ToString().Contains("\n")) break;
            }
            pipe.Dispose();
            Console.Out.WriteLine(sb.ToString().Trim());
            return 0;
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

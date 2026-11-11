using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
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

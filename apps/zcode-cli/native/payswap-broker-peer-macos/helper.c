/*
 * payswap-broker-peer-helper — PaySwap broker 对等验证 native helper，macOS §5.1 臂
 * （契约 w2-01 §3.1/§3.4/§5.1/§5.4；ADR-13）。
 *
 * 角色与边界（ADR-13 D13.1/D13.2/D13.3）：
 *   - 本 helper 持有公共 UDS 端点（host 只铸路径 —— mintBrokerBootState；host 永不 bind
 *     公共路径）；per-boot 0700 目录由 host 创建，本 helper belt 再 chmod 钉死；
 *   - 每条 accept 的连接在 accept 时读对等事实：getpeereid（effective uid）+
 *     LOCAL_PEERPID（pid）—— 两者任一失败 = 无法建立身份 = 在 socket 处丢弃，绝不 relay
 *     （§5.3(4) 家族法则）；
 *   - 事实已建立的连接（**包括 uid 不匹配的连接**）relay 给 host 的 ingress socket：
 *     首行 = 版本化头行 {"v":1,"t":"<token>","pid":N,"uid":N}\n，随后逐字节透明泵直到
 *     双向 EOF。本 helper 绝不解析载荷（§5.5(1)）—— uid 等值判据与 §5.5 全管线在 host；
 *   - 一次性 token 经 0600 token 文件交付（argv 对同 uid 进程经 ps 可见，故不走 argv）：
 *     读取后立即 unlink；每条 ingress 连接都带 token 重新认证。
 *
 * 生命周期（ADR-13 D13.4/D13.5）：
 *   - --parent-pid：启动时与周期性（accept 循环 250ms poll 超时）核验 getppid() —— 父
 *     变更（host 死亡）→ 摘端点 + exit(0)（§3.1(3)/§10.3：端点随宿主消亡）；
 *   - SIGTERM（host 的 stop()）：摘端点 + exit(0)；
 *   - §3.4(1)：绑定前移除既有条目（unlink；目录等不可移除条目 → 拒绝启动，绝不静默采纳）。
 *
 * 构建（CI gates-macos；本文件无任何第三方依赖）：
 *   cc -O2 -Wall -Wextra -o payswap-broker-peer-helper helper.c
 *
 * 仅 macOS（__APPLE__ 门内为完整实现；他平台编译即失败 —— 这是设计，不是缺陷）。
 * 宿主半边的协议纪律（头行严格性、token 常时比对、探针身份法则、降级路径）由
 * tests/payswap-broker-peer-relay.test.ts（协议忠实 fake）钉住；本 helper 的平台行由
 * tests/payswap-broker-peer-macos.test.ts 在 darwin 上钉住（playbook §5(5)）。
 */

#if !defined(__APPLE__)
#error "payswap-broker-peer-helper is the macOS (§5.1) arm; build it on darwin (see ADR-13)"
#endif

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* macOS <sys/un.h>：LOCAL_PEERPID（对端 pid）；SOL_LOCAL。防御性定义（老 SDK）。 */
#if !defined(LOCAL_PEERPID)
#define LOCAL_PEERPID 0x002
#endif
#if !defined(SOL_LOCAL)
#define SOL_LOCAL 0
#endif

/* 一次性 token：32 字节 → 64 hex；头行 = JSON 框架 + token + pid/uid（<<512 B 上限）。 */
#define TOKEN_HEX_MAX 65 /* 64 字符 + NUL */
#define HEADER_MAX 160
#define PUMP_BUFFER (16 * 1024)
/* 泵空闲上限（host 侧 §3.3(4) 空闲 30 s + 探针/派生裕量；绝不悬挂）。 */
#define PUMP_IDLE_CAP_MS 35000
/* accept 循环 poll 超时 = 父裔核验周期。 */
#define ACCEPT_POLL_MS 250

static const char *g_endpoint_path = NULL;

static void remove_endpoint(void)
{
    if (g_endpoint_path != NULL) {
        unlink(g_endpoint_path); /* ENOENT 静默；尽力而为 */
    }
}

/* async-signal-safe：unlink + _exit。 */
static void on_sigterm(int signal_number)
{
    (void)signal_number;
    remove_endpoint();
    _exit(0);
}

static void on_sigchld(int signal_number)
{
    (void)signal_number;
    while (waitpid(-1, NULL, WNOHANG) > 0) {
        /* 收割全部已终止的泵子进程（无僵尸）。 */
    }
}

static const char *arg_value(int argc, char **argv, const char *name)
{
    size_t name_len = strlen(name);
    for (int i = 1; i + 1 < argc; i += 1) {
        if (strncmp(argv[i], name, name_len) == 0 && argv[i][name_len] == '\0') {
            return argv[i + 1];
        }
    }
    return NULL;
}

/* 读取 0600 一次性 token 文件并立即 unlink；失败 → 非零 exit（fail-closed）。 */
static int read_token_file(const char *path, char *out_token_hex)
{
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return 65;
    }
    char buffer[TOKEN_HEX_MAX];
    ssize_t total = 0;
    while (total < (ssize_t)sizeof(buffer) - 1) {
        ssize_t n = read(fd, buffer + total, sizeof(buffer) - 1 - (size_t)total);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            close(fd);
            return 65;
        }
        if (n == 0) {
            break;
        }
        total += n;
    }
    close(fd);
    unlink(path); /* 一次性：读取即失效（窗口最小化）。 */
    while (total > 0 && (buffer[total - 1] == '\n' || buffer[total - 1] == '\r' ||
                         buffer[total - 1] == ' ' || buffer[total - 1] == '\t')) {
        total -= 1;
    }
    if (total != 64) {
        return 65;
    }
    buffer[total] = '\0';
    for (ssize_t i = 0; i < total; i += 1) {
        char c = buffer[i];
        int is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!is_hex) {
            return 65;
        }
    }
    memcpy(out_token_hex, buffer, (size_t)total + 1);
    return 0;
}

/*
 * 泵子进程：头行 + 双向透明转发。半关用 shutdown(SHUT_WR)（FIN 转发，绝不 RST 丢在途
 * 字节 —— 宿主半边 fake 套件钉住的同一纪律）；仅错误侧 close 双方。空闲 PUMP_IDLE_CAP_MS
 * 强断（恶意/僵死连接不可悬挂）。
 */
static void relay_connection(int client_fd, const char *ingress_path, const char *token_hex,
                             pid_t peer_pid, uid_t peer_uid)
{
    char header[HEADER_MAX];
    int header_len = snprintf(header, sizeof(header), "{\"v\":1,\"t\":\"%s\",\"pid\":%ld,\"uid\":%lu}\n",
                              token_hex, (long)peer_pid, (unsigned long)peer_uid);
    if (header_len <= 0 || (size_t)header_len >= sizeof(header)) {
        close(client_fd);
        _exit(70);
    }

    int ingress_fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (ingress_fd < 0) {
        close(client_fd);
        _exit(70);
    }
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(ingress_path) >= sizeof(address.sun_path)) {
        close(client_fd);
        close(ingress_fd);
        _exit(64);
    }
    strncpy(address.sun_path, ingress_path, sizeof(address.sun_path) - 1);
    while (connect(ingress_fd, (struct sockaddr *)&address, sizeof(address)) != 0) {
        if (errno != EINTR) {
            /* host 侧 ingress 不可达 = 无处可 relay；连接以关闭收尾（无状态）。 */
            close(client_fd);
            close(ingress_fd);
            _exit(0);
        }
    }

    /* 头行先行（顺序写：头行 → 之后才转发载荷字节）。 */
    size_t written = 0;
    while (written < (size_t)header_len) {
        ssize_t n = write(ingress_fd, header + written, (size_t)header_len - written);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            close(client_fd);
            close(ingress_fd);
            _exit(0);
        }
        written += (size_t)n;
    }

    char buffer[PUMP_BUFFER];
    int client_open = 1;  /* client → ingress 方向未终结 */
    int ingress_open = 1; /* ingress → client 方向未终结 */
    time_t last_activity = time(NULL);
    while (client_open || ingress_open) {
        struct pollfd fds[2];
        int count = 0;
        int client_index = -1;
        int ingress_index = -1;
        if (client_open) {
            client_index = count;
            fds[count].fd = client_fd;
            fds[count].events = POLLIN;
            if (ingress_open) {
                fds[count].events |= POLLOUT; /* 背压：client→ingress 可写才读 client */
            }
            count += 1;
        }
        if (ingress_open) {
            ingress_index = count;
            fds[count].fd = ingress_fd;
            fds[count].events = POLLIN;
            if (client_open) {
                fds[count].events |= POLLOUT;
            }
            count += 1;
        }
        int ready = poll(fds, (nfds_t)count, 1000);
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            break;
        }
        if (ready == 0) {
            if ((time(NULL) - last_activity) * 1000 > PUMP_IDLE_CAP_MS) {
                break; /* 空闲上限：强断（host 侧 §3.3(4) 的 helper 侧镜像）。 */
            }
            continue;
        }
        last_activity = time(NULL);
        /* client → ingress。 */
        if (client_index >= 0 && (fds[client_index].revents & (POLLIN | POLLHUP)) != 0) {
            ssize_t n = read(client_fd, buffer, sizeof(buffer));
            if (n <= 0) {
                client_open = 0;
                if (ingress_open) {
                    shutdown(ingress_fd, SHUT_WR); /* FIN 转发。 */
                }
            } else {
                size_t offset = 0;
                int failed = 0;
                while (offset < (size_t)n) {
                    ssize_t w = write(ingress_fd, buffer + offset, (size_t)n - offset);
                    if (w < 0) {
                        if (errno == EINTR) {
                            continue;
                        }
                        failed = 1;
                        break;
                    }
                    offset += (size_t)w;
                }
                if (failed) {
                    client_open = 0;
                    ingress_open = 0;
                }
            }
        }
        /* ingress → client。 */
        if (ingress_index >= 0 && (fds[ingress_index].revents & (POLLIN | POLLHUP)) != 0) {
            ssize_t n = read(ingress_fd, buffer, sizeof(buffer));
            if (n <= 0) {
                ingress_open = 0;
                if (client_open) {
                    shutdown(client_fd, SHUT_WR);
                }
            } else {
                size_t offset = 0;
                int failed = 0;
                while (offset < (size_t)n) {
                    ssize_t w = write(client_fd, buffer + offset, (size_t)n - offset);
                    if (w < 0) {
                        if (errno == EINTR) {
                            continue;
                        }
                        failed = 1;
                        break;
                    }
                    offset += (size_t)w;
                }
                if (failed) {
                    client_open = 0;
                    ingress_open = 0;
                }
            }
        }
        /* 错误终结（RST/复位）：两侧同亡，无在途承诺。 */
        if (client_index >= 0 && (fds[client_index].revents & (POLLERR | POLLNVAL)) != 0) {
            client_open = 0;
            ingress_open = 0;
        }
        if (ingress_index >= 0 && (fds[ingress_index].revents & (POLLERR | POLLNVAL)) != 0) {
            client_open = 0;
            ingress_open = 0;
        }
    }
    close(client_fd);
    close(ingress_fd);
    _exit(0);
}

int main(int argc, char **argv)
{
    const char *endpoint = arg_value(argc, argv, "--endpoint");
    const char *ingress = arg_value(argc, argv, "--ingress");
    const char *parent_pid_text = arg_value(argc, argv, "--parent-pid");
    const char *token_file = arg_value(argc, argv, "--token-file");
    if (endpoint == NULL || ingress == NULL || parent_pid_text == NULL || token_file == NULL) {
        return 64; /* 用法错误：fail-closed。 */
    }
    char *end = NULL;
    long parent_pid_value = strtol(parent_pid_text, &end, 10);
    if (end == parent_pid_text || *end != '\0' || parent_pid_value <= 0) {
        return 64;
    }
    pid_t expected_parent = (pid_t)parent_pid_value;

    char token_hex[TOKEN_HEX_MAX];
    int token_status = read_token_file(token_file, token_hex);
    if (token_status != 0) {
        return token_status;
    }

    /* 父裔纪律（ADR-13 D13.4）：argv 声明的父必须就是实际父 —— 偷来的二进制无法把
     * 伪父冒充给本 helper（真实端点路径对它不可达：0700 目录 + §3.4 + 本检查）。 */
    if (getppid() != expected_parent) {
        return 78;
    }

    g_endpoint_path = endpoint;

    signal(SIGPIPE, SIG_IGN); /* 泵以 EPIPE 收尾，不让 RST 杀进程。 */
    struct sigaction term_action;
    memset(&term_action, 0, sizeof(term_action));
    term_action.sa_handler = on_sigterm;
    sigemptyset(&term_action.sa_mask);
    sigaction(SIGTERM, &term_action, NULL);
    sigaction(SIGINT, &term_action, NULL);
    struct sigaction chld_action;
    memset(&chld_action, 0, sizeof(chld_action));
    chld_action.sa_handler = on_sigchld;
    chld_action.sa_flags = SA_NOCLDSTOP | SA_RESTART;
    sigemptyset(&chld_action.sa_mask);
    sigaction(SIGCHLD, &chld_action, NULL);

    /* §3.1(2) belt：目录 0700（host 已创建；chmod 钉死不受 umask 影响）。 */
    const char *endpoint_dir_end = strrchr(endpoint, '/');
    if (endpoint_dir_end != NULL) {
        char dir_buffer[4096];
        size_t dir_len = (size_t)(endpoint_dir_end - endpoint);
        if (dir_len == 0 || dir_len >= sizeof(dir_buffer)) {
            return 64;
        }
        memcpy(dir_buffer, endpoint, dir_len);
        dir_buffer[dir_len] = '\0';
        chmod(dir_buffer, 0700);
    }

    /* §3.4(1)：绑定前移除既有条目（stale socket / pre-plant），绝不静默采纳；不可移除
     * 的条目（如目录）→ 拒绝启动。 */
    struct stat existing;
    if (lstat(endpoint, &existing) == 0) {
        if (S_ISDIR(existing.st_mode)) {
            return 74; /* 端点被目录占据且不可移除：refuse 臂。 */
        }
        if (unlink(endpoint) != 0) {
            return 74;
        }
    }

    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) {
        return 70;
    }
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(endpoint) >= sizeof(address.sun_path)) {
        return 64;
    }
    strncpy(address.sun_path, endpoint, sizeof(address.sun_path) - 1);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0) {
        return 74;
    }
    if (chmod(endpoint, 0600) != 0) {
        remove_endpoint();
        return 74;
    }
    if (listen(listener, 64) != 0) {
        remove_endpoint();
        return 74;
    }

    for (;;) {
        struct pollfd fds[1];
        fds[0].fd = listener;
        fds[0].events = POLLIN;
        int ready = poll(fds, 1, ACCEPT_POLL_MS);
        if (ready < 0) {
            if (errno == EINTR) {
                continue;
            }
            remove_endpoint();
            return 70;
        }
        /* 周期性父裔核验：host 消亡（或被收养到 launchd）→ 摘端点退出（§3.1(3)/§10.3）。 */
        if (getppid() != expected_parent) {
            remove_endpoint();
            return 0;
        }
        if (ready == 0) {
            continue;
        }
        int client_fd = accept(listener, NULL, NULL);
        if (client_fd < 0) {
            continue; /* ECONNABORTED/EINTR 等：回到 poll。 */
        }
        /* §5.1(1)：accept 时读对等事实（内核事实源 —— getpeereid + LOCAL_PEERPID）。
         * 任一失败 = 无法建立身份 = 在 socket 处丢弃，绝不 relay（§5.3(4) 家族法则）。 */
        uid_t peer_uid = 0;
        gid_t peer_gid = 0;
        pid_t peer_pid = -1;
        socklen_t peer_pid_len = sizeof(peer_pid);
        if (getpeereid(client_fd, &peer_uid, &peer_gid) != 0 ||
            getsockopt(client_fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &peer_pid_len) != 0 ||
            peer_pid_len != sizeof(peer_pid)) {
            close(client_fd);
            continue;
        }
        (void)peer_gid; /* getpeereid 的必填 out 参数；gid 不是本协议的事实面。 */
        pid_t child = fork();
        if (child < 0) {
            close(client_fd);
            continue;
        }
        if (child == 0) {
            /* 泵子进程：不持有 listener（家族 fd 卫生），一连接一进程。 */
            close(listener);
            relay_connection(client_fd, ingress, token_hex, peer_pid, peer_uid);
            _exit(0); /* relay_connection 不返回；belt。 */
        }
        close(client_fd);
    }
}

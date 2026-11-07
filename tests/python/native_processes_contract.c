/* Controlled kernel responses: no actual process or permission queries. */
#define sysctl fixture_sysctl
#define getsid fixture_getsid
#define getuid fixture_getuid
#define kill fixture_kill
#include "../../scripts/native_processes.c"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static struct kinfo_proc first, second, population[2];
static int calls, fail_call, failure, absent_call, short_call, extra_call, session, session_errno;
static int table_error, table_count, table_extra;
static int presence, presence_errno, session_calls;
uid_t fixture_getuid(void) { return 501; }
pid_t fixture_getsid(pid_t pid) { assert(pid == 1234); ++session_calls; errno = session_errno; return session; }
int fixture_kill(pid_t pid, int number) { assert(pid == 1234 && number == 0); errno = presence_errno; return presence; }
int fixture_sysctl(int *mib, u_int length, void *output, size_t *size, void *input, size_t input_size) {
    assert(!input && !input_size);
    if (length == 3) {
        assert(mib[2] == KERN_PROC_ALL);
        if (table_error) { errno = table_error; return -1; }
        memcpy(output, population, table_count * sizeof(first));
        *size = table_count * sizeof(first) + table_extra;
        return 0;
    }
    assert(length == 4 && mib[2] == KERN_PROC_PID && mib[3] == 1234);
    ++calls;
    if (calls == fail_call) { errno = failure; return -1; }
    if (calls == absent_call) { *size = 0; return 0; }
    memcpy(output, calls == 1 ? &first : &second, sizeof(first));
    *size = sizeof(first) - (calls == short_call ? 1 : 0) + (calls == extra_call ? 1 : 0);
    return 0;
}
static void reset(void) {
    memset(&first, 0, sizeof(first));
    first.kp_proc.p_pid = 1234; first.kp_proc.p_stat = 2;
    first.kp_proc.p_starttime.tv_sec = 100; first.kp_proc.p_starttime.tv_usec = 500;
    first.kp_eproc.e_ucred.cr_uid = 501; first.kp_eproc.e_ppid = 1; first.kp_eproc.e_pgid = 1234;
    second = first; population[0] = first; population[1] = first;
    calls = fail_call = absent_call = short_call = extra_call = table_error = table_extra = session_errno = 0;
    failure = EPERM; session = 1234; table_count = 1;
    presence = -1; presence_errno = ESRCH;
    session_calls = 0;
}
int main(void) {
    struct md_process row, rows[MD_LIMIT]; size_t count; struct md_diagnostic detail;
    reset(); session = -1; session_errno = ESRCH; second.kp_proc.p_flag |= P_WEXIT;
    if (md_get(1234, &row, &detail) != 1) { fputs("identified exit transition falsely held as drift\n", stderr); return 1; }
    assert(row.session == -1 && (row.flags & P_WEXIT));
    assert(row.session_error == ESRCH);
    reset(); first.kp_proc.p_flag = second.kp_proc.p_flag = P_WEXIT;
    first.kp_eproc.e_pgid = second.kp_eproc.e_pgid = 0;
    assert(md_get(1234, &row, &detail) == 1 && session_calls == 0 && row.session_error == 0);
    reset(); first.kp_proc.p_flag = P_WEXIT;
    assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); session = -1; session_errno = EPERM; second.kp_proc.p_flag = P_WEXIT;
    assert(md_get(1234, &row, &detail) == -EPERM && calls == 1);
    reset(); first.kp_proc.p_stat = 5; first.kp_eproc.e_pgid = 0;
    if (md_get(1234, &row, &detail) != 0) { fputs("complete zombie with cleared group falsely held\n", stderr); return 1; }
    reset(); second.kp_proc.p_stat = 5; second.kp_eproc.e_pgid = 0; second.kp_eproc.e_ppid = 0;
    assert(md_get(1234, &row, &detail) == 0);
    reset(); second.kp_proc.p_stat = 5; second.kp_eproc.e_pgid = 0; session = -1; session_errno = ESRCH;
    assert(md_get(1234, &row, &detail) == 0);
    reset(); first.kp_proc.p_stat = 5; first.kp_eproc.e_ucred.cr_uid++;
    assert(md_get(1234, &row, &detail) == -EACCES);
    reset(); second.kp_proc.p_stat = 5; second.kp_proc.p_starttime.tv_sec++;
    assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); second.kp_proc.p_stat = 5; second.kp_eproc.e_ucred.cr_uid++;
    assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); first.kp_proc.p_stat = 5; first.kp_proc.p_starttime.tv_sec = 0;
    assert(md_get(1234, &row, &detail) == -EPROTO);
    reset(); assert(md_get(1234, &row, &detail) == 1 && row.seconds == 100 && row.session == 1234);
    reset(); absent_call = 1; assert(md_get(1234, &row, &detail) == 0);
    reset(); absent_call = 1; presence = 0; assert(md_get(1234, &row, &detail) == -EAGAIN);
    reset(); absent_call = 1; presence_errno = EPERM; assert(md_get(1234, &row, &detail) == -EPERM);
    reset(); absent_call = 2; assert(md_get(1234, &row, &detail) == 0);
    for (int call = 1; call <= 2; ++call) {
        reset(); fail_call = call; assert(md_get(1234, &row, &detail) == -EPERM);
        assert(detail.stage == (call == 1 ? 2 : 8) && detail.native_errno == EPERM && detail.syscall_result == -1 && detail.pid == 1234 && detail.input_capacity == sizeof(first));
        reset(); short_call = call; assert(md_get(1234, &row, &detail) == -EPROTO);
        assert(detail.reported_bytes == sizeof(first)-1 && detail.native_errno == 0 && detail.syscall_result == 0);
        reset(); extra_call = call; assert(md_get(1234, &row, &detail) == -EPROTO);
    }
    reset(); first.kp_proc.p_pid = 1235; assert(md_get(1234, &row, &detail) == -EPROTO);
    reset(); first.kp_proc.p_starttime.tv_usec = 1000000; assert(md_get(1234, &row, &detail) == -EPROTO);
    reset(); first.kp_proc.p_stat = 1; assert(md_get(1234, &row, &detail) == -EPROTO);
    reset(); first.kp_eproc.e_ucred.cr_uid = 502; assert(md_get(1234, &row, &detail) == -EACCES);
    reset(); second.kp_proc.p_starttime.tv_sec++; assert(md_get(1234, &row, &detail) == -ESTALE);
    assert(detail.stage == 12 && detail.pid == 1234 && detail.expected.seconds == 100 && detail.observed.seconds == 101 && (detail.fields & 7) == 7);
    reset(); second.kp_eproc.e_ucred.cr_uid++; assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); second.kp_eproc.e_pgid++; assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); second.kp_eproc.e_ppid++; assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); session = -1; session_errno = EPERM; assert(md_get(1234, &row, &detail) == -EPERM);
    assert(detail.stage == 9 && detail.session_result == -1 && detail.session_errno == EPERM && detail.native_errno == EPERM && calls == 1);
    reset(); session = -1; session_errno = ESRCH; assert(md_get(1234, &row, &detail) == -ESTALE);
    reset(); session = -1; session_errno = ESRCH; absent_call = 2; assert(md_get(1234, &row, &detail) == 0);
    reset(); assert(md_get(0, &row, &detail) == -EINVAL && calls == 0);
    reset(); assert(md_table(rows, MD_LIMIT, &count, &detail) == 0 && count == 1);
    reset(); table_error = EPERM; assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPERM);
    assert(detail.stage == 14 && detail.native_errno == EPERM && detail.syscall_result == -1 && detail.fields == 0);
    reset(); table_error = ENOMEM; assert(md_table(rows, MD_LIMIT, &count, &detail) == -ENOMEM);
    reset(); table_extra = 1; assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPROTO);
    reset(); table_count = 0; assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPROTO);
    reset(); table_extra = MD_LIMIT * sizeof(first); assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPROTO);
    reset(); table_count = 2; assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPROTO);
    reset(); fail_call = 1; assert(md_table(rows, MD_LIMIT, &count, &detail) == -EPERM);
    puts("native denied/partial/malformed/capacity/duplicate/session/birth contract controls passed");
    return 0;
}

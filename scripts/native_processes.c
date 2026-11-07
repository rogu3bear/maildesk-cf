/* Platform-bound build observer. No fallback, privilege or policy changes. */
#include <errno.h>
#include <stdint.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MD_LIMIT 16384
struct md_relationship {
    int64_t seconds, microseconds;
    int32_t pid, ppid, pgid;
    uint32_t uid, status, flags;
};
struct md_process {
    int64_t seconds, microseconds;
    int32_t pid, ppid, pgid, session;
    uint32_t uid, status, flags;
    int32_t session_error;
    struct md_relationship relationships[3];
    int32_t session_after, session_after_error;
    uint32_t relationship_transition;
};
struct md_diagnostic {
    uint32_t stage;
    int32_t code, syscall_result, native_errno, pid, session_result, signal_result;
    uint32_t fields; /* 1=expected, 2=observed, 4=session1, 8=presence, 16=session2, 32=B2, 64=B3 */
    int32_t session_errno, presence_errno;
    uint64_t reported_bytes, input_capacity;
    struct md_process expected, observed;
};
uint32_t md_version(void) { return 5; }
uint32_t md_exit_flag(void) { return P_WEXIT; }
size_t md_record_size(void) { return sizeof(struct md_process); }
size_t md_diagnostic_size(void) { return sizeof(struct md_diagnostic); }
size_t md_kernel_record_size(void) { return sizeof(struct kinfo_proc); }

static struct md_process snapshot(const struct kinfo_proc *r) {
    return (struct md_process){.seconds=r->kp_proc.p_starttime.tv_sec,
        .microseconds=r->kp_proc.p_starttime.tv_usec, .pid=r->kp_proc.p_pid,
        .ppid=r->kp_eproc.e_ppid, .pgid=r->kp_eproc.e_pgid,
        .uid=r->kp_eproc.e_ucred.cr_uid, .status=r->kp_proc.p_stat, .flags=r->kp_proc.p_flag};
}
static int fail(struct md_diagnostic *d, uint32_t stage, int code) {
    d->stage=stage; d->code=code; return code;
}
static struct md_relationship relationship(const struct kinfo_proc *r);
static int read_pid(int pid, struct kinfo_proc *row, struct md_diagnostic *d, uint32_t stage) {
    int mib[]={CTL_KERN,KERN_PROC,KERN_PROC_PID,pid};
    size_t size=sizeof(*row);
    d->pid=pid; d->input_capacity=size;
    if (pid<=0) return fail(d,1,-EINVAL);
    errno=0;
    int result=sysctl(mib,4,row,&size,NULL,0), error=errno;
    d->syscall_result=result; d->native_errno=error; d->reported_bytes=size;
    if (result<0) return fail(d,stage,-(error?error:EIO));
    if (size==0) {
        /* Iteration can omit an in-creation entry. Empty is not exit. */
        errno=0; result=kill(pid,0); error=errno;
        d->signal_result=result; d->fields|=8; d->presence_errno=error;
        if (result<0 && error==ESRCH) return 0;
        return fail(d,3,result<0?-(error?error:EIO):-EAGAIN);
    }
    if (size==sizeof(*row)) {
        if (stage==8 || stage==18) { d->observed=snapshot(row); d->fields|=2; }
        else { d->expected=snapshot(row); d->fields|=1; }
    }
    if (size==sizeof(*row) && (stage==8 || stage==18)) {
        d->expected.relationships[stage==8 ? 1 : 2]=relationship(row);
        d->fields|=stage==8 ? 32 : 64;
    }
    if (size!=sizeof(*row) || row->kp_proc.p_pid!=pid) return fail(d,stage,-EPROTO);
    return 1;
}
static int identity_valid(const struct kinfo_proc *r) {
    return r->kp_proc.p_pid>0 && r->kp_proc.p_stat>=2 && r->kp_proc.p_stat<=7 &&
        r->kp_proc.p_starttime.tv_sec>0 && r->kp_proc.p_starttime.tv_usec>=0 &&
        r->kp_proc.p_starttime.tv_usec<1000000;
}
static int relations_valid(const struct kinfo_proc *r) {
    return r->kp_eproc.e_ppid>=0 && r->kp_eproc.e_pgid>0;
}
static int same_identity(const struct kinfo_proc *a, const struct kinfo_proc *b) {
    return a->kp_proc.p_pid==b->kp_proc.p_pid &&
        a->kp_proc.p_starttime.tv_sec==b->kp_proc.p_starttime.tv_sec &&
        a->kp_proc.p_starttime.tv_usec==b->kp_proc.p_starttime.tv_usec &&
        a->kp_eproc.e_ucred.cr_uid==b->kp_eproc.e_ucred.cr_uid;
}
static struct md_relationship relationship(const struct kinfo_proc *r) {
    return (struct md_relationship){.seconds=r->kp_proc.p_starttime.tv_sec,
        .microseconds=r->kp_proc.p_starttime.tv_usec,.pid=r->kp_proc.p_pid,
        .ppid=r->kp_eproc.e_ppid,.pgid=r->kp_eproc.e_pgid,
        .uid=r->kp_eproc.e_ucred.cr_uid,.status=r->kp_proc.p_stat,.flags=r->kp_proc.p_flag};
}
static int project(const struct kinfo_proc *before, struct md_process *output, struct md_diagnostic *d) {
    struct kinfo_proc after={0}, final={0};
    d->expected=snapshot(before); d->fields|=1; d->pid=before->kp_proc.p_pid;
    d->expected.relationships[0]=relationship(before);
    if (!identity_valid(before)) return fail(d,5,-EPROTO);
    if (before->kp_eproc.e_ucred.cr_uid!=getuid()) return fail(d,6,-EACCES);
    /* A complete zombie has no executable writer; live-only fields can be gone. */
    if (before->kp_proc.p_stat==5) return 0;
    int session=-1, session_error=0;
    if (!(before->kp_proc.p_flag&P_WEXIT)) {
        errno=0; session=getsid(before->kp_proc.p_pid); session_error=errno;
        d->session_result=session; d->session_errno=session_error; d->fields|=4;
        d->expected.session=session; d->expected.session_error=session_error;
    }
    if ((d->fields&4) && session<0 && session_error!=ESRCH) {
        d->syscall_result=session; d->native_errno=session_error;
        d->reported_bytes=0; d->input_capacity=0;
        return fail(d,9,-(session_error?session_error:EIO));
    }
    int result=read_pid(before->kp_proc.p_pid,&after,d,8);
    if (result<=0) return result;
    if (!identity_valid(&after)) return fail(d,11,-EPROTO);
    if (!same_identity(before,&after)) return fail(d,12,-ESTALE);
    if (after.kp_proc.p_stat==5) return 0;
    if ((before->kp_proc.p_flag&P_WEXIT) && !(after.kp_proc.p_flag&P_WEXIT)) return fail(d,12,-ESTALE);
    if ((after.kp_proc.p_flag&P_WEXIT) && after.kp_eproc.e_ppid>=0 && after.kp_eproc.e_pgid>=0) {
        /* Identified, still live for containment. No live-only relationship claim. */
        *output=snapshot(&after); output->session=session; output->session_error=session_error;
        return 1;
    }
    if (!relations_valid(before)) return fail(d,7,-EPROTO);
    if (!relations_valid(&after)) return fail(d,11,-EPROTO);
    if (session<=0 || session_error) return fail(d,9,-(session_error?session_error:EPROTO));
    /* Two session samples are independently bracketed by immutable identities.
       Mutable relationship changes are evidence, never a stable edge or exit. */
    errno=0; int session_after=getsid(before->kp_proc.p_pid), error_after=errno;
    d->session_result=session_after; d->session_errno=error_after; d->fields|=16;
    d->expected.session_after=session_after; d->expected.session_after_error=error_after;
    if (session_after<0 && error_after!=ESRCH) {
        d->syscall_result=session_after; d->native_errno=error_after;
        d->reported_bytes=0; d->input_capacity=0;
        return fail(d,19,-(error_after?error_after:EIO));
    }
    result=read_pid(before->kp_proc.p_pid,&final,d,18);
    if (result<=0) return result;
    if (!identity_valid(&final)) return fail(d,11,-EPROTO);
    if (!same_identity(before,&final)) return fail(d,12,-ESTALE);
    if (final.kp_proc.p_stat==5) return 0;
    if ((final.kp_proc.p_flag&P_WEXIT) && final.kp_eproc.e_ppid>=0 && final.kp_eproc.e_pgid>=0) {
        *output=snapshot(&final); output->session=session_after; output->session_error=error_after;
        return 1;
    }
    if (!relations_valid(&final)) return fail(d,11,-EPROTO);
    if (session_after<=0 || error_after) return fail(d,19,-(error_after?error_after:EPROTO));
    *output=snapshot(&final); output->session=session; output->session_after=session_after;
    output->relationships[0]=relationship(before); output->relationships[1]=relationship(&after);
    output->relationships[2]=relationship(&final);
    output->relationship_transition=(session!=session_after ||
        before->kp_eproc.e_pgid!=after.kp_eproc.e_pgid || before->kp_eproc.e_ppid!=after.kp_eproc.e_ppid ||
        after.kp_eproc.e_pgid!=final.kp_eproc.e_pgid || after.kp_eproc.e_ppid!=final.kp_eproc.e_ppid);
    return 1;
}
int md_get(int pid, struct md_process *output, struct md_diagnostic *d) {
    *d=(struct md_diagnostic){0};
    struct kinfo_proc row={0};
    int result=read_pid(pid,&row,d,2);
    return result==1?project(&row,output,d):result;
}
int md_table(struct md_process *output, size_t capacity, size_t *count, struct md_diagnostic *d) {
    *d=(struct md_diagnostic){0};
    int mib[]={CTL_KERN,KERN_PROC,KERN_PROC_ALL};
    const size_t bound=(MD_LIMIT+1)*sizeof(struct kinfo_proc);
    if (capacity!=MD_LIMIT || !output || !count) return fail(d,1,-EINVAL);
    *count=0;
    struct kinfo_proc *rows=calloc(1,bound);
    if (!rows) return fail(d,13,-ENOMEM);
    size_t bytes=bound;
    errno=0;
    int result=sysctl(mib,3,rows,&bytes,NULL,0), error=errno;
    d->syscall_result=result; d->native_errno=error;
    d->reported_bytes=bytes; d->input_capacity=bound;
    if (result<0) { result=fail(d,14,-(error?error:EIO)); goto done; }
    if (!bytes || bytes>=bound || bytes%sizeof(*rows)) { result=fail(d,15,-EPROTO); goto done; }
    size_t length=bytes/sizeof(*rows);
    for (size_t i=0;i<length;++i) {
        *d=(struct md_diagnostic){.expected=snapshot(&rows[i]),.fields=1,.pid=rows[i].kp_proc.p_pid,
            .reported_bytes=sizeof(*rows),.input_capacity=sizeof(*rows)};
        if (rows[i].kp_proc.p_pid<0) { result=fail(d,16,-EPROTO); goto done; }
        for (size_t j=0;j<i;++j) {
            if (rows[i].kp_proc.p_pid==rows[j].kp_proc.p_pid) {
                d->observed=snapshot(&rows[j]); d->fields|=2;
                result=fail(d,17,-EPROTO); goto done;
            }
        }
        if (rows[i].kp_eproc.e_ucred.cr_uid!=getuid()) continue;
        result=project(&rows[i],&output[*count],d);
        if (result<0) goto done;
        if (result==1) ++*count;
    }
    result=0;
done:
    free(rows);
    return result;
}

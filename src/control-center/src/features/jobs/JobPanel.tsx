import { useCallback, useEffect, useRef, useState } from 'react';
import * as v from '../../../../shared/browser-validation.ts';
import { jobSchema } from '../../../../shared/browser-contracts.ts';
import type { Job } from '@openpet/contracts';
import { backendClient } from '../../api/backend-client.ts';
import { useSse } from '../../hooks/useSse.ts';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../../components/Card';
import { canRetryJob, shouldRefreshOnSseState } from './policy';
const jobListSchema = v.object({ items: v.array(jobSchema), total: v.number(), cursor: v.nullable(v.string()) });
function jobLabel(job: Job) {
    return job.input?.summary || job.kind;
}
function statusLabel(status: Job['status']) {
    return ({ queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', canceled: '已取消', interrupted: '已中断' } as Record<Job['status'], string>)[status];
}
export function JobPanel() {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [error, setError] = useState('');
    const [busyJobId, setBusyJobId] = useState('');
    const events = useSse(['jobs']);
    const previousSseState = useRef(events.state);
    const refresh = useCallback(async () => {
        try {
            const payload = await backendClient.request({ method: 'GET', path: '/jobs?limit=20', responseSchema: jobListSchema });
            setJobs(payload.items);
            setError('');
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : '任务服务不可用');
        }
    }, []);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => {
        const previous = previousSseState.current;
        previousSseState.current = events.state;
        if (shouldRefreshOnSseState(previous, events.state))
            void refresh();
    }, [events.state, refresh]);
    useEffect(() => { if (events.lastEventId)
        void refresh(); }, [events.lastEventId, refresh]);
    const cancel = async (jobId: string) => {
        setBusyJobId(jobId);
        try {
            await backendClient.request({ method: 'POST', path: `/jobs/${encodeURIComponent(jobId)}/cancel`, responseSchema: jobSchema, job: true, retry: false });
            await refresh();
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : '任务取消失败');
        }
        finally {
            setBusyJobId('');
        }
    };
    const retry = async (jobId: string) => {
        setBusyJobId(jobId);
        try {
            await backendClient.request({ method: 'POST', path: `/jobs/${encodeURIComponent(jobId)}/retry`, responseSchema: jobSchema, job: true, retry: false });
            await refresh();
        }
        catch (nextError) {
            setError(nextError instanceof Error ? nextError.message : '任务重试失败');
        }
        finally {
            setBusyJobId('');
        }
    };
    if (error && jobs.length === 0) {
        return <section className="job-panel" aria-label="任务面板"><span className="job-panel-muted">任务服务暂不可用</span></section>;
    }
    return (<Card className="job-panel" compact>
      <CardHeader title="任务" description={events.state === 'open' ? '实时进度' : '连接中'} actions={<Button variant="inline" onClick={() => void refresh()}>刷新</Button>}/>
      {jobs.length === 0 ? <span className="job-panel-muted">暂无任务</span> : (<div className="job-list">
          {jobs.map((job) => (<div className="job-row" key={job.jobId}>
              <div className="job-copy">
                <strong>{jobLabel(job)}</strong>
                <span>{statusLabel(job.status)} · {job.progress?.phase || '等待执行'}{job.progress ? ` · ${job.progress.percent}%` : ''}</span>
                {job.progress?.message ? <small>{job.progress.message}</small> : null}
              </div>
              <div className="job-actions">
                {(job.status === 'queued' || job.status === 'running') && job.cancelable ? <Button variant="ghost-danger" disabled={busyJobId === job.jobId} onClick={() => void cancel(job.jobId)}>取消</Button> : null}
                {canRetryJob(job) ? <Button variant="ghost-accent" disabled={busyJobId === job.jobId} onClick={() => void retry(job.jobId)}>重试</Button> : null}
              </div>
            </div>))}
        </div>)}
    </Card>);
}

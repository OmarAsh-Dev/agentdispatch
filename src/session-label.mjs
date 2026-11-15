export function sessionLabel(job){
  if(['planning','assignment','notification'].includes(job.mode))return `Kanzo ${job.project} · orchestrator (${job.agent})`;
  return `Kanzo ${job.taskId||job.project} · ${job.mode} · ${String(job.id).slice(0,8)}`;
}

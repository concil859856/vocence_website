"""Generation job system: queues, workers, per-pool load balancing.

Public surface (call from routers/handlers):
    from jobs import enqueue, get_job, cancel_job, list_jobs, JobError

Workers run inside FastAPI's lifespan (`runtime.start_workers` / `stop_workers`).
"""

from .api import enqueue, get_job, cancel_job, list_jobs, JobError, JobAdmissionRejected
from .runtime import start_workers, stop_workers

__all__ = [
    "enqueue",
    "get_job",
    "cancel_job",
    "list_jobs",
    "JobError",
    "JobAdmissionRejected",
    "start_workers",
    "stop_workers",
]

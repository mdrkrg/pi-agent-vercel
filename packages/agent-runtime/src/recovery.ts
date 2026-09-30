import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type AgentHarnessOptions,
	type DriveResult,
	type OpenOperation,
} from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import {
	DriveJobRepo,
	PostgresSessionRepo,
	SessionLeaseBusyError,
	SessionLeaseManager,
	type DriveJob,
	type SessionLease,
	type SessionLeaseOptions,
} from "@poc/pi-postgres";

export type RecoveryCoordinatorOptions<TContext extends object | undefined> = Omit<AgentHarnessOptions<TContext>, "session"> & {
	readonly repo: PostgresSessionRepo;
	readonly jobs: DriveJobRepo;
	readonly leases: SessionLeaseManager;
	readonly workerId: string;
	readonly context: Context;
	readonly lease?: SessionLeaseOptions;
	readonly sessionMetadata?: (sessionId: string, context: Context) => Promise<SessionMetadata | undefined>;
	readonly retryDelayMs?: number;
	readonly now?: () => number;
};

export type RecoveryPassResult = {
	readonly jobId: string;
	readonly operationId: string;
	readonly status: "completed" | "waiting" | "failed" | "released";
	readonly open: readonly OpenOperation[];
};

type ClaimedResources<TContext extends object | undefined> = {
	lease: SessionLease;
	session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>>;
	harness: AgentHarnessInstance<TContext>;
};

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function deferredAt(handle: unknown, now: number): number {
	if (handle !== null && typeof handle === "object" && "pollAfterMs" in handle && typeof handle.pollAfterMs === "number" && Number.isSafeInteger(handle.pollAfterMs)) {
		return now + Math.max(0, handle.pollAfterMs);
	}
	return now + 1_000;
}

/**
 * Claims short drive passes from Postgres and reconstructs Pi state in a new
 * process. The job table is only a recovery projection: open operations and
 * their outcomes still come from AgentHarness and the fenced Pi session.
 */
export class PostgresRecoveryCoordinator<TContext extends object | undefined = object | undefined> {
	private readonly retryDelayMs: number;
	private readonly now: () => number;

	constructor(private readonly options: RecoveryCoordinatorOptions<TContext>) {
		if (options.workerId.length === 0) throw new Error("Recovery workerId must not be empty");
		this.retryDelayMs = options.retryDelayMs ?? 1_000;
		if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs <= 0) throw new Error("Recovery retryDelayMs must be a positive safe integer");
		this.now = options.now ?? Date.now;
	}

	async run(limit = 1): Promise<RecoveryPassResult[]> {
		const claimed = await this.options.jobs.claimDue({ ownerId: this.options.workerId, limit, ...(this.options.lease?.ttlMs === undefined ? {} : { ttlMs: this.options.lease.ttlMs }) });
		const results: RecoveryPassResult[] = [];
		for (const job of claimed) results.push(await this.driveClaim(job));
		return results;
	}

	/**
	 * Rebuilds the queue from Pi's durable open-operation projection. This scan
	 * is safe to repeat: operation identity is unique in DriveJobRepo and the
	 * session lease prevents a discovery pass from racing a drive pass.
	 */
	async discover(sessionIds?: readonly string[]): Promise<DriveJob[]> {
		const sessions = sessionIds === undefined
			? await this.options.repo.list(undefined, this.options.context)
			: await Promise.all(sessionIds.map((id) => this.metadata(id)));
		const discovered: DriveJob[] = [];
		for (const metadata of sessions) {
			if (metadata === undefined) continue;
			let lease: SessionLease | undefined;
			let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
			let harness: AgentHarnessInstance<TContext> | undefined;
			try {
				try {
					lease = await this.options.leases.acquire(metadata.id, this.options.lease);
				} catch (error) {
					if (error instanceof SessionLeaseBusyError) continue;
					throw error;
				}
				session = await this.options.repo.openWithLease(metadata, lease, this.options.context);
				const { repo: _repo, jobs: _jobs, leases: _leases, workerId: _workerId, context: _context, lease: _lease, sessionMetadata: _sessionMetadata, retryDelayMs: _retryDelayMs, now: _now, ...harnessOptions } = this.options;
				const opened = await AgentHarness.create({ ...harnessOptions, session } as AgentHarnessOptions<TContext>, this.options.context);
				harness = opened.harness;
				for (const operation of opened.open) {
					discovered.push(await this.options.jobs.enqueue({ sessionId: metadata.id, lane: operation.lane, operationId: operation.operationId }));
				}
			} finally {
				if (harness !== undefined) await harness.close(this.options.context).catch(() => undefined);
				if (session !== undefined) await session.close(this.options.context).catch(() => undefined);
				if (lease !== undefined) await this.options.leases.release(lease).catch(() => undefined);
			}
		}
		return discovered;
	}

	private async metadata(sessionId: string): Promise<SessionMetadata | undefined> {
		if (this.options.sessionMetadata !== undefined) return this.options.sessionMetadata(sessionId, this.options.context);
		const sessions = await this.options.repo.list(undefined, this.options.context);
		return sessions.find((session) => session.id === sessionId);
	}

	private async driveClaim(job: DriveJob): Promise<RecoveryPassResult> {
		let settled = false;
		let lease: SessionLease | undefined;
		let session: Awaited<ReturnType<PostgresSessionRepo["openWithLease"]>> | undefined;
		let resources: ClaimedResources<TContext> | undefined;
		let open: readonly OpenOperation[] = [];
		try {
			const metadata = await this.metadata(job.sessionId);
			if (metadata === undefined) {
				await this.options.jobs.fail(job, this.options.workerId, `Unknown session: ${job.sessionId}`);
				settled = true;
				return { jobId: job.id, operationId: job.operationId, status: "failed", open };
			}
			try {
				lease = await this.options.leases.acquire(job.sessionId, this.options.lease);
			} catch (error) {
				if (!(error instanceof SessionLeaseBusyError)) throw error;
				await this.options.jobs.release(job, this.options.workerId, this.now() + this.retryDelayMs);
				settled = true;
				return { jobId: job.id, operationId: job.operationId, status: "released", open };
			}
			session = await this.options.repo.openWithLease(metadata, lease, this.options.context);
			const { repo: _repo, jobs: _jobs, leases: _leases, workerId: _workerId, context: _context, lease: _lease, sessionMetadata: _sessionMetadata, retryDelayMs: _retryDelayMs, now: _now, ...harnessOptions } = this.options;
			const harness = await AgentHarness.create({ ...harnessOptions, session } as AgentHarnessOptions<TContext>, this.options.context);
			resources = { lease, session, harness: harness.harness };
			open = harness.open;
			for (const discovered of open) {
				await this.options.jobs.enqueue({ sessionId: job.sessionId, lane: discovered.lane, operationId: discovered.operationId, ...(discovered.operationId === job.operationId && job.submissionId !== null ? { submissionId: job.submissionId } : {}) });
			}
			const target = open.find((operation) => operation.lane === job.lane && operation.operationId === job.operationId);
			if (target === undefined) {
				const lane = await resources.harness.lane(job.lane, this.options.context);
				const result = await lane.getResult(job.operationId, this.options.context);
				if (result !== undefined) {
					await this.options.jobs.complete(job, this.options.workerId);
					settled = true;
					return { jobId: job.id, operationId: job.operationId, status: "completed", open };
				}
				await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: this.now() + this.retryDelayMs });
				settled = true;
				return { jobId: job.id, operationId: job.operationId, status: "waiting", open };
			}
			const lane = await resources.harness.lane(target.lane, this.options.context);
			const driven = await lane.drive({ operationId: target.operationId, waitForRetry: false, pollDeferred: true }, this.options.context);
			const settledResult = await this.settleDrive(job, open, driven);
			settled = true;
			return settledResult;
		} catch (error) {
			if (!settled) {
				try {
					await this.options.jobs.fail(job, this.options.workerId, errorText(error));
					settled = true;
				} catch {
					// The claim may already have expired or been fenced. The next
					// worker can reclaim it from the durable expiry timestamp.
				}
			}
			return { jobId: job.id, operationId: job.operationId, status: "failed", open };
		} finally {
			if (resources !== undefined) {
				await resources.harness.close(this.options.context).catch(() => undefined);
				await resources.session.close(this.options.context).catch(() => undefined);
			} else if (session !== undefined) {
				await session.close(this.options.context).catch(() => undefined);
			}
			if (lease !== undefined) await this.options.leases.release(lease).catch(() => undefined);
			if (!settled) await this.options.jobs.release(job, this.options.workerId, this.now() + this.retryDelayMs).catch(() => undefined);
		}
	}

	private async settleDrive(job: DriveJob, open: readonly OpenOperation[], result: DriveResult): Promise<RecoveryPassResult> {
		if (!result.ok) {
			await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: this.now() + this.retryDelayMs });
			return { jobId: job.id, operationId: job.operationId, status: "waiting", open };
		}
		if (result.value.kind === "settled") {
			await this.options.jobs.complete(job, this.options.workerId);
			return { jobId: job.id, operationId: job.operationId, status: "completed", open };
		}
		if (result.value.reason === "retry") {
			await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: result.value.notBefore });
			return { jobId: job.id, operationId: job.operationId, status: "waiting", open };
		}
		await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: deferredAt(result.value.deferred, this.now()), deferredHandle: result.value.deferred });
		return { jobId: job.id, operationId: job.operationId, status: "waiting", open };
	}
}

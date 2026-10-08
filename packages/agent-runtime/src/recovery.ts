import { AgentHarness, type AgentHarnessOptions, type DriveResult, type OpenOperation } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { SessionMetadata } from "@earendil-works/pi-agent-core/harness/session";
import { DriveJobRepo, PostgresSessionRepo, SessionLeaseBusyError, SessionLeaseManager, type DriveJob, type SessionLeaseOptions } from "../../pi-postgres/src/index.ts";
import { withSessionOwnership } from "./ownership.ts";
import { annotateSpan, traceStage } from "./tracing.ts";

export type RecoveryCoordinatorOptions<TContext extends object | undefined> = Omit<AgentHarnessOptions<TContext>, "session"> & {
	readonly repo: PostgresSessionRepo;
	readonly jobs: DriveJobRepo;
	readonly leases: SessionLeaseManager;
	readonly workerId: string;
	readonly context: Context;
	readonly lease?: SessionLeaseOptions;
	readonly maxPassMs?: number;
	readonly harnessOptionsForJob?: (job: DriveJob, context: Context) => Promise<Omit<AgentHarnessOptions<TContext>, "session">>;
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

/** Scheduling is a projection; Pi owns open state and immutable terminal outcomes. */
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
		if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("Recovery limit must be positive");
		const results: RecoveryPassResult[] = [];
		// Claim only when ready to execute: claims cannot expire behind a slow pass.
		for (let index = 0; index < limit; index++) {
			this.options.context.abortSignal?.throwIfAborted();
			const [job] = await traceStage("job.claim", {}, () => this.options.jobs.claimDue({ ownerId: this.options.workerId, limit: 1, ttlMs: this.options.lease?.ttlMs ?? 90_000 }));
			if (job === undefined) break;
			results.push(await this.driveClaim(job));
		}
		return results;
	}

	async discover(sessionIds?: readonly string[]): Promise<DriveJob[]> {
		const sessions = await traceStage("worker.discover.list", {}, async (span) => {
			const listed = sessionIds === undefined ? await this.options.repo.list(undefined, this.options.context) : await Promise.all(sessionIds.map((id) => this.metadata(id)));
			annotateSpan(span, { "agent.discovery.session.count": listed.filter((item) => item !== undefined).length });
			return listed;
		});
		const discovered: DriveJob[] = [];
		for (const metadata of sessions) {
			if (metadata === undefined) continue;
			try {
				await traceStage("worker.discover.session", {}, () => withSessionOwnership(this.ownershipOptions(metadata.id), this.options.context, async (owned) => {
					const session = await traceStage("worker.discover.session.open", {}, () => this.options.repo.openWithLease(metadata, owned.lease, owned.context));
					owned.registerSession(session);
					const opened = await traceStage("worker.discover.harness.create", {}, (span) => AgentHarness.create({ ...this.baseHarnessOptions(), session }, owned.context).then((value) => {
						annotateSpan(span, { "agent.discovery.open.count": value.open.length });
						return value;
					}));
					owned.registerHarness(opened.harness);
					await traceStage("worker.discover.publish", {}, async () => {
						for (const operation of opened.open) {
							owned.assertActive();
							discovered.push(await this.options.jobs.enqueue({ sessionId: metadata.id, lane: operation.lane, operationId: operation.operationId }));
						}
					});
				}));
			} catch (error) { if (!(error instanceof SessionLeaseBusyError)) throw error; }
		}
		return discovered;
	}

	private ownershipOptions(sessionId: string) {
		return { sessionId, leases: this.options.leases, ...(this.options.lease === undefined ? {} : { lease: this.options.lease }), ...(this.options.maxPassMs === undefined ? {} : { maxDurationMs: this.options.maxPassMs }) };
	}
	private baseHarnessOptions(): Omit<AgentHarnessOptions<TContext>, "session"> {
		const { repo: _repo, jobs: _jobs, leases: _leases, workerId: _workerId, context: _context, lease: _lease, maxPassMs: _max, harnessOptionsForJob: _factory, sessionMetadata: _metadata, retryDelayMs: _retry, now: _now, ...options } = this.options;
		return options;
	}
	private async metadata(id: string): Promise<SessionMetadata | undefined> {
		if (this.options.sessionMetadata !== undefined) return this.options.sessionMetadata(id, this.options.context);
		return (await this.options.repo.list(undefined, this.options.context)).find((session) => session.id === id);
	}

	private async driveClaim(job: DriveJob): Promise<RecoveryPassResult> {
		return traceStage("job.pass", {
			"agent.job.id": job.id, "agent.operation.id": job.operationId,
			...(job.submissionId === null ? {} : { "agent.submission.id": job.submissionId }),
			"agent.job.attempt": job.attemptCount,
			// Lateness since eligibility, not a reconstructed first-claim timestamp.
			"agent.job.eligible_delay_ms": Math.max(0, this.now() - job.availableAt),
			"agent.job.age_ms": Math.max(0, this.now() - job.createdAt),
		}, async (span) => {
			const result = await this.driveOwnedClaim(job);
			annotateSpan(span, { "agent.job.status": result.status });
			return result;
		});
	}

	private async driveOwnedClaim(job: DriveJob): Promise<RecoveryPassResult> {
		let open: readonly OpenOperation[] = [];
		const result = (status: RecoveryPassResult["status"]): RecoveryPassResult => ({ jobId: job.id, operationId: job.operationId, status, open });
		try {
			const metadata = await traceStage("job.metadata", {}, () => this.metadata(job.sessionId));
			if (metadata === undefined) { await this.options.jobs.fail(job, this.options.workerId, "Unknown session: " + job.sessionId); return result("failed"); }
			return await withSessionOwnership({
				...this.ownershipOptions(job.sessionId),
				renewAdditional: () => this.options.jobs.renew(job, this.options.workerId, this.options.lease?.ttlMs ?? 90_000),
			}, this.options.context, async (owned) => {
				const session = await traceStage("job.session.open", {}, () => this.options.repo.openWithLease(metadata, owned.lease, owned.context));
				owned.registerSession(session);
				const options = await traceStage("job.authorize", {}, async () => this.options.harnessOptionsForJob === undefined ? this.baseHarnessOptions() : this.options.harnessOptionsForJob(job, owned.context));
				owned.assertActive();
				const opened = await traceStage("job.harness.create", {}, () => AgentHarness.create({ ...options, session }, owned.context));
				owned.registerHarness(opened.harness);
				open = opened.open;
				for (const operation of open) await this.options.jobs.enqueue({ sessionId: job.sessionId, lane: operation.lane, operationId: operation.operationId });
				const lane = await opened.harness.lane(job.lane, owned.context);
				const terminal = await traceStage("job.result.read", {}, () => lane.getResult(job.operationId, owned.context));
				if (terminal !== undefined) { await this.options.jobs.complete(job, this.options.workerId); return result("completed"); }
				owned.assertActive();
				const driven = await traceStage("job.drive", {}, (span) => lane.drive({ operationId: job.operationId, waitForRetry: false, pollDeferred: true }, owned.context).then((result) => {
					annotateSpan(span, { "agent.drive.outcome": !result.ok ? "error" : result.value.kind === "settled" ? "settled" : result.value.reason });
					return result;
				}));
				owned.assertActive();
				return traceStage("job.settle", {}, () => this.settleDrive(job, open, driven));
			});
		} catch (error) {
			try {
				if (error instanceof SessionLeaseBusyError) { await traceStage("job.release", {}, () => this.options.jobs.release(job, this.options.workerId, this.now() + this.retryDelayMs)); return result("released"); }
				await traceStage("job.reschedule", {}, () => this.options.jobs.reschedule(job, this.options.workerId, { availableAt: this.now() + this.retryDelayMs, error: error instanceof Error ? error.name + ": " + error.message : String(error) }));
				return result("waiting");
			} catch {
				// Fenced or unavailable queue: durable claim expiry permits takeover.
				return result("failed");
			}
		}
	}

	private async settleDrive(job: DriveJob, open: readonly OpenOperation[], result: DriveResult): Promise<RecoveryPassResult> {
		let status: RecoveryPassResult["status"] = "waiting";
		if (!result.ok) await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: this.now() + this.retryDelayMs, error: result.error.message });
		else if (result.value.kind === "settled") { await this.options.jobs.complete(job, this.options.workerId); status = "completed"; }
		else if (result.value.reason === "retry") await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: result.value.notBefore });
		else {
			const handle = result.value.deferred;
			const delay = Number.isSafeInteger(handle.pollAfterMs) ? Math.max(0, handle.pollAfterMs!) : 1_000;
			await this.options.jobs.reschedule(job, this.options.workerId, { availableAt: this.now() + delay, deferredHandle: handle });
		}
		return { jobId: job.id, operationId: job.operationId, status, open };
	}
}

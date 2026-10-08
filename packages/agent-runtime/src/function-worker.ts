import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import type { AgentHarnessOptions } from "@earendil-works/pi-agent-core";
import { withAbortSignal, type Context } from "@earendil-works/pi-agent-core/harness/context";
import { DriveJobRepo, PostgresSessionRepo, SessionLeaseManager, SubmissionRepo, type SessionLeaseOptions } from "../../pi-postgres/src/index.ts";
import { PostgresAdmission, type SubmissionHarnessFactory } from "./admission.ts";
import { PostgresRecoveryCoordinator } from "./recovery.ts";
import { PostgresSubmissionReader } from "./submission-reader.ts";
import { DEFAULT_INVOCATION_MS, DEFAULT_PASS_MS } from "./execution-budgets.ts";
import { annotateSpan, traceStage } from "./tracing.ts";

export type FunctionWorkerOptions<TContext extends object | undefined> = {
	readonly repo: PostgresSessionRepo;
	readonly submissions: SubmissionRepo;
	readonly leases: SessionLeaseManager;
	readonly jobs: DriveJobRepo;
	readonly discovery: Pick<AgentHarnessOptions<TContext>, "models" | "model">;
	readonly harnessOptions: SubmissionHarnessFactory<TContext>;
	readonly lease?: SessionLeaseOptions;
	readonly maxPassMs?: number;
	readonly maxInvocationMs?: number;
	readonly scanLimit?: number;
};
type WorkerPhase = "worker.admission.recover" | "worker.discover" | "worker.run" | "worker.reconcile";

/** Call from cron or a local poller. The invocation carries no operation or principal state. */
export class PostgresFunctionWorker<TContext extends object | undefined = object | undefined> {
	constructor(private readonly options: FunctionWorkerOptions<TContext>) {}

	async tick(context: Context) {
		return traceStage("worker.tick", {}, (span) => this.driveTick(context, span));
	}

	private async driveTick(context: Context, span: Span) {
		const controller = new AbortController();
		const budget = this.options.maxInvocationMs ?? DEFAULT_INVOCATION_MS;
		if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Function invocation budget must be positive");
		annotateSpan(span, { "agent.invocation.budget_ms": budget, "agent.pass.budget_ms": this.options.maxPassMs ?? DEFAULT_PASS_MS });
		const signal = context.abortSignal === undefined ? controller.signal : AbortSignal.any([context.abortSignal, controller.signal]);
		const tickContext = withAbortSignal(signal, context);
		let phase: WorkerPhase = "worker.admission.recover";
		const stage = <T>(name: WorkerPhase, run: () => Promise<T>) => {
			phase = name;
			annotateSpan(span, { "agent.worker.phase": name });
			return traceStage(name, {}, run);
		};
		const timer = setTimeout(() => {
			const deadlinePhase = phase;
			// Signal effect gates before doing any telemetry work.
			controller.abort(new Error("Function invocation budget exhausted"));
			annotateSpan(span, { "agent.invocation.exhausted": true, "agent.worker.deadline_phase": deadlinePhase });
		}, budget);
		try {
			const admission = new PostgresAdmission({ repo: this.options.repo, submissions: this.options.submissions, leases: this.options.leases, harnessOptions: this.options.harnessOptions, ...(this.options.lease === undefined ? {} : { lease: this.options.lease }) });
			const pending = await stage("worker.admission.recover", () => admission.recoverPending(tickContext, this.options.scanLimit ?? 100));
			annotateSpan(span, { "agent.admission.processed.count": pending.length, "agent.admission.error.count": pending.filter((item) => item.error !== undefined).length });
			const coordinator = new PostgresRecoveryCoordinator({
				...this.options.discovery, repo: this.options.repo, jobs: this.options.jobs, leases: this.options.leases,
				workerId: randomUUID(), context: tickContext, maxPassMs: this.options.maxPassMs ?? DEFAULT_PASS_MS,
				...(this.options.lease === undefined ? {} : { lease: this.options.lease }),
				harnessOptionsForJob: async (job, ownedContext) => {
					const submission = job.submissionId === null ? await this.options.submissions.findOperation(job.sessionId, job.lane, job.operationId) : await this.options.submissions.get(job.submissionId);
					if (submission === undefined || submission.sessionId !== job.sessionId || submission.lane !== job.lane || submission.operationId !== job.operationId) throw new Error("Drive job has no matching authorized submission");
					return this.options.harnessOptions(submission, ownedContext);
				},
			});
			const discovered = await stage("worker.discover", () => coordinator.discover());
			annotateSpan(span, { "agent.discovered.count": discovered.length });
			const driven = await stage("worker.run", () => coordinator.run(1));
			annotateSpan(span, { "agent.driven.count": driven.length });
			tickContext.abortSignal?.throwIfAborted();
			const projections = await stage("worker.reconcile", () => new PostgresSubmissionReader(this.options.repo, this.options.submissions).reconcilePending(this.options.scanLimit ?? 100, tickContext));
			annotateSpan(span, { "agent.reconcile.processed.count": projections.length, "agent.reconcile.error.count": projections.filter((item) => item.error !== undefined).length, "agent.worker.phase": "complete" });
			return { pending, discovered: discovered.length, driven, projections };
		} finally { clearTimeout(timer); }
	}
}

import { describe, expect, it } from 'vitest';
import { JobDatabase } from '../../../src/jobs/database.js';
import { type ReviewResult, findingFingerprint } from '../../../src/review/result.js';

const baseJob = {
  action: 'opened',
  deliveryId: 'delivery-1',
  headSha: 'a'.repeat(40),
  installationId: 42,
  policyVersion: 'v1',
  pullRequestNumber: 7,
  repository: 'example/project',
};

describe('JobDatabase', () => {
  it('deduplicates both webhook deliveries and review job identities', () => {
    const database = new JobDatabase(':memory:');

    expect(database.enqueuePullRequest(baseJob)).toEqual({
      deliveryAccepted: true,
      jobCreated: true,
      jobsSuperseded: 0,
    });
    expect(database.enqueuePullRequest(baseJob)).toEqual({
      deliveryAccepted: false,
      jobCreated: false,
      jobsSuperseded: 0,
    });
    expect(
      database.enqueuePullRequest({
        ...baseJob,
        deliveryId: 'delivery-2',
      }),
    ).toEqual({ deliveryAccepted: true, jobCreated: false, jobsSuperseded: 0 });
    expect(database.countJobs()).toBe(1);

    const job = database.claimNextJob();
    expect(job?.checkRunId).toBeUndefined();
    if (job === undefined) {
      throw new Error('expected a queued job');
    }
    database.updateJob({
      checkRunId: 1234,
      id: job.id,
      state: 'CHECKING_OUT',
    });
    expect(database.activatePullRequestJob(job)).toEqual({
      currentHeadSha: baseJob.headSha,
      currentJobId: job.id,
      statusCommentId: undefined,
    });
    expect(
      database.attachStatusComment({
        commentId: 5678,
        jobId: job.id,
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
      }),
    ).toBe(true);
    expect(
      database.isCurrentPullRequestJob({
        jobId: job.id,
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
      }),
    ).toBe(true);

    database.updateJob({
      id: job.id,
      publishedReviewId: 9012,
      resultPath: '/tmp/previous-review.json',
      state: 'DONE',
    });
    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-3',
      headSha: 'b'.repeat(40),
    });
    const nextJob = database.claimNextJob();
    expect(nextJob).toBeDefined();
    if (nextJob === undefined) {
      throw new Error('expected a second queued job');
    }
    expect(database.findPreviousCompletedReview(nextJob)).toEqual({
      headSha: baseJob.headSha,
      resultPaths: ['/tmp/previous-review.json'],
    });

    database.close();
  });

  it('coalesces queued heads and claims only the latest head for a pull request', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    expect(
      database.enqueuePullRequest({
        ...baseJob,
        deliveryId: 'delivery-2',
        headSha: 'b'.repeat(40),
      }),
    ).toMatchObject({ jobCreated: true, jobsSuperseded: 1 });
    expect(
      database.enqueuePullRequest({
        ...baseJob,
        deliveryId: 'delivery-3',
        headSha: 'c'.repeat(40),
      }),
    ).toMatchObject({ jobCreated: true, jobsSuperseded: 1 });

    expect(database.claimNextJob()?.headSha).toBe('c'.repeat(40));
    expect(database.claimNextJob()).toBeUndefined();
    expect(database.countJobs()).toBe(3);
    database.close();
  });

  it('cancels queued work once per lifecycle delivery and can revive the same head', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const cancellation = {
      action: 'converted_to_draft' as const,
      deliveryId: 'delivery-2',
      headSha: baseJob.headSha,
      installationId: baseJob.installationId,
      pullRequestNumber: baseJob.pullRequestNumber,
      repository: baseJob.repository,
    };

    expect(database.cancelPullRequest(cancellation)).toEqual({
      deliveryAccepted: true,
      jobsCancelled: 1,
    });
    expect(database.cancelPullRequest(cancellation)).toEqual({
      deliveryAccepted: false,
      jobsCancelled: 0,
    });
    expect(database.claimNextJob()).toBeUndefined();

    expect(
      database.enqueuePullRequest({
        ...baseJob,
        action: 'ready_for_review',
        deliveryId: 'delivery-3',
      }),
    ).toMatchObject({ jobCreated: true });
    expect(database.claimNextJob()?.headSha).toBe(baseJob.headSha);
    database.close();
  });

  it('rejects stale cancellation finalization after cancel then revive', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const claimed = database.claimNextJob();
    if (claimed === undefined) {
      throw new Error('expected a claimed job');
    }

    expect(
      database.cancelPullRequest({
        action: 'converted_to_draft',
        deliveryId: 'delivery-cancel',
        headSha: baseJob.headSha,
        installationId: baseJob.installationId,
        pullRequestNumber: baseJob.pullRequestNumber,
        repository: baseJob.repository,
      }),
    ).toMatchObject({ jobsCancelled: 1 });
    expect(
      database.enqueuePullRequest({
        ...baseJob,
        action: 'ready_for_review',
        deliveryId: 'delivery-revive',
      }),
    ).toMatchObject({ jobCreated: true });

    expect(
      database.updateJob({
        attempt: claimed.attempt ?? 0,
        id: claimed.id,
        state: 'CANCELLED',
      }),
    ).toBe(false);
    const revived = database.claimNextJob();
    expect(revived).toBeDefined();
    expect(revived?.id).toBe(claimed.id);
    expect(revived?.state).toBe('CHECKING_OUT');
    database.close();
  });

  it('requeues active jobs with a new attempt for graceful shutdown', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const claimed = database.claimNextJob();
    if (claimed === undefined) {
      throw new Error('expected a claimed job');
    }

    expect(database.requeueActiveJobs()).toBe(1);
    const retried = database.claimNextJob();
    expect(retried).toMatchObject({ id: claimed.id, state: 'CHECKING_OUT' });
    expect(retried?.attempt).toBeGreaterThan(claimed.attempt ?? 0);
    expect(
      database.updateJob({ attempt: claimed.attempt ?? 0, id: claimed.id, state: 'DONE' }),
    ).toBe(false);
    database.close();
  });

  it('retains a publication identity when a job is retried', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const job = database.claimNextJob();
    if (job === undefined) {
      throw new Error('expected a queued job');
    }
    database.updateJob({
      id: job.id,
      publishedReviewId: 99,
      resultPath: '/tmp/result.json',
      state: 'QUEUED',
    });

    expect(database.claimNextJob()).toMatchObject({
      publishedReviewId: 99,
      resultPath: '/tmp/result.json',
    });
    database.close();
  });

  it('tracks explicit finding lifecycle updates without inferring fixed from absence', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const job = database.claimNextJob();
    if (job === undefined) {
      throw new Error('expected a queued job');
    }
    const finding: ReviewResult['findings'][number] = {
      confidence: 'high',
      evidence: 'The condition is inverted.',
      explanation: 'A non-owner is allowed.',
      file: 'src/access.ts',
      line: 12,
      severity: 'high',
      suggested_action: 'Invert the condition.',
      title: 'Authorization comparison is inverted',
    };
    const fingerprint = findingFingerprint(finding);
    const emptyResult: ReviewResult = {
      findings: [],
      limitations: [],
      summary: 'No new findings.',
      tests_run: [],
    };

    database.reconcileFindings({
      job,
      previousResult: { ...emptyResult, findings: [finding] },
      result: {
        ...emptyResult,
        finding_updates: [
          { evidence: 'Still inverted at the moved line.', fingerprint, status: 'still_present' },
        ],
      },
    });
    expect(database.getReviewFindings(baseJob.repository, baseJob.pullRequestNumber)).toEqual([
      expect.objectContaining({ fingerprint, state: 'STILL_PRESENT' }),
    ]);

    database.reconcileFindings({
      job,
      previousResult: undefined,
      result: {
        ...emptyResult,
        finding_updates: [
          { evidence: 'The condition is now correct.', fingerprint, status: 'fixed' },
          { evidence: 'unknown', fingerprint: '0'.repeat(16), status: 'fixed' },
        ],
      },
    });
    expect(database.getReviewFindings(baseJob.repository, baseJob.pullRequestNumber)).toEqual([
      expect.objectContaining({
        evidence: 'The condition is now correct.',
        fingerprint,
        state: 'FIXED',
      }),
    ]);

    database.reconcileFindings({ job, previousResult: undefined, result: emptyResult });
    expect(
      database.getReviewFindings(baseJob.repository, baseJob.pullRequestNumber)[0]?.state,
    ).toBe('FIXED');
    database.close();
  });

  it('associates published findings with GitHub threads and resolves explicit fixes', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const publicationJob = database.claimNextJob();
    if (publicationJob === undefined) {
      throw new Error('expected a publication job');
    }
    const fingerprint = '1234567890abcdef';
    database.queueGitHubThreadAssociation({
      expectedFingerprints: [fingerprint],
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: 101,
    });
    expect(database.nextPendingGitHubThreadAssociation()).toMatchObject({
      attempt: 0,
      expectedFingerprints: new Set([fingerprint]),
      installationId: publicationJob.installationId,
      jobId: publicationJob.id,
      reviewDatabaseId: 101,
    });
    expect(
      database.getFindingThreadStatuses(baseJob.repository, baseJob.pullRequestNumber),
    ).toEqual([{ fingerprint, resolutionState: 'RESOLUTION_PENDING' }]);
    database.recordGitHubThreadAssociation({
      commentNodeId: 'PRRC_comment',
      fingerprint,
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: '101',
      threadNodeId: 'PRRT_thread',
    });
    expect(database.remainingGitHubThreadAssociationFingerprints(publicationJob.id)).toEqual([]);
    database.completeGitHubThreadAssociation(publicationJob.id);
    expect(database.nextPendingGitHubThreadAssociation()).toBeUndefined();

    database.updateJob({ id: publicationJob.id, state: 'DONE' });
    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-resolution',
      headSha: 'b'.repeat(40),
    });
    const resolutionJob = database.claimNextJob();
    if (resolutionJob === undefined) {
      throw new Error('expected a resolution job');
    }
    database.updateJob({ id: resolutionJob.id, state: 'PUBLISHING' });
    expect(
      database.completeReviewJob({
        attempt: resolutionJob.attempt ?? 0,
        headSha: resolutionJob.headSha,
        jobId: resolutionJob.id,
        pullRequestNumber: resolutionJob.pullRequestNumber,
        repository: resolutionJob.repository,
        updates: [
          { evidence: 'The inverted comparison is now corrected.', fingerprint, status: 'fixed' },
          { evidence: 'No matching thread.', fingerprint: '0'.repeat(16), status: 'fixed' },
          { evidence: 'Still present.', fingerprint, status: 'still_present' },
        ],
      }),
    ).toEqual({ completed: true, queuedThreadCount: 1 });
    const pending = database.nextPendingThreadResolution();
    expect(pending).toMatchObject({
      attempt: 0,
      evidence: 'The inverted comparison is now corrected.',
      fingerprint,
      headSha: resolutionJob.headSha,
      installationId: resolutionJob.installationId,
      jobId: resolutionJob.id,
      threadNodeId: 'PRRT_thread',
    });
    if (pending === undefined) {
      throw new Error('expected a pending thread resolution');
    }

    database.failThreadResolution({
      error: 'temporary terminal failure',
      id: pending.id,
      jobId: pending.jobId,
      retryDelayMilliseconds: 0,
    });
    expect(database.nextPendingThreadResolution()).toMatchObject({
      attempt: 1,
      id: pending.id,
    });
    database.markThreadResolved({
      id: pending.id,
      jobId: pending.jobId,
      resolutionCommentNodeId: 'PRRC_resolution',
      resolvedAt: '2026-08-23T00:00:00.000Z',
    });
    expect(database.nextPendingThreadResolution()).toBeUndefined();
    expect(
      database.getFindingThreadStatuses(baseJob.repository, baseJob.pullRequestNumber),
    ).toEqual([
      {
        fingerprint,
        resolutionState: 'RESOLVED',
        resolvedAt: '2026-08-23T00:00:00.000Z',
        resolvedHeadSha: resolutionJob.headSha,
        threadNodeId: 'PRRT_thread',
      },
    ]);
    database.close();
  });

  it('reconciles a fixed finding when its GitHub thread is associated later', () => {
    const database = new JobDatabase(':memory:');
    const finding: ReviewResult['findings'][number] = {
      confidence: 'high',
      evidence: 'The comparison is inverted.',
      explanation: 'The authorization check allows the wrong user.',
      file: 'src/access.ts',
      line: 12,
      severity: 'high',
      suggested_action: 'Invert the comparison.',
      title: 'Authorization comparison is inverted',
    };
    const fingerprint = findingFingerprint(finding);
    const emptyResult: ReviewResult = {
      findings: [],
      limitations: [],
      summary: 'No new findings.',
      tests_run: [],
    };
    database.enqueuePullRequest(baseJob);
    const publicationJob = database.claimNextJob();
    if (publicationJob === undefined) {
      throw new Error('expected a publication job');
    }
    database.reconcileFindings({
      job: publicationJob,
      previousResult: undefined,
      result: { ...emptyResult, findings: [finding] },
    });
    database.updateJob({ id: publicationJob.id, state: 'DONE' });

    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-fixed-before-association',
      headSha: 'b'.repeat(40),
    });
    const resolutionJob = database.claimNextJob();
    if (resolutionJob === undefined) {
      throw new Error('expected a resolution job');
    }
    const fixedResult: ReviewResult = {
      ...emptyResult,
      finding_updates: [
        { evidence: 'The comparison now requires the same user.', fingerprint, status: 'fixed' },
      ],
    };
    database.reconcileFindings({
      job: resolutionJob,
      previousResult: { ...emptyResult, findings: [finding] },
      result: fixedResult,
    });
    database.recordReviewArtifact(resolutionJob.id, fixedResult);
    database.updateJob({ id: resolutionJob.id, state: 'PUBLISHING' });
    expect(
      database.completeReviewJob({
        attempt: resolutionJob.attempt ?? 0,
        headSha: resolutionJob.headSha,
        jobId: resolutionJob.id,
        pullRequestNumber: resolutionJob.pullRequestNumber,
        repository: resolutionJob.repository,
        updates: fixedResult.finding_updates ?? [],
      }),
    ).toEqual({ completed: true, queuedThreadCount: 0 });

    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-failed-before-association',
      headSha: 'c'.repeat(40),
    });
    const failedJob = database.claimNextJob();
    if (failedJob === undefined) {
      throw new Error('expected a failed resolution job');
    }
    const failedResult: ReviewResult = {
      ...emptyResult,
      finding_updates: [{ evidence: 'Unverified newer evidence.', fingerprint, status: 'fixed' }],
    };
    database.recordReviewArtifact(failedJob.id, failedResult);
    database.reconcileFindings({
      job: failedJob,
      previousResult: fixedResult,
      result: failedResult,
    });
    database.updateJob({ id: failedJob.id, state: 'FAILED' });

    database.recordGitHubThreadAssociation({
      commentNodeId: 'PRRC_late',
      fingerprint,
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: '101',
      threadNodeId: 'PRRT_late',
    });
    expect(database.nextPendingThreadResolution()).toMatchObject({
      evidence: 'The comparison now requires the same user.',
      headSha: resolutionJob.headSha,
      jobId: resolutionJob.id,
      threadNodeId: 'PRRT_late',
    });
    database.close();
  });

  it('does not apply an older fix to a newly published recurrence', () => {
    const database = new JobDatabase(':memory:');
    const finding: ReviewResult['findings'][number] = {
      confidence: 'high',
      evidence: 'The comparison is inverted.',
      explanation: 'The condition accepts the wrong user.',
      file: 'src/auth.ts',
      line: 7,
      severity: 'high',
      suggested_action: 'Require the same user.',
      title: 'Authorization comparison is inverted',
    };
    const fingerprint = findingFingerprint(finding);
    const emptyResult: ReviewResult = {
      findings: [],
      limitations: [],
      summary: 'No new findings.',
      tests_run: [],
    };
    database.enqueuePullRequest(baseJob);
    const originalJob = database.claimNextJob();
    if (originalJob === undefined) {
      throw new Error('expected an original publication job');
    }
    database.recordReviewArtifact(originalJob.id, { ...emptyResult, findings: [finding] });
    database.updateJob({ id: originalJob.id, state: 'DONE' });

    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-original-fix',
      headSha: 'b'.repeat(40),
    });
    const fixedJob = database.claimNextJob();
    if (fixedJob === undefined) {
      throw new Error('expected an original fix job');
    }
    const fixedResult: ReviewResult = {
      ...emptyResult,
      finding_updates: [{ evidence: 'Fixed at b.', fingerprint, status: 'fixed' }],
    };
    database.recordReviewArtifact(fixedJob.id, fixedResult);
    database.updateJob({ id: fixedJob.id, state: 'PUBLISHING' });
    database.completeReviewJob({
      attempt: fixedJob.attempt ?? 0,
      headSha: fixedJob.headSha,
      jobId: fixedJob.id,
      pullRequestNumber: fixedJob.pullRequestNumber,
      repository: fixedJob.repository,
      updates: fixedResult.finding_updates ?? [],
    });

    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-recurrence',
      headSha: 'c'.repeat(40),
    });
    const recurrenceJob = database.claimNextJob();
    if (recurrenceJob === undefined) {
      throw new Error('expected a recurrence publication job');
    }
    database.recordReviewArtifact(recurrenceJob.id, { ...emptyResult, findings: [finding] });
    database.updateJob({ id: recurrenceJob.id, state: 'DONE' });
    database.recordGitHubThreadAssociation({
      commentNodeId: 'PRRC_recurrence',
      fingerprint,
      jobId: recurrenceJob.id,
      pullRequestNumber: recurrenceJob.pullRequestNumber,
      repository: recurrenceJob.repository,
      reviewDatabaseId: '102',
      threadNodeId: 'PRRT_recurrence',
    });

    expect(database.nextPendingThreadResolution()).toBeUndefined();
    expect(
      database.getFindingThreadStatuses(baseJob.repository, baseJob.pullRequestNumber),
    ).toEqual([
      {
        fingerprint,
        resolutionState: 'OPEN',
        threadNodeId: 'PRRT_recurrence',
      },
    ]);

    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-recurrence-fix',
      headSha: 'd'.repeat(40),
    });
    const recurrenceFixJob = database.claimNextJob();
    if (recurrenceFixJob === undefined) {
      throw new Error('expected a recurrence fix job');
    }
    const recurrenceFixResult: ReviewResult = {
      ...emptyResult,
      finding_updates: [{ evidence: 'Fixed after recurrence.', fingerprint, status: 'fixed' }],
    };
    database.recordReviewArtifact(recurrenceFixJob.id, recurrenceFixResult);
    database.updateJob({ id: recurrenceFixJob.id, state: 'PUBLISHING' });
    expect(
      database.completeReviewJob({
        attempt: recurrenceFixJob.attempt ?? 0,
        headSha: recurrenceFixJob.headSha,
        jobId: recurrenceFixJob.id,
        pullRequestNumber: recurrenceFixJob.pullRequestNumber,
        repository: recurrenceFixJob.repository,
        updates: recurrenceFixResult.finding_updates ?? [],
      }),
    ).toEqual({ completed: true, queuedThreadCount: 1 });
    expect(database.nextPendingThreadResolution()).toMatchObject({
      evidence: 'Fixed after recurrence.',
      jobId: recurrenceFixJob.id,
      threadNodeId: 'PRRT_recurrence',
    });
    database.close();
  });

  it('completes a stale association intent when a recovered review has no inline comments', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(baseJob);
    const publicationJob = database.claimNextJob();
    if (publicationJob === undefined) {
      throw new Error('expected a publication job');
    }
    database.queueGitHubThreadAssociation({
      expectedFingerprints: ['1234567890abcdef'],
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: 101,
    });
    expect(database.nextPendingGitHubThreadAssociation()).toBeDefined();

    database.queueGitHubThreadAssociation({
      expectedFingerprints: [],
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: 101,
    });
    expect(database.nextPendingGitHubThreadAssociation()).toBeUndefined();
    database.close();
  });

  it('supersedes pending resolution work only after the newer fix job completes', () => {
    const database = new JobDatabase(':memory:');
    const fingerprint = '1234567890abcdef';
    database.enqueuePullRequest(baseJob);
    const publicationJob = database.claimNextJob();
    if (publicationJob === undefined) {
      throw new Error('expected a publication job');
    }
    database.recordGitHubThreadAssociation({
      commentNodeId: 'PRRC_comment',
      fingerprint,
      jobId: publicationJob.id,
      pullRequestNumber: publicationJob.pullRequestNumber,
      repository: publicationJob.repository,
      reviewDatabaseId: '101',
      threadNodeId: 'PRRT_thread',
    });
    database.updateJob({ id: publicationJob.id, state: 'DONE' });

    const queueFix = (deliveryId: string, headSha: string, evidence: string) => {
      database.enqueuePullRequest({ ...baseJob, deliveryId, headSha });
      const job = database.claimNextJob();
      if (job === undefined) {
        throw new Error('expected a resolution job');
      }
      database.updateJob({ id: job.id, state: 'PUBLISHING' });
      expect(
        database.completeReviewJob({
          attempt: job.attempt ?? 0,
          headSha,
          jobId: job.id,
          pullRequestNumber: job.pullRequestNumber,
          repository: job.repository,
          updates: [{ evidence, fingerprint, status: 'fixed' }],
        }),
      ).toEqual({ completed: true, queuedThreadCount: 1 });
      return job;
    };

    const olderJob = queueFix('delivery-older-fix', 'b'.repeat(40), 'Older fix evidence.');
    const olderPending = database.nextPendingThreadResolution();
    if (olderPending === undefined) {
      throw new Error('expected older pending resolution');
    }
    database.enqueuePullRequest({
      ...baseJob,
      deliveryId: 'delivery-failed-fix',
      headSha: 'c'.repeat(40),
    });
    const failedJob = database.claimNextJob();
    if (failedJob === undefined) {
      throw new Error('expected a failed resolution job');
    }
    database.updateJob({ id: failedJob.id, state: 'FAILED' });
    expect(database.nextPendingThreadResolution()).toMatchObject({
      evidence: 'Older fix evidence.',
      jobId: olderJob.id,
    });

    const newerJob = queueFix('delivery-newer-fix', 'd'.repeat(40), 'Newest fix evidence.');

    database.failThreadResolution({
      error: 'stale worker failure',
      id: olderPending.id,
      jobId: olderJob.id,
      retryDelayMilliseconds: 0,
    });
    expect(database.nextPendingThreadResolution()).toMatchObject({
      attempt: 0,
      evidence: 'Newest fix evidence.',
      headSha: newerJob.headSha,
      jobId: newerJob.id,
    });
    database.close();
  });

  it('deduplicates and audits manual commands', () => {
    const database = new JobDatabase(':memory:');
    const command = {
      actor: 'octocat',
      command: 'status' as const,
      commentId: 99,
      deliveryId: 'command-delivery-1',
      installationId: 42,
      pullRequestNumber: 7,
      repository: 'example/project',
    };

    expect(database.acceptManualCommand(command)).toBe(true);
    expect(database.acceptManualCommand(command)).toBe(false);
    database.completeManualCommand(command.deliveryId, 'FAILED', 'temporary error');
    expect(database.acceptManualCommand(command)).toBe(true);
    database.completeManualCommand(command.deliveryId, 'COMPLETED');
    database.close();
  });
});

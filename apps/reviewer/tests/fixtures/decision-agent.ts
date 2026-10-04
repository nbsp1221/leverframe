import type { Decision } from '@repo/contracts/decisions';
import type { AgentGateway, AgentOutcome, AnswerDelivery } from '../../src/decisions/ports.js';

/** No network, Codex, filesystem tools, or model calls. Only the infrastructure edge is scripted. */
export class ScriptedDecisionAgent implements AgentGateway {
  readonly deliveries = new Map<string, AnswerDelivery>();
  inspect(): Promise<'ready'> {
    return Promise.resolve('ready');
  }
  deliver(delivery: AnswerDelivery): Promise<void> {
    // A second call with the same id does not start another execution.
    this.deliveries.set(delivery.id, structuredClone(delivery));
    return Promise.resolve();
  }
  nextOutcome(item: Decision, now: number): AgentOutcome | undefined {
    const answer = item.answers.at(-1);
    if (!answer || now - Date.parse(item.updatedAt) < 2400) {
      return undefined;
    }
    const base = {
      decisionId: item.id,
      answerId: answer.id,
      taskRevision: item.context.taskRevision,
    };
    if (item.status === 'delivered' && answer.intent === 'research') {
      return {
        ...base,
        id: `${answer.id}:investigating`,
        kind: 'investigating',
        text: '요청한 내용을 조사하고 있습니다. 조사 요청을 정책 변경의 승인으로 취급하지 않습니다.',
      };
    }
    if (item.status === 'investigating') {
      return {
        ...base,
        id: `${answer.id}:research-result`,
        kind: 'needs_input',
        text:
          item.id === 'dr-101'
            ? '두 표시 방식을 비교했습니다. 정상 계좌의 금액과 추이는 어느 쪽이든 유지할 수 있습니다. 차이는 전체 합계를 미확정으로 표시할지, 합계 영역을 숨길지예요. 아직 표시 방식은 변경하지 않았습니다.'
            : item.id === 'dr-102'
              ? '요약 알림은 매일 오후 8시(한국 시간)에 발송하고, 그 이후 완료된 일은 다음 날 포함하는 범위입니다. 사용자 판단이 필요한 요청은 즉시 전달합니다. 이 범위로 진행할지 다시 확인해주세요. 아직 알림 정책은 변경하지 않았습니다.'
              : '추가 조사 요청을 받았습니다. 아직 새로운 근거를 확보하지 못해 기존 조건을 유지하고 있습니다. 이번 답변으로 작업 변경을 승인하지 않았습니다.',
      };
    }
    if (item.status === 'delivered') {
      // Free text may contain conditions; the preview never claims to interpret arbitrary prose.
      if (answer.text || !answer.optionId) {
        return {
          ...base,
          id: `${answer.id}:clarify`,
          kind: 'needs_input',
          text: '남겨주신 조건을 포함해 적용 범위를 다시 확인하겠습니다. 기존 선택지만으로 확정할 수 있다면 해당 선택지를 골라주세요. 추가 조건은 아직 구현에 반영하지 않았습니다.',
        };
      }
      const option = item.options.find((candidate) => candidate.id === answer.optionId);
      return {
        ...base,
        id: `${answer.id}:applied`,
        kind: 'applied',
        text: `선택한 범위로 작업을 이어갔습니다: ${option?.effect ?? answer.text}`,
      };
    }
    return undefined;
  }
}

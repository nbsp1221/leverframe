import type { Decision } from '@repo/contracts/decisions';

/** Synthetic projects and scenarios for previewing request lifecycle behavior. */
export function decisionFixtures(now = new Date().toISOString()): Decision[] {
  const create = (
    id: string,
    project: string,
    title: string,
    extra: Partial<Decision>,
  ): Decision => ({
    id,
    project,
    title,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    status: 'awaiting_answer',
    mode: 'blocking',
    goal: '',
    question: '',
    why: '',
    waitingFor: '',
    continuing: '',
    assumption: null,
    constraints: [],
    snoozedUntil: null,
    context: {
      agentId: 'codex',
      threadId: `preview-${id}`,
      taskId: `task-${id}`,
      taskRevision: '1',
    },
    facts: [],
    options: [],
    recommendation: '',
    answers: [],
    events: [
      {
        id: `${id}:opened`,
        kind: 'opened',
        at: now,
        text: '판단에 필요한 근거와 선택지를 정리했습니다.',
      },
    ],
    ...extra,
  });

  const portfolio = create('dr-101', 'Portfolio', '확인되지 않은 전체 합계의 표시 방식', {
    goal: '계좌별 오류를 분리하면서, 이미 볼 수 있던 자산 현황을 유지합니다.',
    question: '확인되지 않은 전체 합계는 어떻게 표시할까요?',
    why: '일부 계좌를 확인하지 못해 전체 합계를 확정할 수 없습니다. 합계에 미확정 표시를 할지, 확인 전까지 합계를 숨길지 판단이 필요합니다.',
    waitingFor: '합계 표시 변경',
    constraints: [
      '어느 쪽을 선택해도 정상 계좌의 금액·추이는 유지합니다. 거래 기록과 금액은 수정하지 않습니다.',
    ],
    continuing: '계좌별 오류 원인 조사와 독립적인 테스트 정리',
    facts: [
      {
        label: '현재 동작',
        detail: '정상 계좌의 금액과 추이는 표시됩니다. 한 계좌의 데이터는 추가 확인이 필요합니다.',
      },
      {
        label: '변경의 영향',
        detail: '두 선택지는 전체 합계 영역에만 영향을 줍니다. 정상 계좌의 정보는 모두 유지합니다.',
      },
      {
        label: '보존할 조건',
        detail: '이 작업에서 거래 기록과 금액을 보정하지 않습니다. 표시 방식만 결정합니다.',
      },
    ],
    options: [
      {
        id: 'preserve',
        label: '합계에 미확정 표시',
        effect: '정상 계좌의 금액·추이는 유지하고, 전체 합계는 미확정으로 구분합니다.',
        recommended: true,
      },
      {
        id: 'hide',
        label: '전체 합계를 숨김',
        effect: '계좌별 정보는 유지하되, 모든 계좌가 확인될 때까지 전체 합계 영역은 숨깁니다.',
        recommended: false,
      },
    ],
    recommendation:
      '기존에 확인하던 정보를 보존하면서도, 합계가 확정됐다는 오해를 줄일 수 있습니다.',
  });
  const assistant = create('dr-102', 'Assistant', '완료 알림을 받는 시간', {
    mode: 'nonblocking',
    goal: '개인 비서의 작업 결과를 자주 방해받지 않고 확인합니다.',
    question: '일반 완료 알림을 매일 저녁 8시에 모아서 받을까요?',
    why: '알림 빈도는 사용 습관에 따라 달라집니다. 어떤 결과를 언제 받을지 선호를 확인하고 있습니다.',
    waitingFor: '새 알림 주기 적용',
    constraints: [
      '모아서 받기를 선택하면 매일 오후 8시(한국 시간)에 일반 완료를 요약합니다. 사용자 판단이 필요한 요청은 즉시 알려드립니다.',
    ],
    continuing: '허용된 범위 안에서 알림 목록과 설정 화면 제작',
    assumption: '기존 알림 동작을 유지합니다. 새 발송 정책은 답변 전까지 활성화하지 않습니다.',
    facts: [
      {
        label: '진행 가능한 범위',
        detail: '알림 기록을 보여주는 화면은 발송 빈도와 독립적으로 만들 수 있습니다.',
      },
    ],
    options: [
      {
        id: 'digest',
        label: '매일 저녁 8시에 요약',
        effect: '하루 한 번 요약합니다. 오후 8시 이후 완료된 일은 다음 날 요약에 포함합니다.',
        recommended: true,
      },
      {
        id: 'each',
        label: '매번 바로 알림',
        effect: '작업이 끝날 때마다 즉시 확인할 수 있지만 알림이 더 자주 옵니다.',
        recommended: false,
      },
    ],
    recommendation:
      '판단이 필요한 요청과 단순 완료 소식을 나누면, 놓치지 않으면서 방해를 줄일 수 있습니다.',
  });
  const operations = create('dr-103', 'Operations', '백업 검증은 야간에 실행하도록 답변했어요', {
    status: 'delivery_failed',
    revision: 2,
    goal: '운영 작업과 겹치지 않는 시간에 백업 복원 검증을 수행합니다.',
    question: '백업 검증을 매일 새벽 3시에 진행할까요?',
    why: '검증 중에는 디스크 부하가 증가합니다.',
    waitingFor: '검증 일정 변경',
    continuing: '답변이 저장돼 있습니다. 연결이 복구되면 같은 답변으로 이어갈 수 있습니다.',
    options: [
      {
        id: 'night',
        label: '새벽 3시',
        effect: '주간 운영과 겹치는 일을 줄입니다.',
        recommended: true,
      },
    ],
    facts: [
      {
        label: '전달 상태',
        detail: '답변은 보관됐지만 대상 에이전트와 연결되지 않아 아직 적용되지 않았습니다.',
      },
    ],
    answers: [
      {
        id: 'seed-operations',
        intent: 'decide',
        optionId: 'night',
        text: '새벽 3시에 해줘.',
        expectedRevision: 0,
        at: now,
      },
    ],
    events: [
      { id: 'dr-103:0', kind: 'opened', at: now, text: '검증 일정을 확인했습니다.' },
      { id: 'dr-103:1', kind: 'answered', at: now, text: '새벽 3시에 해줘.' },
      { id: 'dr-103:2', kind: 'delivery_failed', at: now, text: '' },
    ],
  });
  const stale = create('dr-104', 'Leverframe', '리뷰 결과를 게시할 위치를 정해주세요', {
    status: 'superseded',
    revision: 1,
    goal: '리뷰 결과를 필요한 위치에 게시합니다.',
    question: '이번 리뷰 결과를 PR 댓글에 게시할까요?',
    why: '외부 게시에 대한 판단이 필요합니다.',
    waitingFor: '리뷰 게시',
    continuing: '',
    facts: [
      {
        label: '요청 이후의 변경',
        detail:
          '대상 PR에 새 커밋이 추가되어 이전 리뷰가 대체됐습니다. 이 요청의 답변은 적용하지 않습니다.',
      },
    ],
    events: [
      {
        id: 'dr-104:1',
        kind: 'superseded',
        at: now,
        text: '새 커밋에 대한 리뷰가 시작되어 이전 요청이 종료됐습니다.',
      },
    ],
  });
  const done = create('dr-105', 'Catalog', '검색 범위를 제목과 설명으로 확장했어요', {
    status: 'applied',
    revision: 3,
    goal: '기억나는 단어로 저장한 스킬을 찾기 쉽게 합니다.',
    question: '제목과 설명을 함께 검색할까요?',
    why: '검색 범위가 결과와 관련성에 영향을 줍니다.',
    waitingFor: '',
    continuing: '',
    answers: [
      {
        id: 'seed-catalog',
        intent: 'decide',
        text: '제목과 설명을 함께 검색해줘.',
        expectedRevision: 0,
        at: now,
      },
    ],
    events: [
      { id: 'dr-105:1', kind: 'answered', at: now, text: '제목과 설명을 함께 검색해줘.' },
      { id: 'dr-105:2', kind: 'delivered', at: now, text: '' },
      {
        id: 'dr-105:3',
        kind: 'applied',
        at: now,
        text: '검색 범위에 설명을 포함했습니다. 기존 제목 검색과 빈 검색어 동작은 유지했습니다.',
      },
    ],
  });
  return [portfolio, assistant, operations, stale, done];
}

import type { MovementPart, PartDecision, PartName, WearState } from './part';
import type { RepairStep, StepState, StepType } from './step';

/** 快照触发原因 */
export type SnapshotReason =
  | 'init'
  | 'step-add'
  | 'step-rollback'
  | 'step-reorder'
  | 'part-add'
  | 'part-remove'
  | 'part-decision';

export const SNAPSHOT_REASON_LABELS: Record<SnapshotReason, string> = {
  init: '初始建档',
  'step-add': '新增工序',
  'step-rollback': '工序回退',
  'step-reorder': '工序调序',
  'part-add': '登记零件',
  'part-remove': '移除零件',
  'part-decision': '零件决定变更',
};

/** 快照中的步骤序列项 */
export interface SnapshotStep {
  stepId: string;
  seq: number;
  stepType: StepType;
  state: StepState;
}

/** 快照中的零件处理结果 */
export interface SnapshotPart {
  partId: string;
  name: PartName;
  wearState: WearState;
  decision: PartDecision;
}

/**
 * 修复快照：把工序序列与零件决定绑成同一份版本化记录。
 * 走时测试保存时绑定快照版本；版本推进后旧测试立即失效。
 */
export interface RepairSnapshot {
  id: string;
  clockId: string;
  /** 每台钟表从 1 起单调递增 */
  version: number;
  reason: SnapshotReason;
  createdAt: number;
  /** 保存时的步骤序列（顺序号 + 状态） */
  steps: SnapshotStep[];
  /** 保存时的零件处理结果 */
  parts: SnapshotPart[];
}

/** 组装快照（步骤按 seq 排序）；id 幂等：snp_{clockId}_v{version}，并发重复生成时覆盖即可 */
export function buildSnapshot(
  clockId: string,
  version: number,
  reason: SnapshotReason,
  createdAt: number,
  steps: RepairStep[],
  parts: MovementPart[],
): RepairSnapshot {
  return {
    id: `snp_${clockId}_v${version}`,
    clockId,
    version,
    reason,
    createdAt,
    steps: steps
      .filter((s) => s.clockId === clockId)
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ stepId: s.id, seq: s.seq, stepType: s.stepType, state: s.state })),
    parts: parts
      .filter((p) => p.clockId === clockId)
      .map((p) => ({ partId: p.id, name: p.name, wearState: p.wearState, decision: p.decision })),
  };
}

/** 快照版本过期：提交携带的版本与当前版本不一致，提交被拒绝 */
export class SnapshotStaleError extends Error {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super(`快照版本已过期：提交绑定 v${expectedVersion}，当前已推进到 v${currentVersion}`);
    this.name = 'SnapshotStaleError';
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

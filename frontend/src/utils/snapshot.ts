import type { MovementPart } from '../types/part';
import type { RepairStep } from '../types/step';
import type { PartSnapshot, StepSnapshot, TimekeepingTest } from '../types/test';

/**
 * 快照工具：把「走时测试 — 工序序列 — 零件处理决定」绑成同一份快照。
 *
 * 核心机制：
 * 1. 保存走时测试时，把当前工序序列与零件处理结果拷贝成快照，
 *    并派生一个快照版本号（snapshotVersion）。
 * 2. 工序回退 / 顺序调整 / 完成，或零件决定变化后，
 *    快照版本与当前状态不一致 → 旧测试立即失效，台账重算钟表状态。
 * 3. 提交走时测试时做乐观并发校验：录入时记一版 baseVersion，
 *    提交时重读最新数据比对，过期则拒绝提交、保留读数。
 */

/** 简单稳定的字符串哈希（FNV-1a 32 位），仅用于版本比对，不需加密 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function sortedSteps(steps: RepairStep[]): RepairStep[] {
  return [...steps].sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
}

/** 取某钟表的工序（按 seq 升序） */
export function stepsOf(steps: RepairStep[], clockId: string): RepairStep[] {
  return sortedSteps(steps.filter((s) => s.clockId === clockId));
}

/** 取某钟表的零件 */
export function partsOf(parts: MovementPart[], clockId: string): MovementPart[] {
  return parts
    .filter((p) => p.clockId === clockId)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 由当前工序序列 + 零件处理结果派生快照版本号 */
export function computeSnapshotVersion(steps: RepairStep[], parts: MovementPart[]): string {
  const stepSig = steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((s) => `${s.id}:${s.seq}:${s.state}:${s.finishedAt ?? 0}:${[...s.partIds].sort().join('|')}`)
    .join(';');
  const partSig = parts
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `${p.id}:${p.wearState}:${p.decision}:${p.sourceLot}`)
    .join(';');
  return `v${fnv1a(`${stepSig}#${partSig}`)}`;
}

/** 生成工序序列快照（保存走时测试时调用） */
export function buildStepSnapshots(steps: RepairStep[]): StepSnapshot[] {
  return sortedSteps(steps).map((s) => ({
    id: s.id,
    stepType: s.stepType,
    seq: s.seq,
    state: s.state,
    finishedAt: s.finishedAt,
    partIds: [...s.partIds],
  }));
}

/** 生成零件处理结果快照（保存走时测试时调用） */
export function buildPartSnapshots(parts: MovementPart[]): PartSnapshot[] {
  return parts
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      wearState: p.wearState,
      decision: p.decision,
      sourceLot: p.sourceLot,
    }));
}

export type TestValidity =
  | { status: 'valid' }
  | { status: 'stale'; reasons: string[] }
  | { status: 'legacy' };

/**
 * 校验走时测试相对当前工序 / 零件状态的有效性。
 * - valid：快照版本与当前一致，可作为完成依据
 * - stale：有快照但已过期（工序回退 / 顺序调整 / 零件决定变化），列出失效原因
 * - legacy：无快照的旧版测试，只读、不计入完成状态
 */
export function evaluateTest(
  test: TimekeepingTest,
  currentSteps: RepairStep[],
  currentParts: MovementPart[],
): TestValidity {
  if (!test.snapshotVersion || !Array.isArray(test.steps) || !Array.isArray(test.parts)) {
    return { status: 'legacy' };
  }
  const reasons: string[] = [];

  const snapSteps = new Map(test.steps.map((s) => [s.id, s]));
  for (const cur of currentSteps) {
    const snap = snapSteps.get(cur.id);
    if (!snap) {
      reasons.push(`新增工序 #${cur.seq} ${cur.stepType}`);
      continue;
    }
    if (snap.seq !== cur.seq) reasons.push(`工序 #${snap.seq}「${cur.stepType}」顺序调整为 #${cur.seq}`);
    if (snap.state !== cur.state) {
      reasons.push(`工序「${cur.stepType}」状态由${snap.state === 'done' ? '完成' : '待办'}变为${cur.state === 'done' ? '完成' : '已回退'}`);
    }
    if ((snap.finishedAt ?? 0) !== (cur.finishedAt ?? 0) && snap.state === cur.state) {
      reasons.push(`工序「${cur.stepType}」完成时间变更`);
    }
  }
  for (const snap of test.steps) {
    if (!currentSteps.some((c) => c.id === snap.id)) reasons.push(`工序 #${snap.seq} ${snap.stepType} 已删除`);
  }

  const snapParts = new Map(test.parts.map((p) => [p.id, p]));
  for (const cur of currentParts) {
    const snap = snapParts.get(cur.id);
    if (!snap) {
      reasons.push(`新增零件「${cur.name}」`);
      continue;
    }
    if (snap.decision !== cur.decision) reasons.push(`零件「${cur.name}」处理决定改为「${cur.decision}」`);
    if (snap.wearState !== cur.wearState) reasons.push(`零件「${cur.name}」磨损状态变为「${cur.wearState}」`);
    if (snap.sourceLot !== cur.sourceLot) reasons.push(`零件「${cur.name}」来源批号变更`);
  }
  for (const snap of test.parts) {
    if (!currentParts.some((c) => c.id === snap.id)) reasons.push(`零件「${snap.name}」已删除`);
  }

  if (reasons.length === 0) return { status: 'valid' };
  return { status: 'stale', reasons: reasons.slice(0, 6) };
}

/** 测试是否可作为完成依据（仅 valid） */
export function isTestEffective(
  test: TimekeepingTest,
  currentSteps: RepairStep[],
  currentParts: MovementPart[],
): boolean {
  return evaluateTest(test, currentSteps, currentParts).status === 'valid';
}

export type RepairStateName = '未开工' | '维修中' | '待测试' | '已完成';

/**
 * 重算钟表修复状态（台账分栏依据）。
 * 只有「有效」的走时测试才把状态推到「已完成」；
 * 失效测试与无快照旧测试一律不计入，引导复测。
 */
export function repairStateOf(
  clockId: string,
  steps: RepairStep[],
  parts: MovementPart[],
  tests: TimekeepingTest[],
): RepairStateName {
  const cs = stepsOf(steps, clockId);
  const cp = partsOf(parts, clockId);
  const ct = tests.filter((t) => t.clockId === clockId);
  const done = cs.filter((s) => s.state === 'done').length;
  if (cs.length === 0) return '未开工';
  const hasValidTest = ct.some((t) => isTestEffective(t, cs, cp));
  if (done === cs.length && hasValidTest) return '已完成';
  if (done === cs.length) return '待测试';
  if (done > 0) return '维修中';
  return '未开工';
}

/** 版本号短格式（界面展示用） */
export function shortVersion(version?: string): string {
  if (!version) return '无快照';
  return version;
}

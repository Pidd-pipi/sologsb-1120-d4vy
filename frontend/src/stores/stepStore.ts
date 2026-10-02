import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import {
  buildPartSnapshots,
  buildStepSnapshots,
  computeSnapshotVersion,
} from '../utils/snapshot';
import type { MovementPart } from '../types/part';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';

/** 提交走时测试的结果：ok 为已落库；stale 为快照版本过期、读数保留 */
export type AddTestResult =
  | { ok: true; test: TimekeepingTest }
  | { ok: false; reason: 'stale'; currentVersion: string; baseVersion: string };

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
  },
  actions: {
    async load() {
      const steps = await db.steps.toArray();
      steps.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
      this.items = steps;
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      this.loaded = true;
    },
    async add(draft: RepairStepDraft) {
      const record: RepairStep = { ...toPlain(draft), id: newId('stp') };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      return record;
    },
    async finish(id: string) {
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    async rollback(id: string) {
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    /** 上下移动排序：交换两个相邻步骤的 seq */
    async swapSeq(aId: string, bId: string) {
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      const aSeq = a.seq;
      await db.steps.update(a.id, { seq: b.seq });
      await db.steps.update(b.id, { seq: aSeq });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return { ...it, seq: b.seq };
        if (it.id === b.id) return { ...it, seq: aSeq };
        return it;
      });
    },
    /**
     * 保存走时测试并绑定工序 / 零件快照。
     *
     * 乐观并发：baseVersion 是录入开始时的快照版本；提交时从 IndexedDB
     * 重读该钟表最新工序与零件数据派生 currentVersion。两者不一致
     * （另一标签页回退了工序、调了顺序或改了零件决定）则拒绝提交，
     * 调用方保留读数，提示版本过期。
     */
    async addTest(draft: TimekeepingTestDraft, baseVersion: string): Promise<AddTestResult> {
      const clockId = draft.clockId;
      // 直接读库，拿到其他标签页已落库的最新状态（Pinia 内存态不会跨标签页同步）
      const [freshSteps, freshParts] = await Promise.all([
        db.steps.where('clockId').equals(clockId).toArray(),
        db.parts.where('clockId').equals(clockId).toArray(),
      ]);
      const currentVersion = computeSnapshotVersion(freshSteps, freshParts);
      if (baseVersion !== currentVersion) {
        return { ok: false, reason: 'stale', currentVersion, baseVersion };
      }
      const record: TimekeepingTest = {
        ...toPlain(draft),
        id: newId('tst'),
        snapshotVersion: currentVersion,
        steps: buildStepSnapshots(freshSteps),
        parts: buildPartSnapshots(freshParts),
      };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      return { ok: true, test: record };
    },
    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
    },
  },
});

/** 从 IndexedDB 重读某钟表的最新工序与零件（供界面刷新快照状态） */
export async function loadClockSnapshotData(
  clockId: string,
): Promise<{ steps: RepairStep[]; parts: MovementPart[] }> {
  const [steps, parts] = await Promise.all([
    db.steps.where('clockId').equals(clockId).toArray(),
    db.parts.where('clockId').equals(clockId).toArray(),
  ]);
  return { steps, parts };
}

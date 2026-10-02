import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { broadcastSync } from '../utils/crossTab';
import { useSnapshotStore } from './snapshotStore';
import { SnapshotStaleError } from '../types/snapshot';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';

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
      // 步骤序列变化 → 新快照，旧测试失效
      await useSnapshotStore().capture(record.clockId, 'step-add');
      return record;
    },
    async finish(id: string) {
      // 完成属正常推进，不改变修复依据，不生成新快照
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      broadcastSync();
    },
    async rollback(id: string) {
      const step = this.items.find((it) => it.id === id);
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      // 回退改变修复依据 → 新快照，旧测试失效
      if (step) await useSnapshotStore().capture(step.clockId, 'step-rollback');
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
      // 顺序调整 → 新快照，旧测试失效
      await useSnapshotStore().capture(a.clockId, 'step-reorder');
    },
    /**
     * 保存走时测试：以快照版本为准做并发仲裁。
     * 事务内重读当前版本，与表单绑定版本不一致即拒绝（抛 SnapshotStaleError），
     * 调用方保留读数；两个标签页同时提交时版本就是唯一依据。
     */
    async addTest(draft: TimekeepingTestDraft, expectedVersion: number) {
      const record: TimekeepingTest = { ...toPlain(draft), id: newId('tst') };
      await db.transaction('rw', db.tests, db.snapshots, async () => {
        const rows = await db.snapshots.where('clockId').equals(record.clockId).toArray();
        const current = rows.reduce((max, s) => Math.max(max, s.version), 0);
        if (current === 0 || current !== expectedVersion) {
          throw new SnapshotStaleError(expectedVersion, current);
        }
        await db.tests.put(toPlain(record));
      });
      this.tests = [record, ...this.tests];
      broadcastSync();
      return record;
    },
    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
      broadcastSync();
    },
  },
});

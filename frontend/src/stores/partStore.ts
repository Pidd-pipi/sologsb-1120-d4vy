import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { broadcastSync } from '../utils/crossTab';
import { useSnapshotStore } from './snapshotStore';
import type { MovementPart, MovementPartDraft } from '../types/part';

interface PartState {
  items: MovementPart[];
  loaded: boolean;
}

export const usePartStore = defineStore('part', {
  state: (): PartState => ({ items: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) => state.items.filter((it) => it.clockId === clockId),
    pendingRepair: (state) => state.items.filter((it) => it.decision !== '保留' && it.wearState !== '完好'),
  },
  actions: {
    async load() {
      this.items = await db.parts.toArray();
      this.loaded = true;
    },
    async add(draft: MovementPartDraft) {
      const record: MovementPart = { ...toPlain(draft), id: newId('prt') };
      await db.parts.put(toPlain(record));
      this.items = [...this.items, record];
      // 零件处理结果变化 → 新快照，旧测试失效
      await useSnapshotStore().capture(record.clockId, 'part-add');
      return record;
    },
    async update(id: string, patch: Partial<MovementPart>) {
      const part = this.items.find((it) => it.id === id);
      const plain = toPlain(patch);
      await db.parts.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
      // 决定/磨损变化会改变零件处理结果 → 新快照，旧测试失效；其余字段仅广播
      if (part && ('decision' in plain || 'wearState' in plain)) {
        await useSnapshotStore().capture(part.clockId, 'part-decision');
      } else {
        broadcastSync();
      }
    },
    async remove(id: string) {
      const part = this.items.find((it) => it.id === id);
      await db.parts.delete(id);
      this.items = this.items.filter((it) => it.id !== id);
      if (part) await useSnapshotStore().capture(part.clockId, 'part-remove');
    },
  },
});

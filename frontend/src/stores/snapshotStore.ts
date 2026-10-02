import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { broadcastSync } from '../utils/crossTab';
import { buildSnapshot, type RepairSnapshot, type SnapshotReason } from '../types/snapshot';

interface SnapshotState {
  items: RepairSnapshot[];
  loaded: boolean;
}

export const useSnapshotStore = defineStore('snapshot', {
  state: (): SnapshotState => ({ items: [], loaded: false }),
  getters: {
    /** 某台钟表的快照列表，按版本倒序 */
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => b.version - a.version),
    /** 最新快照 */
    latestByClock: (state) => (clockId: string) => {
      let latest: RepairSnapshot | undefined;
      for (const it of state.items) {
        if (it.clockId === clockId && (!latest || it.version > latest.version)) latest = it;
      }
      return latest;
    },
    /** 当前快照版本（无快照为 0） */
    versionOf: (state) => (clockId: string) => {
      let version = 0;
      for (const it of state.items) {
        if (it.clockId === clockId && it.version > version) version = it.version;
      }
      return version;
    },
  },
  actions: {
    async load() {
      this.items = await db.snapshots.toArray();
      this.loaded = true;
    },
    /**
     * 生成新快照：版本 = 当前最新 + 1，记录此刻的步骤序列与零件处理结果。
     * 步骤回退/调序/增删、零件决定变化时调用；旧走时测试随即失效。
     * （完成步骤属正常推进，不改变修复依据，不生成新快照。）
     */
    async capture(clockId: string, reason: SnapshotReason) {
      if (!this.loaded) await this.load();
      const [steps, parts, existing] = await Promise.all([
        db.steps.where('clockId').equals(clockId).toArray(),
        db.parts.where('clockId').equals(clockId).toArray(),
        db.snapshots.where('clockId').equals(clockId).toArray(),
      ]);
      const version = existing.reduce((max, s) => Math.max(max, s.version), 0) + 1;
      const snapshot = buildSnapshot(clockId, version, reason, Date.now(), steps, parts);
      await db.snapshots.put(toPlain(snapshot));
      this.items = [...this.items.filter((it) => it.id !== snapshot.id), snapshot];
      broadcastSync();
      return snapshot;
    },
    /** 没有快照时补一份初始快照（老数据迁移兜底），有则返回最新 */
    async ensure(clockId: string) {
      if (!this.loaded) await this.load();
      const existing = await db.snapshots.where('clockId').equals(clockId).toArray();
      if (existing.length > 0) {
        // 其他标签页可能刚建过快照，合并进本地状态
        const known = new Set(this.items.map((it) => it.id));
        this.items = [...this.items, ...existing.filter((it) => !known.has(it.id))];
        return existing.reduce((a, b) => (b.version > a.version ? b : a));
      }
      return this.capture(clockId, 'init');
    },
  },
});

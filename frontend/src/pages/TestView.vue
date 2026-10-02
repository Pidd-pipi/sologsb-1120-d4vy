<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { usePartStore } from '../stores/partStore';
import { loadClockSnapshotData, useStepStore } from '../stores/stepStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { TEST_POSITIONS, judgeTest, type PositionReading } from '../types/test';
import { amplitudeLevel, avgAmplitude, avgBeatError, avgRate, beatErrorLevel, rateLabel, ratePerDayToMonth } from '../utils/timeCalc';
import { computeSnapshotVersion, evaluateTest, partsOf, stepsOf } from '../utils/snapshot';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const partStore = usePartStore();
const stepStore = useStepStore();

const clockId = ref(String(route.params.clockId ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));

/** 当前钟表的工序序列与零件处理结果（用于快照版本派生与有效性判定） */
const steps = computed(() => stepsOf(stepStore.items, clockId.value));
const parts = computed(() => partsOf(partStore.items, clockId.value));
const currentVersion = computed(() => computeSnapshotVersion(steps.value, parts.value));

/** 录入开始时记录的快照版本（乐观并发基准） */
const baseVersion = ref('');
/** 检测到工序 / 零件已在其他标签页变动 */
const versionStale = ref(false);
const saving = ref(false);

const readings = reactive<PositionReading[]>(
  TEST_POSITIONS.map((position) => ({ position, rate: 0, amplitude: 260, beatError: 0.4 })),
);
const powerReserve = ref(42);
const customConclusion = ref('');

const avg = computed(() => ({
  rate: avgRate(readings),
  amplitude: avgAmplitude(readings),
  beatError: avgBeatError(readings),
}));

const conclusion = computed(() =>
  customConclusion.value.trim() ? customConclusion.value.trim() : judgeTest(avg.value.rate, avg.value.beatError, avg.value.amplitude),
);

const workSheet = computed(() => {
  const lines: string[] = [];
  lines.push('走时测试单');
  lines.push(`藏品号：${clock.value?.clockNo ?? '未知'}（${clock.value?.kind ?? ''} / ${clock.value?.caliber ?? ''}）`);
  lines.push(`测试时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('方位\t日差(s/d)\t摆幅(°)\t偏振(ms)');
  readings.forEach((r) => {
    lines.push(`${r.position}\t${r.rate}\t${r.amplitude}\t${r.beatError}`);
  });
  lines.push('');
  lines.push(`平均日差：${avg.value.rate} s/d（约 ${ratePerDayToMonth(avg.value.rate)} s/月，${rateLabel(avg.value.rate)}）`);
  lines.push(`平均摆幅：${avg.value.amplitude} °（${amplitudeLevel(avg.value.amplitude).label}）`);
  lines.push(`平均偏振：${avg.value.beatError} ms（${beatErrorLevel(avg.value.beatError).label}）`);
  lines.push(`动力储备：${powerReserve.value} h`);
  lines.push(`结论：${conclusion.value}`);
  return lines.join('\n');
});

/** 历史测试逐条判定有效性 */
const testsWithValidity = computed(() =>
  tests.value.map((t) => ({ ...t, validity: evaluateTest(t, steps.value, parts.value) })),
);
const effectiveCount = computed(
  () => testsWithValidity.value.filter((t) => t.validity.status === 'valid').length,
);
const staleCount = computed(() => testsWithValidity.value.filter((t) => t.validity.status === 'stale').length);
const legacyCount = computed(() => testsWithValidity.value.filter((t) => t.validity.status === 'legacy').length);

/** 从 store 重算快照基准（本标签页内工序 / 零件变动后调用） */
function recalcBaseVersion() {
  baseVersion.value = computeSnapshotVersion(steps.value, parts.value);
}

/** 刷新快照状态：重载数据并重算基准，已填读数保留 */
async function refreshSnapshot() {
  await Promise.all([stepStore.load(), partStore.load()]);
  recalcBaseVersion();
  versionStale.value = false;
  ElMessage.success('已同步最新工序 / 零件状态，读数保留');
}

async function save() {
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  saving.value = true;
  try {
    const result = await stepStore.addTest(
      {
        clockId: clockId.value,
        testedAt: Date.now(),
        amplitude: avg.value.amplitude,
        beatError: avg.value.beatError,
        rate: avg.value.rate,
        positions: readings.map((r) => ({ ...r })),
        powerReserve: powerReserve.value,
        conclusion: conclusion.value,
      },
      baseVersion.value,
    );
    if (!result.ok) {
      // 乐观并发冲突：版本过期，拒绝提交，读数原样保留
      versionStale.value = true;
      ElMessage.error(`提交已拒绝：快照版本过期（${result.baseVersion} → ${result.currentVersion}），读数已保留`);
      return;
    }
    versionStale.value = false;
    ElMessage.success(`走时测试已记录，已绑定工序快照 ${result.test.snapshotVersion}`);
  } finally {
    saving.value = false;
  }
}

async function copySheet() {
  try {
    await navigator.clipboard.writeText(workSheet.value);
    ElMessage.success('走时单已复制');
  } catch {
    ElMessage.warning('浏览器未授权剪贴板，请手动复制');
  }
}

function downloadSheet() {
  const blob = new Blob([workSheet.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `走时单_${clock.value?.clockNo ?? 'clock'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('走时单已导出');
}

function reset() {
  readings.forEach((r) => {
    r.rate = 0;
    r.amplitude = 260;
    r.beatError = 0.4;
  });
  customConclusion.value = '';
}

/** 标签页重新可见时，检测其他标签页是否已改动工序 / 零件 */
async function onVisible() {
  if (document.visibilityState !== 'visible' || !clockId.value) return;
  const { steps: freshSteps, parts: freshParts } = await loadClockSnapshotData(clockId.value);
  const freshVersion = computeSnapshotVersion(freshSteps, freshParts);
  versionStale.value = freshVersion !== baseVersion.value;
}

onMounted(async () => {
  await Promise.all([clockStore.load(), partStore.load(), stepStore.load()]);
  if (!clock.value && clockStore.items.length > 0) {
    clockId.value = clockStore.items[0].id;
    await router.replace(`/tests/${clockId.value}`);
  }
  recalcBaseVersion();
  document.addEventListener('visibilitychange', onVisible);
});

onUnmounted(() => document.removeEventListener('visibilitychange', onVisible));
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>走时测试 · {{ clock?.clockNo ?? '未选择' }}</h2>
      <StateBadge :grade="clock?.conditionGrade" />
      <el-tag type="info" effect="plain">历史测试 {{ tests.length }} 次</el-tag>
      <el-tag v-if="effectiveCount" type="success" effect="plain">有效 {{ effectiveCount }}</el-tag>
      <el-tag v-if="staleCount" type="danger" effect="plain">已失效 {{ staleCount }}</el-tag>
      <el-tag v-if="legacyCount" type="warning" effect="plain">旧版只读 {{ legacyCount }}</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <el-alert
      v-if="versionStale"
      type="error"
      :closable="false"
      show-icon
      class="stale-alert"
      title="快照版本过期：检测到工序回退 / 顺序调整或零件处理决定已变化，本次提交将被拒绝"
      description="已填读数会原样保留。请先同步最新工序 / 零件状态，再重新提交复测。"
    >
      <div class="stale-actions">
        <el-button size="small" type="primary" @click="refreshSnapshot">刷新快照状态（读数保留）</el-button>
        <span class="muted">录入时版本 {{ baseVersion }} → 当前版本 {{ currentVersion }}</span>
      </div>
    </el-alert>

    <div class="grid">
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>多方位读数录入</strong>
            <el-tag size="small" type="info" effect="plain">
              绑定快照 {{ baseVersion || '—' }} · 工序 {{ steps.length }} 道 · 零件 {{ parts.length }} 项
            </el-tag>
          </div>
        </template>
        <el-table :data="readings" size="small" border>
          <el-table-column prop="position" label="方位" width="90" />
          <el-table-column label="日差 s/d" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.rate" :min="-99" :max="99" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="摆幅 °" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.amplitude" :min="0" :max="400" :step="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="偏振 ms" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.beatError" :min="0" :max="9.9" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="分级" min-width="140">
            <template #default="{ row }">
              <StateBadge :label="amplitudeLevel(row.amplitude).label" :tone="amplitudeLevel(row.amplitude).type" />
              <StateBadge :label="beatErrorLevel(row.beatError).label" :tone="beatErrorLevel(row.beatError).type" />
            </template>
          </el-table-column>
        </el-table>

        <el-form label-width="110px" style="margin-top: 14px">
          <el-form-item label="动力储备 h">
            <el-input-number v-model="powerReserve" :min="0" :max="400" />
          </el-form-item>
          <el-form-item label="结论（可选）">
            <el-input v-model="customConclusion" placeholder="留空则按均值自动判定" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="save">保存测试记录</el-button>
            <el-button @click="reset">重置读数</el-button>
            <el-button @click="refreshSnapshot">刷新快照状态</el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <div class="right">
        <el-card shadow="never">
          <template #header><strong>多方位均值</strong></template>
          <div class="stats">
            <div><span class="muted">平均日差</span><strong>{{ avg.rate }}</strong> s/d</div>
            <div><span class="muted">折算</span><strong>{{ ratePerDayToMonth(avg.rate) }}</strong> s/月</div>
            <div><span class="muted">平均摆幅</span><strong>{{ avg.amplitude }}</strong> °</div>
            <div><span class="muted">平均偏振</span><strong>{{ avg.beatError }}</strong> ms</div>
          </div>
          <el-alert
            :title="`判定结论：${conclusion}（${rateLabel(avg.rate)}）`"
            :type="conclusion === '合格' ? 'success' : conclusion === '不合格' ? 'error' : 'warning'"
            :closable="false"
            show-icon
          />
          <RateChart :readings="readings" />
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>走时单</strong>
              <div class="spacer" />
              <el-button size="small" @click="copySheet">复制</el-button>
              <el-button size="small" type="primary" @click="downloadSheet">导出</el-button>
            </div>
          </template>
          <el-input v-model="workSheet" type="textarea" :rows="12" readonly />
        </el-card>

        <el-card shadow="never">
          <template #header><strong>历史测试记录</strong></template>
          <el-alert
            v-if="legacyCount > 0"
            type="info"
            :closable="false"
            show-icon
            class="history-alert"
            :title="`${legacyCount} 条旧版走时单无快照，仅作只读参考，不计入完成状态`"
            description="请重新复测并保存，新测试会绑定工序序列与零件处理结果，生成可追溯的快照。"
          />
          <el-alert
            v-if="staleCount > 0"
            type="warning"
            :closable="false"
            show-icon
            class="history-alert"
            :title="`${staleCount} 条测试快照已过期（工序回退 / 顺序调整或零件决定变化），不计入完成状态`"
            description="请刷新快照状态后复测，以最新工序 / 零件结果重新判定。"
          />
          <el-table :data="testsWithValidity" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column prop="rate" label="日差" width="80" />
            <el-table-column prop="amplitude" label="摆幅" width="80" />
            <el-table-column prop="beatError" label="偏振" width="80" />
            <el-table-column prop="powerReserve" label="动储 h" width="90" />
            <el-table-column prop="conclusion" label="结论" min-width="110" />
            <el-table-column label="快照状态" min-width="180">
              <template #default="{ row }">
                <el-tag v-if="row.validity.status === 'valid'" size="small" type="success">
                  有效 {{ row.snapshotVersion }}
                </el-tag>
                <div v-else-if="row.validity.status === 'stale'">
                  <el-tag size="small" type="danger">已失效</el-tag>
                  <div v-for="(r, i) in row.validity.reasons" :key="i" class="reason">· {{ r }}</div>
                </div>
                <el-tag v-else size="small" type="info">旧版 · 只读</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="tests.length === 0" description="暂无历史测试，请复测生成可追溯结果" :image-size="60" />
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.stale-alert {
  margin: 0;
}
.stale-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 620px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.stats strong {
  font-size: 18px;
  margin: 0 4px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.history-alert {
  margin-bottom: 10px;
}
.reason {
  color: #b04a3a;
  font-size: 12px;
  line-height: 1.5;
}
</style>

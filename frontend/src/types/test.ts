/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

/** 单方位读数 */
export interface PositionReading {
  position: TestPosition;
  /** 日差 s/d */
  rate: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
}

/** 走时测试记录 */
export interface TimekeepingTest {
  id: string;
  clockId: string;
  testedAt: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
  /** 日差 s/d */
  rate: number;
  positions: PositionReading[];
  /** 动力储备 h */
  powerReserve: number;
  conclusion: string;
  /** 绑定的快照 id；旧记录无快照则为空，只读、不作完成依据 */
  snapshotId?: string;
  /** 绑定的快照版本 */
  snapshotVersion?: number;
  /** 复测来源测试 id（可追溯） */
  retestOf?: string;
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 测试是否有效：绑定的快照版本与当前版本一致；无快照的旧测试一律无效（只读） */
export function isTestValid(test: TimekeepingTest, currentVersion: number): boolean {
  return test.snapshotVersion !== undefined && currentVersion > 0 && test.snapshotVersion === currentVersion;
}

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}

/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

import type { PartDecision, PartName, WearState } from './part';
import type { StepState, StepType } from './step';

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

/**
 * 工序快照：走时测试保存时刻的一道工序序列。
 * 日后工序回退、顺序调整都会与该快照比对，判定测试是否失效。
 */
export interface StepSnapshot {
  id: string;
  stepType: StepType;
  seq: number;
  state: StepState;
  finishedAt?: number;
  partIds: string[];
}

/**
 * 零件处理结果快照：走时测试保存时刻的零件状态与处理决定。
 */
export interface PartSnapshot {
  id: string;
  name: PartName;
  wearState: WearState;
  decision: PartDecision;
  sourceLot: string;
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
  /**
   * 快照版本号：由测试保存时刻的工序序列 + 零件处理结果派生。
   * 提交时做乐观并发校验，与当前状态不一致则拒绝提交。
   * 缺省（旧版数据）表示无快照，记录只读、不计入完成状态。
   */
  snapshotVersion?: string;
  /** 测试保存时刻的工序序列快照（按 seq 升序） */
  steps?: StepSnapshot[];
  /** 测试保存时刻的零件处理结果快照 */
  parts?: PartSnapshot[];
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}

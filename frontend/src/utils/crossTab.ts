/**
 * 跨标签页数据同步：任一标签页写入 IndexedDB 后广播，
 * 其他标签页收到后重载本地 store，保证工序回退/调序/零件变更
 * 在另一页（如开着的走时单）立即体现。
 */
const CHANNEL_NAME = 'gbclockrepair:sync';

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

export function broadcastSync(): void {
  channel?.postMessage({ type: 'mutated', at: Date.now() });
}

export function onSync(handler: () => void): void {
  if (channel) channel.onmessage = handler;
}

export const danmakuColors = [
  { value: '#faf9f5', label: '纸白' },
  { value: '#efb49a', label: '陶橙' },
  { value: '#c3d5ae', label: '灰绿' },
  { value: '#a5cbed', label: '浅蓝' },
] as const;

export type DanmakuPreferences = {
  size: number;
  opacity: number;
  duration: number;
  area: 'top' | 'full';
  color: string;
};

export const defaultDanmaku: DanmakuPreferences = { size: 22, opacity: 1, duration: 8, area: 'top', color: '#faf9f5' };
export const danmakuStorageKey = 'zhima-danmaku';

export function parseDanmaku(value: unknown): DanmakuPreferences {
  if (!value || typeof value !== 'object') return { ...defaultDanmaku };
  const data = value as Record<string, unknown>;
  return {
    size: typeof data.size === 'number' && Number.isFinite(data.size) && data.size >= 16 && data.size <= 32 ? data.size : defaultDanmaku.size,
    opacity: typeof data.opacity === 'number' && Number.isFinite(data.opacity) && data.opacity >= .25 && data.opacity <= 1 ? data.opacity : defaultDanmaku.opacity,
    duration: typeof data.duration === 'number' && Number.isFinite(data.duration) && data.duration >= 5 && data.duration <= 14 ? data.duration : defaultDanmaku.duration,
    area: data.area === 'full' ? 'full' : 'top',
    color: danmakuColors.some(color => color.value === data.color) ? data.color as string : defaultDanmaku.color,
  };
}

export function loadDanmaku(): DanmakuPreferences {
  try {
    if (typeof localStorage === 'undefined') return { ...defaultDanmaku };
    return parseDanmaku(JSON.parse(localStorage.getItem(danmakuStorageKey) || 'null'));
  } catch { return { ...defaultDanmaku }; }
}

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 图标状态。状态点颜色见 STATE_COLORS;base 为纯鲸鱼 logo。
 */
export type TrayIconState = "base" | "green" | "blue" | "yellow" | "red";

export const STATE_COLORS: { [K in Exclude<TrayIconState, "base">]: readonly [number, number, number] } = {
  green: [34, 197, 94],
  blue: [59, 130, 246],
  yellow: [234, 179, 8],
  red: [239, 68, 68],
};

/** 状态点深色描边与 iconOutline 描边色。 */
const OUTLINE: readonly [number, number, number] = [17, 24, 39];

interface Pt { x: number; y: number; }

interface Parsed {
  svg: string;
  pathData: string;
  subs: Pt[][];
  viewBox: number;
}

let parsed: Parsed | null = null;
/** 测试注入用:绕过 require.resolve(在未安装 peer 时指向任意合法 svg)。 */
let overridePath: string | null = null;

export function __setOfficialSvgPath(p: string | null): void {
  overridePath = p;
  parsed = null;
}

/** 读取官方 favicon.svg 并解析(幂等缓存)。 */
export function loadOfficialSvg(): Parsed {
  if (parsed) return parsed;
  const file = overridePath ?? require.resolve("@deepseek-ai/dsh-web-frontend/dist/favicon.svg");
  const svg = readFileSync(file, "utf8");
  parsed = parseSvg(svg);
  return parsed;
}

function parseSvg(svg: string): Parsed {
  const d = /<path\b[^>]*\bd="([^"]*)"[^>]*\/?>/.exec(svg);
  if (!d) throw new Error("favicon.svg: 未找到 <path d>");
  const vb = /viewBox="\s*[\d.]+[\s,]+[\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(svg);
  const viewBox = vb ? Math.max(parseFloat(vb[1]!), parseFloat(vb[2]!)) : 50;
  return { svg, pathData: d[1]!, subs: parsePath(d[1]!), viewBox };
}

/**
 * 解析 path 数据:M(绝对 x y)、C(绝对 6 参数)、Z。
 * 三次贝塞尔按 16 步采样细分为折线;针对官方 favicon.svg 的单 path 结构实现。
 */
function parsePath(d: string): Pt[][] {
  const toks = d.match(/[MZC]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g);
  if (!toks) throw new Error("favicon path 解析失败");
  let i = 0;
  const n = (): number => { const t = parseFloat(toks[i]!); i += 1; return t; };
  let pen: Pt = { x: 0, y: 0 };
  const subs: Pt[][] = [];
  let cur: Pt[] | null = null;
  while (i < toks.length) {
    const c = toks[i]!;
    i += 1;
    if (c === "M") {
      pen = { x: n(), y: n() };
      cur = [{ ...pen }];
      subs.push(cur);
    } else if (c === "C") {
      if (!cur) throw new Error("favicon path: C 前无 M");
      const p1 = { x: n(), y: n() };
      const p2 = { x: n(), y: n() };
      const p3 = { x: n(), y: n() };
      const STEPS = 16;
      for (let s = 1; s <= STEPS; s += 1) {
        const t = s / STEPS;
        const u = 1 - t;
        cur.push({
          x: u ** 3 * pen.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
          y: u ** 3 * pen.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
        });
      }
      pen = p3;
    } else if (c === "Z") {
      if (cur) pen = { ...cur[0]! };
    } else {
      throw new Error("favicon path 含不支持的命令: " + c);
    }
  }
  if (!subs.length) throw new Error("favicon path 为空");
  return subs;
}

/** 射线法(奇偶规则)光栅化 + 2× 盒式超采样直出 size×size RGBA;fill 为 logo 填充色。 */
function rasterize(parsed: Parsed, size: number, fill: readonly [number, number, number]): Buffer {
  const SS = size * 2;
  const buf = Buffer.alloc(SS * SS * 4);
  const vb = parsed.viewBox;
  const edges: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const sub of parsed.subs) {
    for (let i = 0; i < sub.length; i += 1) {
      const a = sub[i]!;
      const b = sub[(i + 1) % sub.length]!;
      edges.push({ x1: a.x / vb, y1: a.y / vb, x2: b.x / vb, y2: b.y / vb });
    }
  }
  for (let py = 0; py < SS; py += 1) {
    const y = (py + 0.5) / SS;
    for (let px = 0; px < SS; px += 1) {
      const x = (px + 0.5) / SS;
      let inside = false;
      for (const e of edges) {
        if (e.y1 === e.y2) continue;
        if ((e.y1 > y) === (e.y2 > y)) continue;
        const xi = e.x1 + ((y - e.y1) * (e.x2 - e.x1)) / (e.y2 - e.y1);
        if (xi > x) inside = !inside;
      }
      if (inside) buf[(py * SS + px) * 4 + 3] = 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let yy = 0; yy < size; yy += 1) {
    for (let xx = 0; xx < size; xx += 1) {
      let a = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          a += buf[((yy * 2 + dy) * SS + (xx * 2 + dx)) * 4 + 3]!;
        }
      }
      const o = (yy * size + xx) * 4;
      out[o] = fill[0];
      out[o + 1] = fill[1];
      out[o + 2] = fill[2];
      out[o + 3] = Math.round(a / 4);
    }
  }
  return out;
}

/** iconOutline:把 logo 边缘外扩 1px 深色描边(浅色面板可见)。 */
function addOutline(rgba: Buffer, size: number): Buffer {
  const out = Buffer.from(rgba);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (out[i + 3]! > 0) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          if (out[(ny * size + nx) * 4 + 3]! > 0) { near = true; break; }
        }
      }
      if (near) {
        out[i] = OUTLINE[0];
        out[i + 1] = OUTLINE[1];
        out[i + 2] = OUTLINE[2];
        out[i + 3] = 200;
      }
    }
  }
  return out;
}

/** 状态点:右下角圆点 + 深色 1px 描边环(带渐变抗锯齿)。 */
function drawDot(rgba: Buffer, size: number, color: readonly [number, number, number]): void {
  const d = Math.max(2, Math.round((size * 6) / 22));
  const r = d / 2;
  const m = Math.max(1, Math.round(size * 0.045));
  const cx = size - 1 - m - r;
  const cy = size - 1 - m - r;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - cx, y - cy);
      const i = (y * size + x) * 4;
      if (dist <= r) {
        rgba[i] = color[0];
        rgba[i + 1] = color[1];
        rgba[i + 2] = color[2];
        rgba[i + 3] = 255;
      } else if (dist <= r + 1) {
        const t = r + 1 - dist;
        rgba[i] = Math.round(OUTLINE[0] * t + rgba[i]! * (1 - t));
        rgba[i + 1] = Math.round(OUTLINE[1] * t + rgba[i + 1]! * (1 - t));
        rgba[i + 2] = Math.round(OUTLINE[2] * t + rgba[i + 2]! * (1 - t));
        rgba[i + 3] = Math.max(rgba[i + 3]!, Math.round(255 * t));
      }
    }
  }
}

/** 降级:纯色圆形图标(带白色 1px 描边),属性和色一应俱全,功能不中断。 */
export function fallbackIcon(state: TrayIconState, size: number, dotColor?: string): Buffer {
  if (size < 2) return Buffer.alloc(size * size * 4);
  const buf = Buffer.alloc(size * size * 4);
  const color =
    state === "base" ? ([120, 120, 120] as const) : safeHexToRgb(dotColor, STATE_COLORS[state]);
  const c = (size - 1) / 2;
  const r = size * 0.4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dist = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      if (dist <= r) {
        buf[i] = color[0];
        buf[i + 1] = color[1];
        buf[i + 2] = color[2];
        buf[i + 3] = 255;
      } else if (dist <= r + 1) {
        buf[i] = 255;
        buf[i + 1] = 255;
        buf[i + 2] = 255;
        buf[i + 3] = Math.round(255 * (r + 1 - dist));
      }
    }
  }
  return buf;
}

export interface IconOptions {
  /** 浅色面板兜底描边(默认取配置 iconOutline)。 */
  outline?: boolean;
  /** 供测试注入路径。 */
  svgPath?: string | null;
  /** logo 填充色(十六进制 #rrggbb,默认 DSH 品牌蓝 #4d6bfe)。 */
  iconColor?: string;
  /** 当前状态点颜色(十六进制 #rrggbb;缺省用内置 STATE_COLORS)。 */
  dotColor?: string;
}

/** "#rrggbb" → [r,g,b];非法值抛错(开发/诊断用,暴露配置错误)。 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error("[dsh-tray] 颜色需为十六进制 #rrggbb:" + hex);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** 渲染路径用安全版本:配置解析失败(缺字段/类型错/非法 hex)一律回退默认色,绝不崩溃。 */
function safeHexToRgb(hex: string | undefined, fallback: readonly [number, number, number]): [number, number, number] {
  if (typeof hex !== "string") return [...fallback];
  try {
    return hexToRgb(hex);
  } catch {
    return [...fallback];
  }
}

const cache = new Map<string, Buffer>();

/** 生成 (state, size) 的 RGBA 图标;解析失败自动降级为纯色圆。 */
export function makeIcon(state: TrayIconState, size: number, opts: IconOptions = {}): Buffer {
  const key =
    (opts.svgPath === undefined ? "sys:" : "tst:") + state + ":" + size +
    ":" + (opts.outline ? 1 : 0) + ":" + (opts.iconColor ?? "") + ":" + (opts.dotColor ?? "");
  const hit = cache.get(key);
  if (hit) return hit;
  if (opts.svgPath !== undefined) __setOfficialSvgPath(opts.svgPath);
  let rgba: Buffer;
  try {
    const p = loadOfficialSvg();
    // 未配置/非法配置统一回退 DSH 品牌蓝
    const fill = safeHexToRgb(opts.iconColor, [77, 107, 254]);
    rgba = rasterize(p, size, fill);
    if (opts.outline ?? false) rgba = addOutline(rgba, size);
    if (state !== "base") {
      const dot = safeHexToRgb(opts.dotColor, STATE_COLORS[state]);
      drawDot(rgba, size, dot);
    }
  } catch (err) {
    console.error("[dsh-tray] 图标渲染失败,降级为纯色圆:", (err as Error).message);
    rgba = fallbackIcon(state, size, opts.dotColor);
  }
  cache.set(key, rgba);
  return rgba;
}

/** RGBA → ARGB32(网络字节序 [A,R,G,B]),SNI IconPixmap 用。 */
export function toArgb32(rgba: Buffer): Buffer {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 3]!;
    out[i + 1] = rgba[i]!;
    out[i + 2] = rgba[i + 1]!;
    out[i + 3] = rgba[i + 2]!;
  }
  return out;
}

/** SNI IconPixmap:a(iiay) 多尺寸数组。 */
export function argbPixmap(state: TrayIconState, sizes: readonly number[], opts: IconOptions = {}): [number, number, Buffer][] {
  return sizes.map((s) => [s, s, toArgb32(makeIcon(state, s, opts))]);
}

/** DBusMenu icon-data:((iiay) RGBA 原序)。 */
export function iconData(state: TrayIconState, size: number, opts: IconOptions = {}): [number, number, Buffer] {
  return [size, size, makeIcon(state, size, opts)];
}

export function clearIconCache(): void {
  cache.clear();
  parsed = null;
}
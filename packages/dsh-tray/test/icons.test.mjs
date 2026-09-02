import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createRequire as req } from "node:module";

const require = createRequire(import.meta.url);
const NODE_MODULES = "/home/HumXC/.npm/_npx/1e7f6d9597241db0/node_modules";
const OFFICIAL_SVG = NODE_MODULES + "/@deepseek-ai/dsh-web-frontend/dist/favicon.svg";

// 从 lib 导入(构建后)
const icons = require("../lib/icons.js");

test("解析:官方 svg 能提取 path 数据", () => {
  icons.__setOfficialSvgPath(OFFICIAL_SVG);
  const p = icons.loadOfficialSvg();
  assert.ok(p.pathData.length > 100, "path 数据应有长度");
  assert.ok(p.subs.length >= 1, "至少一个子路径");
  assert.equal(p.viewBox, 50);
});

test("光栅化:22px base 有默认蓝填充且四角透明", () => {
  icons.__setOfficialSvgPath(OFFICIAL_SVG);
  const rgba = icons.makeIcon("base", 22, { svgPath: OFFICIAL_SVG });
  assert.equal(rgba.length, 22 * 22 * 4);
  let blue = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] > 200 && rgba[i] === 77 && rgba[i + 1] === 107 && rgba[i + 2] === 254) blue += 1;
  }
  assert.ok(blue > 50, "默认蓝像素应大于 50,实际 " + blue);
  // 四角应透明
  for (const xy of [[0, 0], [21, 0], [0, 21], [21, 21]]) {
    const a = rgba[(xy[1] * 22 + xy[0]) * 4 + 3];
    assert.equal(a, 0, "角点 (" + xy + ") 应透明");
  }
});

test("非法颜色回退默认:不抛错,输出默认蓝", () => {
  let buf;
  assert.doesNotThrow(() => {
    buf = icons.makeIcon("green", 22, { svgPath: OFFICIAL_SVG, iconColor: "#xyz", dotColor: "oops" });
  }, "非法颜色不应抛错");
  // 至少包含 logo 默认蓝(#4d6bfe)像素
  let blue = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] !== 0 && buf[i] === 77 && buf[i + 1] === 107 && buf[i + 2] === 254) blue += 1;
  }
  assert.ok(blue > 3, "非法颜色应回退默认蓝,实际蓝像素 " + blue);
});

test("自定义颜色:iconColor 填充 +dotColor 红点生效", () => {
  const rgba = icons.makeIcon("green", 22, { svgPath: OFFICIAL_SVG, iconColor: "#000000", dotColor: "#ff00ff" });
  let magenta = 0;
  let white = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const [r, g, b, a] = [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
    if (a === 0) continue;
    if (r === 0 && g === 0 && b === 0) white += 0; // 黑填充
    if (b > 200 && r > 200 && g < 120) magenta += 1; // 品红点
  }
  assert.ok(magenta > 3, "自定义点色品红存在,实际 " + magenta);
});

test("状态点:blue 22px 右下角存在蓝色像素", () => {
  icons.__setOfficialSvgPath(OFFICIAL_SVG);
  const rgba = icons.makeIcon("blue", 22, { svgPath: OFFICIAL_SVG });
  let blue = 0;
  for (let y = 12; y < 22; y += 1) {
    for (let x = 12; x < 22; x += 1) {
      const i = (y * 22 + x) * 4;
      if (rgba[i] > 40 && rgba[i] < 120 && rgba[i + 1] > 100 && rgba[i + 2] > 200 && rgba[i + 3] > 200) blue += 1;
    }
  }
  assert.ok(blue > 3, "右下角应有蓝色状态点,实际 " + blue);
});

test("ARGB32 字节序:toArgb32 为 [A,R,G,B]", () => {
  const rgba = Buffer.from([255, 10, 20, 30, 0, 0, 0, 0]);
  const argb = icons.toArgb32(rgba);
  assert.deepEqual([...argb.slice(0, 4)], [30, 255, 10, 20]);
});

test("降级:解析失败返回纯色圆而非抛错", () => {
  const bad = "/tmp/not-a-real-svg-file.svg";
  const rgba = icons.makeIcon("red", 22, { svgPath: bad });
  assert.equal(rgba.length, 22 * 22 * 4);
  let red = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > 200 && rgba[i + 1] < 120 && rgba[i + 2] < 120 && rgba[i + 3] > 200) red += 1;
  }
  assert.ok(red > 50, "降级图标应有大面积红色,实际 " + red);
});

test("缓存:同 key 两次 makeIcon 返回同一 buffer", () => {
  icons.clearIconCache();
  const a = icons.makeIcon("base", 22, { svgPath: OFFICIAL_SVG });
  const b = icons.makeIcon("base", 22, { svgPath: OFFICIAL_SVG });
  assert.equal(a, b);
});

test("多尺寸:16/22/44 均可生成且尺寸正确", () => {
  icons.clearIconCache();
  for (const s of [16, 22, 44]) {
    const rgba = icons.makeIcon("yellow", s, { svgPath: OFFICIAL_SVG });
    assert.equal(rgba.length, s * s * 4);
  }
  const pm = icons.argbPixmap("blue", [22, 44], { svgPath: OFFICIAL_SVG });
  assert.deepEqual(pm.map(([w, h]) => [w, h]), [[22, 22], [44, 44]]);
});
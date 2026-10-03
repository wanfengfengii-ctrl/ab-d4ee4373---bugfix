// 烟测：
//  1) 等待 /healthz 通过（服务由外部提供 BASE_URL，或本脚本临时拉起一个）；
//  2) 抓取页面与脚本资源，确认站点可服务；
//  3) 在同一求解器内核上跑「含一次分裂 + 一次漏检」的谱系场景并校验结果；
// 以退出码报告：0 通过，非 0 失败。
'use strict';

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { normalizeSpec, solveLineage, presentSolution } from '../public/js/lineage.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.WEB_HOST || 'web';
const PORT = process.env.WEB_PORT || '8080';
const BASE_URL = process.env.BASE_URL ||
  ((HOST === 'web' || HOST === '0.0.0.0') ? `http://web:${PORT}` : `http://127.0.0.1:${PORT}`);

let ownServer = null;
let portFile = null;

function log(msg) { console.log(`[smoke] ${msg}`); }
function fail(msg) { console.error(`[smoke] 失败: ${msg}`); process.exitCode = 1; throw new Error(msg); }

async function waitHealthy(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) {
        const j = await jsonOrText(r);
        log(`健康检查通过 ${base}/healthz -> ${JSON.stringify(j)}`);
        return;
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail(`健康检查超时: ${lastErr?.message || 'no response'}`);
}

async function jsonOrText(r) {
  try { return await r.json(); } catch { return await r.text(); }
}

async function startOwnServer() {
  portFile = join(tmpdir(), `algal-port-${process.pid}.txt`);
  if (existsSync(portFile)) rmSync(portFile);
  const child = spawn(process.execPath, [join(ROOT, 'server.cjs')], {
    env: { ...process.env, WEB_HOST: '127.0.0.1', WEB_PORT: '0', PORT_FILE: portFile },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  ownServer = child;
  return await new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, 'utf8').trim());
        if (Number.isInteger(port) && port > 0) {
          res(`http://127.0.0.1:${port}`);
          return;
        }
      }
      if (Date.now() - t0 > 10000) return rej(new Error('服务器未在 10s 内监听'));
      setTimeout(tick, 100);
    };
    tick();
  });
}
async function checkStatic(base) {
  const pages = ['/', '/index.html', '/js/lineage.js', '/js/app.js', '/css/style.css'];
  for (const p of pages) {
    const r = await fetch(`${base}${p}`);
    if (r.status !== 200) fail(`GET ${p} 状态码 ${r.status}`);
    const body = await r.text();
    if (!body.length) fail(`GET ${p} 返回空内容`);
  }
  log('静态资源全部可访问');
  const r404 = await fetch(`${base}/no-such-file`);
  if (r404.status !== 404) fail(`缺失资源应返回 404，实际 ${r404.status}`);
  log('404 行为正常');
}

// 同时含分裂与漏检的场景：
// 帧0 a → 帧1 b →（帧2 漏检）→ 帧3 c → 帧4 分裂为 e1/e2；
// 各帧还放置更亮的杂质 z*，验证不会被逐帧贪心串入。
function scenario() {
  return {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b', x: 15, y: 50, b: 42 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        { id: 'z2a', x: 86, y: 90, b: 200 },
        { id: 'z2b', x: 86, y: 80, b: 190 },
      ],
      [
        { id: 'c', x: 35, y: 50, b: 44 },
        { id: 'z3', x: 84, y: 85, b: 200 },
      ],
      [
        { id: 'e1', x: 45, y: 42, b: 46 },
        { id: 'e2', x: 45, y: 58, b: 48 },
        { id: 'z4', x: 82, y: 82, b: 200 },
      ],
    ],
    startId: 'a',
    maxDist: 14,
    maxSkip: 1,
    target: 2,
  };
}

function checkScenario() {
  const input = scenario();
  const { errors, spec } = normalizeSpec(input);
  if (errors.length) fail(`场景输入校验失败: ${JSON.stringify(errors)}`);
  const raw = solveLineage(spec);
  if (!raw.feasible) fail(`含分裂与漏检的场景被误判不可行: ${JSON.stringify(raw.earliestBreak)}`);
  const sol = presentSolution(spec, raw);

  const assert = (cond, msg) => { if (!cond) fail(msg); };
  assert(sol.skips === 1, `漏检段应为 1，实际 ${sol.skips}`);
  assert(sol.divisions === 1, `分裂次数应为 1，实际 ${sol.divisions}`);
  assert(sol.survivors === 2, `终帧存活应为 2，实际 ${sol.survivors}`);
  assert(JSON.stringify(sol.used[2]) === '[]', `第 3 帧应整帧漏检，实际 ${JSON.stringify(sol.used[2])}`);
  assert(sol.used[3][0] === 'c', `第 4 帧应补获 c，实际 ${JSON.stringify(sol.used[3])}`);
  assert(JSON.stringify(sol.used[4].sort()) === JSON.stringify(['e1', 'e2']),
    `末帧应为 e1/e2，实际 ${JSON.stringify(sol.used[4])}`);
  const gap = sol.edges.find((e) => e.gap === 2);
  assert(gap && gap.fromId === 'b' && gap.toId === 'c', '漏检段应为 b→c');
  const div = sol.edges.filter((e) => e.fromFrame === 3 && e.fromId === 'c');
  assert(div.length === 2 && div.every((e) => ['e1', 'e2'].includes(e.toId)), 'c 应分裂为 e1、e2');
  assert(sol.edges.every((e) => !e.toId.startsWith('z') && !e.fromId.startsWith('z')),
    '亮杂质 z* 不得进入谱系');
  const expectedBright = 40 + 42 + 44 + 46 + 48;
  assert(sol.totalBrightness === expectedBright,
    `总亮度应为 ${expectedBright}，实际 ${sol.totalBrightness}`);
  log(`谱系烟测通过：a→b →漏检→ c →(e1,e2)，总亮度 ${sol.totalBrightness}，位移表 ${sol.edges.length} 行`);

  // 不可行场景：收紧位移使首帧间彻底断开，应报告最早断开为 帧1→帧2
  const tight = structuredClone(input);
  tight.maxDist = 2;
  const spec2 = normalizeSpec(tight).spec;
  const raw2 = solveLineage(spec2);
  assert(raw2.feasible === false, '位移收紧后应不可行');
  assert(raw2.earliestBreak.from === 0 && raw2.earliestBreak.to === 1,
    `最早断开帧间应为 1→2，实际 ${raw2.earliestBreak.from + 1}→${raw2.earliestBreak.to + 1}`);
  log('不可行报告正确：最早断开 第 1 帧 → 第 2 帧');
}

// 分裂不应期业务烟测：
//  1) 连续分裂：起始细胞首裂后，女儿须等待门槛帧间才能再分裂；
//  2) 跨漏检计龄：跨一帧漏检的连接按真实跨度 +2，使女儿恰好成熟可分裂；
//  3) 所有候选都要求过早再分裂时，保留草稿并报告最早阻断帧间 / 母细胞 / 尚缺帧间。
function refTracks() {
  return {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b1', x: 12, y: 44, b: 41 },
        { id: 'b2', x: 12, y: 56, b: 41 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        { id: 'c1', x: 19, y: 44, b: 42 },
        { id: 'c2', x: 19, y: 56, b: 42 },
        { id: 'z2', x: 86, y: 90, b: 200 },
      ],
      [
        { id: 'd1', x: 26, y: 44, b: 43 },
        { id: 'd2', x: 26, y: 56, b: 43 },
        { id: 'z3', x: 84, y: 90, b: 200 },
      ],
      [
        { id: 'f1', x: 33, y: 38, b: 44 },
        { id: 'f2', x: 33, y: 50, b: 45 },
        { id: 'f3', x: 33, y: 56, b: 46 },
        { id: 'z4', x: 82, y: 90, b: 200 },
      ],
    ],
    startId: 'a',
    maxDist: 12,
    maxSkip: 0,
    target: 3,
  };
}

function checkRefractory() {
  const assert = (cond, msg) => { if (!cond) fail(msg); };
  const solve = (input) => {
    const { errors, spec } = normalizeSpec(input);
    if (errors.length) fail(`不应期场景输入校验失败: ${JSON.stringify(errors)}`);
    return presentSolution(spec, solveLineage(spec));
  };

  // 门槛 2：起始 0→1 分裂，女儿经两帧保持（年龄 2）后于 3→4 分裂，合法
  const ok = solve({ ...refTracks(), refractoryEnabled: true, refractory: 2 });
  assert(ok.feasible === true, '门槛 2 下连续分裂（隔两帧）应可行');
  assert(ok.divisions === 2, `应恰好两次分裂（首裂 + 成熟后再裂），实际 ${ok.divisions}`);
  const first = ok.divisionEvents[0];
  const second = ok.divisionEvents[1];
  assert(first.motherAge === null && first.frame === 0, '首次分裂应为起始细胞、不受限');
  assert(second.motherAge === 2 && second.frame === 3,
    `再次分裂时年龄应为 2 且在帧 3→4，实际 帧${second.frame + 1} 年龄${second.motherAge}`);
  // 标注：代际 / 年龄 / 尚余等待
  const b1 = ok.spots[1].find((s) => s.id === 'b1');
  assert(b1.generation === 2 && b1.age === 0 && b1.waitRemaining === 2,
    `新女儿应为第 2 代、年龄 0、尚余 2，实际 ${JSON.stringify(b1)}`);
  const d1 = ok.spots[3].find((s) => s.id === 'd1');
  assert(d1.age === 2 && d1.waitRemaining === 0, '成熟支尚余等待应为 0');
  log('连续分裂烟测通过：起始首裂 → 等待 2 帧间 → 女儿再裂，代际/年龄/等待标注正确');

  // 门槛 3：同一女儿分裂时只累计到 2，被阻断且尚缺 1 帧间
  const blocked = solve({ ...refTracks(), refractoryEnabled: true, refractory: 3 });
  assert(blocked.feasible === false, '门槛 3 下女儿过早再分裂应不可行');
  assert(blocked.refractoryBlock, '应给出不应期阻断归因');
  assert(blocked.refractoryBlock.from === 3 && blocked.refractoryBlock.to === 4,
    `最早阻断帧间应为 4→5，实际 ${blocked.refractoryBlock.from + 1}→${blocked.refractoryBlock.to + 1}`);
  assert(blocked.refractoryBlock.age === 2 && blocked.refractoryBlock.missing === 1,
    `阻断时年龄应为 2、尚缺 1，实际 年龄${blocked.refractoryBlock.age} 缺${blocked.refractoryBlock.missing}`);
  log(`不应期阻断烟测通过：${blocked.refractoryBlock.intervalLabel} 母细胞 ${blocked.refractoryBlock.motherLabel} 尚缺 ${blocked.refractoryBlock.missing} 帧间`);

  // 门槛 2 但只给 4 帧，且帧 2/3 有三个近邻斑点：要达到 3 支必须有女儿在
  // 诞生后的下一帧（年龄 0）立即再分裂，最早阻断在 2→3
  const earlyInput = {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b1', x: 12, y: 46, b: 41 },
        { id: 'b2', x: 12, y: 54, b: 41 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        { id: 'c0', x: 19, y: 38, b: 42 },
        { id: 'c1', x: 19, y: 46, b: 42 },
        { id: 'c2', x: 19, y: 54, b: 42 },
      ],
      [
        { id: 'd1', x: 26, y: 42, b: 43 },
        { id: 'd2', x: 26, y: 50, b: 43 },
        { id: 'd3', x: 26, y: 58, b: 43 },
      ],
    ],
    startId: 'a',
    maxDist: 11,
    maxSkip: 0,
    target: 3,
    refractoryEnabled: true,
    refractory: 2,
  };
  const early = solve(earlyInput);
  assert(early.feasible === false, '4 帧内要求连翻两番应被不应期阻断');
  assert(early.refractoryBlock && early.refractoryBlock.from === 1 && early.refractoryBlock.age === 0,
    `最早阻断应在 2→3 且母细胞年龄 0，实际 ${JSON.stringify(early.refractoryBlock)}`);
  assert(early.refractoryBlock.missing === 2, '年龄 0、门槛 2 时尚缺 2 帧间');
  // 关闭不应期同一草稿可行（证明阻断完全来自不应期）
  const off = solve({ ...earlyInput, refractoryEnabled: false });
  assert(off.feasible === true, '关闭不应期后同一草稿应可行');
  log('不应期开关烟测通过：开启阻断年龄 0 的即时再分裂，关闭则恢复原规则');

  // 跨漏检计龄：女儿诞生于帧 1，帧 2 整支漏检，帧 3 补获（年龄 +2）后于 3→4 分裂
  const gapInput = {
    frames: [
      [
        { id: 'a', x: 5, y: 50, b: 40 },
        { id: 'z0', x: 90, y: 90, b: 200 },
      ],
      [
        { id: 'b1', x: 12, y: 44, b: 41 },
        { id: 'b2', x: 12, y: 56, b: 41 },
        { id: 'z1', x: 88, y: 90, b: 200 },
      ],
      [
        // b1 的支本帧漏检：附近无可达斑点；b2 保持到 c2
        { id: 'c2', x: 19, y: 56, b: 42 },
        { id: 'z2', x: 86, y: 90, b: 200 },
      ],
      [
        { id: 'c1', x: 26, y: 44, b: 43 }, // b1 跨帧补获（位移 ≤ 2×maxDist）
        { id: 'd2', x: 26, y: 56, b: 43 },
        { id: 'z3', x: 84, y: 90, b: 200 },
      ],
      [
        { id: 'f1', x: 33, y: 38, b: 44 },
        { id: 'f2', x: 33, y: 50, b: 45 },
        { id: 'f3', x: 33, y: 56, b: 46 },
        { id: 'z4', x: 82, y: 90, b: 200 },
      ],
    ],
    startId: 'a',
    maxDist: 12,
    maxSkip: 1,
    target: 3,
  };
  const gapOk = solve({ ...gapInput, refractoryEnabled: true, refractory: 2 });
  assert(gapOk.feasible === true, `跨漏检计龄场景门槛 2 应可行（漏检 +2 使支恰好成熟）：${JSON.stringify(gapOk.earliestBreak)}`);
  assert(gapOk.skips === 1, '应有 1 个漏检段');
  const gapDiv = gapOk.divisionEvents.find((d) => d.motherId === 'c1');
  assert(gapDiv && gapDiv.frame === 3 && gapDiv.motherAge === 2,
    `c1 应在帧 4 以年龄 2（漏检 +2）分裂，实际 ${JSON.stringify(gapDiv)}`);
  // 若错误地只按 +1 计龄，门槛 2 下此分裂不可能；用门槛 3 复核阻断口径
  const gapTight = solve({ ...gapInput, refractoryEnabled: true, refractory: 3 });
  assert(gapTight.feasible === false, '门槛 3 时跨漏检支（年龄 2）仍应被阻断');
  assert(gapTight.refractoryBlock && gapTight.refractoryBlock.age === 2 &&
    gapTight.refractoryBlock.missing === 1,
    `跨漏检阻断应报告年龄 2、尚缺 1，实际 ${JSON.stringify(gapTight.refractoryBlock)}`);
  log('跨漏检计龄烟测通过：漏检连接按真实跨度 +2，年龄恰好达到门槛 2 才允许分裂');
}

async function main() {
  let base = BASE_URL;
  if (process.env.BASE_URL) {
    log(`使用外部服务 ${base}`);
  } else {
    // Compose 的 verify 服务通过主机名 web 访问；本地直跑时自己拉起服务器
    try {
      await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
    } catch {
      log(`无法连接 ${base}，改为本地临时启动服务器`);
      base = await startOwnServer();
      log(`临时服务器监听于 ${base}`);
    }
  }
  await waitHealthy(base);
  await checkStatic(base);
  checkScenario();
  checkRefractory();
  log('全部烟测通过 ✔');
  if (ownServer) ownServer.kill('SIGTERM');
  if (portFile && existsSync(portFile)) rmSync(portFile);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  if (ownServer) ownServer.kill('SIGTERM');
  process.exit(1);
});

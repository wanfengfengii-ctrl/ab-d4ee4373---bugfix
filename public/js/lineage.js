// 藻类细胞分裂谱系复原核心（纯函数，零依赖，浏览器 / Node 共用）
//
// 模型：
//  - 帧按时刻排列；每帧若干斑点（唯一 id、整数坐标、整数亮度）。
//  - 连接只允许相邻帧（gap=1）或跨越恰好一帧漏检（gap=2）。
//  - 一个细胞要么保持为一个后代，要么分裂为恰两个后代；不允许消亡。
//  - 每个非起始斑点恰有一个祖先（入边），同一斑点不得被两支共用。
//  - 所有存活支必须从起始斑点出发到达末帧，且末帧存活数恰为目标数。
//  - 裁决顺序：总亮度最高 → 漏检段最少 → 输入顺序（逐帧采用斑点局部序号，
//    再逐斑点母本全局序号）字典序稳定裁决。
//  - 分裂不应期（可选，门槛 2~4 个帧间）：起始细胞首次分裂不受限；此后每支
//    自诞生（母本分裂）起累计分裂年龄——普通连接 +1 帧间，跨漏检连接按真实
//    跨度 +2 帧间；只有年龄达到门槛的支才允许分裂，分裂后两个女儿年龄归零。
//
// 位掩码动态规划：帧内斑点以位掩码表示；边界转移在「已占用女儿掩码 +
// 新开漏检母本掩码 + 各支分裂年龄」上做内层 DP，同一 (女儿集合, 漏检集合,
// 女儿年龄向量) 只保留字典序最小的母本配对，不展开母亲排列；状态
// (帧, 存活掩码, 漏检掩码, 剩余额度, 两支年龄向量) 备忘。不应期在联合转移
// 内部直接生效，而不是先按原规则求解再删除过早分裂。

'use strict';

// 起始支年龄标记：起始细胞首次分裂不受限制；保持 / 漏检时继续沿用此标记，
// 直到其首次分裂，两个女儿回到正常年龄 0。
const ROOT_AGE = 15;
const AGE_SCALE = 16;

// 年龄累计：达到门槛后即钳制为门槛值——DP 只需区分「能否分裂」，成熟支在
// 整个未来都满足（除非分裂重置）；真实展示年龄事后沿边树累加，不受钳制影响。
const makeIncAge = (threshold) =>
  (a, d) => (a === ROOT_AGE ? ROOT_AGE : Math.min(threshold, a + d));

/**
 * 校验并规范化输入。
 * @returns {{errors:Array<{field:string,message:string}>, spec:object|null}}
 */
export function normalizeSpec(raw) {
  const errors = [];
  const field = (name, message) => errors.push({ field: name, message });

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.frames)) {
    return { errors: [{ field: 'frames', message: '缺少帧数据' }], spec: null };
  }
  const F = raw.frames.length;
  if (F < 4 || F > 7) {
    field('frames', `帧数必须在 4 至 7 之间（当前 ${F}）`);
  }

  const frames = [];
  raw.frames.forEach((fr, t) => {
    const out = [];
    if (!Array.isArray(fr) || fr.length < 2 || fr.length > 8) {
      field(`frame${t}`, `第 ${t + 1} 帧斑点数必须在 2 至 8 之间（当前 ${Array.isArray(fr) ? fr.length : 0}）`);
      return;
    }
    const seen = new Set();
    fr.forEach((s, j) => {
      const label = `第 ${t + 1} 帧斑点 ${j + 1}`;
      if (!s || typeof s.id !== 'string' || s.id.trim() === '') {
        field(`frame${t}`, `${label} 缺少唯一编号`);
        return;
      }
      const id = s.id.trim();
      if (seen.has(id)) {
        field(`frame${t}`, `第 ${t + 1} 帧内斑点编号重复：${id}`);
        return;
      }
      seen.add(id);
      const x = Number(s.x);
      const y = Number(s.y);
      const b = Number(s.b);
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        field(`frame${t}`, `${label}（${id}）坐标必须为整数`);
        return;
      }
      if (!Number.isInteger(b) || b < 0) {
        field(`frame${t}`, `${label}（${id}）亮度必须为非负整数`);
        return;
      }
      out.push({ id, x, y, b });
    });
    frames.push(out);
  });

  if (errors.length) return { errors, spec: null };

  const startId = typeof raw.startId === 'string' ? raw.startId.trim() : '';
  const startIndex = frames[0] ? frames[0].findIndex((s) => s.id === startId) : -1;
  if (startIndex < 0) {
    field('startId', `起始斑点必须是第 1 帧中存在的编号（当前“${raw.startId}”）`);
  }

  const maxDist = Number(raw.maxDist);
  if (!Number.isFinite(maxDist) || maxDist < 0) {
    field('maxDist', '相邻帧最大位移必须为非负数');
  }

  const maxSkip = Number(raw.maxSkip);
  if (!Number.isInteger(maxSkip) || maxSkip < 0 || maxSkip > F - 2) {
    field('maxSkip', `允许漏检帧数必须为 0 至 ${Math.max(0, F - 2)} 的整数`);
  }

  const lastSize = frames[F - 1] ? frames[F - 1].length : 0;
  const target = Number(raw.target);
  if (!Number.isInteger(target) || target < 1 || target > lastSize) {
    field('target', `终帧存活细胞数必须为 1 至末帧斑点数（${lastSize}）的整数`);
  }

  // 分裂不应期开关：仅显式真值启用；缺省关闭时旧输入行为完全不变。
  const refractoryEnabled =
    raw.refractoryEnabled === true || raw.refractoryEnabled === 'true' || raw.refractoryEnabled === 1;
  let refractory = Number(raw.refractory);
  if (!Number.isInteger(refractory) || refractory < 2 || refractory > 4) {
    if (refractoryEnabled) {
      field('refractory', '分裂不应期门槛必须为 2 至 4 的整数（帧间）');
    }
    refractory = 2; // 未启用时不参与约束，仅给个规范化缺省值
  }

  if (errors.length) return { errors, spec: null };
  return {
    errors: [],
    spec: { frames, startIndex, maxDist, maxSkip, target, refractoryEnabled, refractory },
  };
}

function compareTuple(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

// 比较两个裁决签名：逐帧比较（采用斑点局部序号元组，再母本全局序号元组）。
function betterSignature(a, b) {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    const c = compareTuple(a[k].used, b[k].used);
    if (c !== 0) return c < 0;
    const cm = compareTuple(a[k].mothers, b[k].mothers);
    if (cm !== 0) return cm < 0;
  }
  return false;
}

/**
 * 求解引擎。
 * @param enforceRefractory false 时忽略不应期（松弛引擎），分裂年龄照常累计，
 *   用于在不可行时定位「最早被迫过早再分裂」的支与所欠帧间。
 */
function solveEngine(spec, enforceRefractory, feasOnly = false) {
  const { frames, startIndex, maxDist, maxSkip, target, refractoryEnabled, refractory } = spec;
  const enforce = refractoryEnabled && enforceRefractory;
  // 仅在强制不应期时把分裂年龄带入状态键。关闭不应期（含用于归因的松弛引擎）
  // 时状态空间与原引擎完全一致——松弛归因只需第一层用强制前缀携带的年龄识别
  // 被迫早裂的母本，后缀是否存在任意松弛解与年龄无关。
  const trackAges = enforce;
  const incAge = makeIncAge(refractory);
  const FEAS_SENTINEL = { feasibleSentinel: true };
  const F = frames.length;
  const sizes = frames.map((fr) => fr.length);

  const offset = [0];
  for (let t = 1; t <= F; t++) offset[t] = offset[t - 1] + sizes[t - 1];
  const gi = (t, i) => offset[t] + i;

  const d2 = (a, b) => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  };

  const popcnt = (m) => {
    let c = 0;
    while (m) { m &= m - 1; c++; }
    return c;
  };
  const bits = (m) => {
    const out = [];
    for (let i = 0; m; i++, m >>>= 1) if (m & 1) out.push(i);
    return out;
  };

  // 邻接位掩码：near1[t][i] 为帧 t 斑点 i 在帧 t+1 内可达的女儿掩码；
  // near2[t][i] 为跨一帧漏检后在帧 t+2 内可达的女儿掩码。
  const D2 = maxDist * maxDist;
  const G2 = 4 * D2;
  const near1 = [];
  const near2 = [];
  for (let t = 0; t < F - 1; t++) {
    near1[t] = frames[t].map((s) => {
      let mask = 0;
      frames[t + 1].forEach((q, j) => { if (d2(s, q) <= D2) mask |= 1 << j; });
      return mask;
    });
    if (t < F - 2) {
      near2[t] = frames[t].map((s) => {
        let mask = 0;
        frames[t + 2].forEach((q, j) => { if (d2(s, q) <= G2) mask |= 1 << j; });
        return mask;
      });
    }
  }

  // 各帧「掩码 → 亮度和」预计算
  const maskBright = frames.map((fr) => {
    const arr = new Array(1 << fr.length).fill(0);
    for (let m = 1; m < arr.length; m++) {
      const lsb = m & -m;
      arr[m] = arr[m ^ lsb] + fr[Math.log2(lsb)].b;
    }
    return arr;
  });

  // 每对 (t, 母本) 的保持单女儿掩码列表与分裂双女儿掩码列表
  const keepOpts = [];
  const splitOpts = [];
  for (let t = 0; t < F - 1; t++) {
    keepOpts[t] = near1[t].map((mask) => bits(mask).map((j) => 1 << j));
    splitOpts[t] = near1[t].map((mask) => {
      const js = bits(mask);
      const out = [];
      for (let a = 0; a < js.length; a++) {
        for (let b = a + 1; b < js.length; b++) out.push((1 << js[a]) | (1 << js[b]));
      }
      return out;
    });
  }

  // 年龄向量按掩码中置位位号顺序打包（每个年龄 0~15），用作备忘键的一部分。
  // 未启用不应期时恒为 0：年龄不进入状态，备忘结构与原引擎等价。
  const packAges = (mask, ageVec) => {
    if (!trackAges) return 0;
    let k = 0;
    for (let m = mask; m; m &= m - 1) {
      const i = Math.log2(m & -m);
      k = k * AGE_SCALE + ageVec[i];
    }
    return k;
  };
  // 女儿年龄向量（含未采用的 -1 槽位）的顺序签名：每槽 5 位（年龄 -1..15
  // 映射为 0..16），8 槽共 40 位，安全落在 2^53 精确整数内，零碰撞。
  const childAgeSig = (ch) => {
    if (!trackAges) return 0;
    let k = 0;
    for (let j = 0; j < ch.length; j++) k = k * 32 + (ch[j] + 1);
    return k;
  };

  const ageVec = (n, fn) => {
    const v = new Int8Array(n).fill(-1);
    if (fn) fn(v);
    return v;
  };

  /**
   * 边界 t 的联合转移：存活母本（帧 t）与待补获漏检母本（帧 t-1）
   * 共同在帧 t+1 上安排女儿；同时为每条存活支携带分裂年龄。
   * @returns {Array<object>} 每个选项 {used, opened, mom, ch, gapAgeNext, splits}：
   *   mom  为按女儿序号排列的母本全局序号（-1 未采用）；
   *   ch   为女儿在帧 t+1 的分裂年龄（漏检补获沿用跨度年龄，保持 +1，分裂归 0）；
   *   gapAgeNext 为下一状态漏检母本（帧 t 序号）的年龄（已按跨度 +2）；
   *   splits 为本次分裂的母本全局序号列表（是否放行由调用方按年龄解释）。
   */
  const expandMemo = new Map();
  function expand(t, live, gaps, liveAge, gapAge) {
    const key = trackAges
      ? `e|${t}|${live}|${gaps}|${packAges(live, liveAge)}|${packAges(gaps, gapAge)}`
      : (t << 20) | (live << 10) | gaps;
    const cached = expandMemo.get(key);
    if (cached) return cached;

    const nChild = sizes[t + 1];
    const liveMoms = bits(live);
    const gapMoms = bits(gaps);

    // 不追踪年龄时（不应期关闭）：状态键 -> 母本向量，内层结构与原引擎一致，
    // 无年龄数组、无嵌套 Map，状态空间零退化。
    if (!trackAges) {
      let dp = new Map([[0, new Int8Array(nChild).fill(-1)]]);
      const putFast = (map, k, mom) => {
        const old = map.get(k);
        if (old === undefined) { map.set(k, mom); return; }
        for (let j = 0; j < nChild; j++) {
          if (mom[j] !== old[j]) {
            if (mom[j] < old[j]) map.set(k, mom);
            return;
          }
        }
      };
      const totalTracks = gapMoms.length + liveMoms.length;
      let processed = 0;
      for (const mi of gapMoms) {
        const gm = gi(t - 1, mi);
        const cap = near2[t - 1][mi];
        const rest = totalTracks - processed - 1;
        const ndp = new Map();
        for (const [state, mom] of dp) {
          const used = Math.floor(state / 512);
          for (const b of bits(cap & ~used)) {
            const bit = 1 << b;
            if (popcnt(used | bit) + rest > target) continue;
            const mom2 = mom.slice();
            mom2[b] = gm;
            putFast(ndp, (used | bit) * 512, mom2);
          }
        }
        dp = ndp;
        processed++;
      }
      const canOpen = t + 2 <= F - 1;
      for (const mi of liveMoms) {
        const gm = gi(t, mi);
        const miBit = 1 << mi;
        const rest = totalTracks - processed - 1;
        const ndp = new Map();
        for (const [state, mom] of dp) {
          const used = Math.floor(state / 512);
          const opened = state % 512;
          for (const bit of keepOpts[t][mi]) {
            if (used & bit) continue;
            const used2 = used | bit;
            if (popcnt(used2) + popcnt(opened) + rest > target) continue;
            const b = Math.log2(bit);
            const mom2 = mom.slice();
            mom2[b] = gm;
            putFast(ndp, used2 * 512 + opened, mom2);
          }
          for (const pair of splitOpts[t][mi]) {
            if (used & pair) continue;
            const used2 = used | pair;
            if (popcnt(used2) + popcnt(opened) + rest > target) continue;
            const mom2 = mom.slice();
            for (const b of bits(pair)) mom2[b] = gm;
            putFast(ndp, used2 * 512 + opened, mom2);
          }
          if (canOpen) {
            const opened2 = opened | miBit;
            if (popcnt(used) + popcnt(opened2) + rest <= target) {
              putFast(ndp, used * 512 + opened2, mom);
            }
          }
        }
        dp = ndp;
        processed++;
      }
      const out = [];
      for (const [state, mom] of dp) {
        const used = Math.floor(state / 512);
        const opened = state % 512;
        out.push({ used, opened, mom, ch: null, gapAgeNext: null, splits: [] });
      }
      expandMemo.set(key, out);
      return out;
    }

    // 追踪年龄（不应期启用）：状态键 -> (女儿年龄签名 -> {母本向量, 女儿年龄向量})
    let dp = new Map([[0, new Map([[
      0,
      { mom: new Int8Array(nChild).fill(-1), ch: new Int8Array(nChild).fill(-1) },
    ]])]]);

    // 同一 (状态, 女儿年龄签名) 只保留字典序最小的母本向量
    const put = (map, state, sig, mom, ch) => {
      let variants = map.get(state);
      if (!variants) {
        variants = new Map();
        map.set(state, variants);
      }
      const old = variants.get(sig);
      if (old === undefined) { variants.set(sig, { mom, ch }); return; }
      for (let j = 0; j < nChild; j++) {
        if (mom[j] !== old.mom[j]) {
          if (mom[j] < old.mom[j]) variants.set(sig, { mom, ch });
          return;
        }
      }
    };

    // 1) 待补获漏检母本（帧 t-1）：恰一个跨帧女儿；跨度 +2 已在开漏检时计入
    const totalTracks = gapMoms.length + liveMoms.length;
    let processed = 0;
    for (const mi of gapMoms) {
      const gm = gi(t - 1, mi);
      const cap = near2[t - 1][mi];
      const rest = totalTracks - processed - 1; // 尚未处理的母本，至少再贡献 1 支
      const ndp = new Map();
      for (const [state, variants] of dp) {
        const used = Math.floor(state / 512);
        for (const { mom, ch } of variants.values()) {
          for (const b of bits(cap & ~used)) {
            const bit = 1 << b;
            if (popcnt(used | bit) + rest > target) continue;
            const mom2 = mom.slice();
            const ch2 = ch.slice();
            mom2[b] = gm;
            ch2[b] = gapAge[mi];
            put(ndp, (used | bit) * 512, childAgeSig(ch2), mom2, ch2);
          }
        }
      }
      dp = ndp;
      processed++;
    }

    // 2) 存活母本（帧 t）：保持一女（年龄 +1）/ 分裂两女（女儿归 0，母本须
    //    达到不应期门槛，起始支除外）/ 本帧漏检（年龄 +2，下一帧补获）
    const canOpen = t + 2 <= F - 1;
    for (const mi of liveMoms) {
      const gm = gi(t, mi);
      const miBit = 1 << mi;
      const momAge = liveAge[mi];
      const maySplit = !enforce || momAge >= refractory;
      const rest = totalTracks - processed - 1;
      const ndp = new Map();
      for (const [state, variants] of dp) {
        const used = Math.floor(state / 512);
        const opened = state % 512;
        for (const { mom, ch } of variants.values()) {
          // 2a) 保持
          for (const bit of keepOpts[t][mi]) {
            if (used & bit) continue;
            const used2 = used | bit;
            if (popcnt(used2) + popcnt(opened) + rest > target) continue;
            const b = Math.log2(bit);
            const mom2 = mom.slice();
            const ch2 = ch.slice();
            mom2[b] = gm;
            ch2[b] = incAge(momAge, 1);
            put(ndp, used2 * 512 + opened, childAgeSig(ch2), mom2, ch2);
          }
          // 2b) 分裂（不应期在此直接拦截：年龄不足根本不产生该选项）
          if (maySplit) {
            for (const pair of splitOpts[t][mi]) {
              if (used & pair) continue;
              const used2 = used | pair;
              if (popcnt(used2) + popcnt(opened) + rest > target) continue;
              const mom2 = mom.slice();
              const ch2 = ch.slice();
              for (const b of bits(pair)) {
                mom2[b] = gm;
                ch2[b] = 0; // 新女儿从零累计年龄
              }
              put(ndp, used2 * 512 + opened, childAgeSig(ch2), mom2, ch2);
            }
          }
          // 2c) 本帧漏检（下一帧必须补获）；漏检跨两个帧间，年龄 +2
          if (canOpen) {
            const opened2 = opened | miBit;
            if (popcnt(used) + popcnt(opened2) + rest <= target) {
              put(ndp, used * 512 + opened2, childAgeSig(ch), mom, ch);
            }
          }
        }
      }
      dp = ndp;
      processed++;
    }

    const out = [];
    for (const [state, variants] of dp) {
      const used = Math.floor(state / 512);
      const opened = state % 512;
      const gapAgeNext = ageVec(sizes[t]);
      for (const mi of bits(opened)) gapAgeNext[mi] = incAge(liveAge[mi], 2);
      for (const { mom, ch } of variants.values()) {
        // 母本全局序号在该配对中出现两次即本次分裂（按变体分别判定）
        const momCount = new Map();
        for (const j of bits(used)) momCount.set(mom[j], (momCount.get(mom[j]) || 0) + 1);
        const splits = [...momCount].filter(([, c]) => c === 2).map(([g]) => g);
        out.push({ used, opened, mom, ch, gapAgeNext, splits });
      }
    }
    expandMemo.set(key, out);
    return out;
  }

  const memo = new Map();
  // 不可行后缀的额度单调记忆：键不含 left，值为「已证不可行的最大剩余额度」。
  // 更大额度都不可行时，更少额度必然不可行（可行选项只会更少）。
  const infeasibleMaxLeft = new Map();
  // 年龄支配前沿：同一 (帧, 存活掩码, 漏检掩码) 下，更成熟且额度更多的配置不可
  // 行，则更年轻的配置必然不可行（年轻支允许的分裂选项是严格子集）。
  const domMemo = new Map();
  const stateKey = (t, live, gaps, left, liveAge, gapAge) =>
    trackAges
      ? `s|${t}|${live}|${gaps}|${left}|${packAges(live, liveAge)}|${packAges(gaps, gapAge)}`
      : ((((t * 256 + live) * 256 + gaps) * 8) + left) * 31;
  const ageStateKey = (t, live, gaps, liveAge, gapAge) =>
    `${t}|${live}|${gaps}|${packAges(live, liveAge)}|${packAges(gaps, gapAge)}`;

  // 逐位比较年龄（按掩码置位顺序）：a 每支都 ≥ b（ROOT_AGE=15 大于一切正常年龄）
  function agesDominate(mask, a, b) {
    for (let m = mask; m; m &= m - 1) {
      const i = Math.log2(m & -m);
      if (a[i] < b[i]) return false;
    }
    return true;
  }
  function dominatedInfeasible(t, live, gaps, left, liveAge, gapAge) {
    const list = domMemo.get(`${t}|${live}|${gaps}`);
    if (!list) return false;
    for (const y of list) {
      if (y.left < left) continue;
      if (agesDominate(live, y.liveAge, liveAge) && agesDominate(gaps, y.gapAge, gapAge)) {
        return true;
      }
    }
    return false;
  }
  // 配置 x 支配 y（同为不可行后缀）：x 额度更多且每支年龄更成熟——x 的可行
  // 选项是 y 的超集，x 不可行则 y 必不可行。前沿只保留互不支配的配置。
  function configDominates(mask, gapMask, x, y) {
    if (x.left < y.left) return false;
    return agesDominate(mask, x.liveAge, y.liveAge) && agesDominate(gapMask, x.gapAge, y.gapAge);
  }
  function recordDom(t, live, gaps, left, liveAge, gapAge) {
    const k = `${t}|${live}|${gaps}`;
    const entry = { left, liveAge: liveAge.slice(), gapAge: gapAge.slice() };
    let list = domMemo.get(k);
    if (!list) { list = []; domMemo.set(k, list); }
    // 新配置与既有前沿互相支配时维护 Pareto 前沿
    for (let i = list.length - 1; i >= 0; i--) {
      if (configDominates(live, gaps, entry, list[i])) list.splice(i, 1);
    }
    if (!list.some((y) => configDominates(live, gaps, y, entry))) list.push(entry);
  }

  // 计数增长走廊：从 (live, gaps) 起，每步至多翻倍，漏检补获只能单传，
  // 判断末帧存活数能否达到目标。
  function canReachTarget(t, live, gaps) {
    let co = popcnt(live);
    let cg = popcnt(gaps);
    for (let s = 1; s <= F - 1 - t; s++) {
      co = Math.min(sizes[t + s], 2 * co + cg);
      cg = 0;
    }
    return co >= target;
  }

  // 年龄感知的增长走廊上界（仅启用不应期时使用）：未成熟支不能分裂只能单传，
  // 成熟支每步至多翻倍、女儿归 0；漏检只会延缓成熟，求上界时忽略。
  function canReachTargetAged(t, live, gaps, liveAge, gapAge) {
    let ages = bits(live).map((i) => liveAge[i]);
    let gapAges = bits(gaps).map((i) => gapAge[i]);
    for (let s = 1; s <= F - 1 - t; s++) {
      const next = gapAges; // 待补获漏检母本：恰一个女儿，年龄沿用
      for (const a of ages) {
        if (a === ROOT_AGE || a >= refractory) {
          next.push(0, 0); // 成熟支分裂为两个零龄女儿
        } else {
          next.push(Math.min(refractory, a + 1)); // 未成熟只能保持
        }
      }
      // 帧容量有限时保留最成熟的支，保证上界对未来最乐观
      if (next.length > sizes[t + s]) {
        next.sort((a, b) => b - a);
        next.length = sizes[t + s];
      }
      ages = next;
      gapAges = [];
    }
    return ages.length >= target;
  }

  // 返回从边界 t 到末帧的最优后缀，不可行返回 null
  function solve(t, live, gaps, left, liveAge, gapAge) {
    const key = stateKey(t, live, gaps, left, liveAge, gapAge);
    if (memo.has(key)) return memo.get(key);
    const akey = ageStateKey(t, live, gaps, liveAge, gapAge);
    if (enforce && (infeasibleMaxLeft.get(akey) ?? -1) >= left) {
      memo.set(key, null);
      return null;
    }
    const markInfeasible = () => {
      memo.set(key, null);
      if (enforce) {
        infeasibleMaxLeft.set(akey, Math.max(infeasibleMaxLeft.get(akey) ?? -1, left));
        recordDom(t, live, gaps, left, liveAge, gapAge);
      }
      return null;
    };

    const count = popcnt(live) + popcnt(gaps);
    if (count > target || left < 0) return markInfeasible();
    if (t === F - 1) {
      const leaf = gaps === 0 && popcnt(live) === target
        ? { bright: 0, skips: 0, frames: [], pick: null, sub: null }
        : null;
      if (!leaf) return markInfeasible();
      memo.set(key, leaf);
      return leaf;
    }
    if (!canReachTarget(t, live, gaps)) return markInfeasible();
    if (enforce && !canReachTargetAged(t, live, gaps, liveAge, gapAge)) return markInfeasible();
    if (enforce && dominatedInfeasible(t, live, gaps, left, liveAge, gapAge)) {
      memo.set(key, null);
      return null;
    }

    let best = null;
    for (const opt of expand(t, live, gaps, liveAge, gapAge)) {
      const openCount = popcnt(opt.opened);
      if (openCount > left) continue;

      const sub = solve(t + 1, opt.used, opt.opened, left - openCount, opt.ch, opt.gapAgeNext);
      if (!sub) continue;

      // 可行性模式：找到任意完整后缀即可，不构造候选、不比较裁决，开销远小于
      // 完整最优求解（供不应期归因判断「强制前缀是否存在某个松弛完成」）。
      if (feasOnly) {
        best = FEAS_SENTINEL;
        break;
      }

      const usedBits = bits(opt.used);
      const sigFrame = {
        used: usedBits,
        mothers: usedBits.map((j) => opt.mom[j]),
      };
      const cand = {
        bright: maskBright[t + 1][opt.used] + sub.bright,
        skips: openCount + sub.skips,
        frames: [sigFrame, ...sub.frames],
        pick: { t, used: opt.used, mom: opt.mom },
        sub,
      };
      if (
        !best ||
        cand.bright > best.bright ||
        (cand.bright === best.bright &&
          (cand.skips < best.skips ||
            (cand.skips === best.skips && betterSignature(cand.frames, best.frames))))
      ) {
        best = cand;
      }
    }
    memo.set(key, best);
    if (!best) return markInfeasible();
    return best;
  }

  const rootMask = 1 << startIndex;
  const rootLiveAge = ageVec(sizes[0], (v) => { v[startIndex] = ROOT_AGE; });
  const rootGapAge = ageVec(sizes[0]);
  const root = solve(0, rootMask, 0, maxSkip, rootLiveAge, rootGapAge);

  // 可行性模式：只回答「是否存在任意完整谱系」，供不应期归因复用，不做
  // 前向断帧分析与结果重建。
  if (feasOnly) {
    return {
      feasible: !!root,
      expand: (t, live, gaps, liveAge, gapAge) => expand(t, live, gaps, liveAge, gapAge),
      solve: (t, live, gaps, left, liveAge, gapAge) =>
        solve(t, live, gaps, left, liveAge, gapAge),
    };
  }

  if (!root) {
    // 最早断开帧间：逐步前向展开可达状态，以局部必要存活条件（计数走廊、
    // 漏检必须在补获帧有可达斑点、末帧计数恰为目标）筛选，找出首个
    // 所有后继都无法存活的帧间。
    const viable = (t, live, gaps, left) => {
      if (left < 0) return false;
      if (popcnt(live) + popcnt(gaps) > target) return false;
      if (t === F - 1) return gaps === 0 && popcnt(live) === target;
      if (!canReachTarget(t, live, gaps)) return false;
      if (t >= 1) {
        for (const mi of bits(gaps)) {
          if (near2[t - 1][mi] === 0) return false;
        }
      }
      return true;
    };

    const fwdKey = (live, gaps, liveAge, gapAge) =>
      `${live}|${gaps}|${packAges(live, liveAge)}|${packAges(gaps, gapAge)}`;
    let reach = new Map();
    if (viable(0, rootMask, 0, maxSkip)) {
      reach.set(fwdKey(rootMask, 0, rootLiveAge, rootGapAge),
        { t: 0, live: rootMask, gaps: 0, left: maxSkip, liveAge: rootLiveAge, gapAge: rootGapAge });
    }
    const reachAll = [reach];
    let earliest = 0;
    for (let t = 0; t < F - 1; t++) {
      const next = new Map();
      for (const st of reach.values()) {
        for (const opt of expand(t, st.live, st.gaps, st.liveAge, st.gapAge)) {
          const openCount = popcnt(opt.opened);
          const nleft = st.left - openCount;
          if (!viable(t + 1, opt.used, opt.opened, nleft)) continue;
          // 注意：前向可达集合刻意不用年龄走廊剪枝——它要保持与原算法一致的
          // 「最早断开帧间」语义；年龄不可行由后缀记忆化搜索另行剪枝，不应期
          // 阻断帧间则在归因阶段单独定位（归因只问「任意松弛解是否存在」，用
          // 轻量可行性 DFS 而非完整最优求解）。
          const k = fwdKey(opt.used, opt.opened, opt.ch, opt.gapAgeNext);
          const prev = next.get(k);
          // 同一状态保留更大漏检余额（后缀可行性只强不弱）
          if (!prev || nleft > prev.left) {
            next.set(k, {
              t: t + 1, live: opt.used, gaps: opt.opened, left: nleft,
              liveAge: opt.ch, gapAge: opt.gapAgeNext,
            });
          }
        }
      }
      reachAll.push(next);
      if (next.size === 0) {
        earliest = t;
        break;
      }
      earliest = t + 1;
      reach = next;
    }
    earliest = Math.min(earliest, F - 2);

    // 不应期归因：在松弛引擎（放行过早分裂）中，沿强制引擎的合法前缀，
    // 找最早「要继续就必须有支年龄不足而分裂」的帧间与母本。
    let refractoryBlock = null;
    if (refractoryEnabled && enforceRefractory) {
      // 轻量松弛可行性引擎：放行所有分裂，只判断「强制前缀后是否存在任意完整
      // 松弛谱系」，不做最优枚举（高密度不可行输入下也即时返回）。
      const relaxed = solveEngine(spec, false, true);
      if (relaxed.feasible) {
        // 前向推进在首个断帧处停止，归因只遍历已构造出的边界
        for (let t = 0; t < reachAll.length; t++) {
          // 同一母细胞可能以不同年龄到达（例如经漏检 +2），聚合取最成熟的到达，
          // 即报告「尚缺等待帧间」最少的候选。
          const bestAge = new Map();
          for (const st of reachAll[t].values()) {
            for (const opt of relaxed.expand(st.t, st.live, st.gaps, st.liveAge, st.gapAge)) {
              const openCount = popcnt(opt.opened);
              if (openCount > st.left) continue;
              const sub = relaxed.solve(t + 1, opt.used, opt.opened, st.left - openCount,
                opt.ch, opt.gapAgeNext);
              if (!sub) continue;
              // 母本全局序号在女儿向量中出现两次即本次分裂（不依赖引擎附带字段）
              const momCount = new Map();
              for (const j of bits(opt.used)) {
                momCount.set(opt.mom[j], (momCount.get(opt.mom[j]) || 0) + 1);
              }
              for (const [gm, c] of momCount) {
                if (c !== 2) continue;
                const age = st.liveAge[gm - offset[t]];
                if (age !== ROOT_AGE && age < refractory) {
                  bestAge.set(gm, Math.max(bestAge.get(gm) ?? -1, age));
                }
              }
            }
          }
          if (bestAge.size) {
            const cands = [...bestAge.entries()]
              .map(([gm, age]) => ({ gm, age, missing: refractory - age }))
              .sort((a, b) => a.missing - b.missing || a.gm - b.gm);
            refractoryBlock = { from: t, to: t + 1, ...cands[0] };
            break;
          }
        }
      }
    }

    return {
      feasible: false,
      earliestBreak: { from: earliest, to: earliest + 1 },
      refractoryBlock,
    };
  }

  // 沿最优链重建母女边；分裂年龄 / 代际 / 分裂事件随后沿边树推导。
  const edges = [];
  let node = root;
  while (node && node.pick) {
    const { t, used, mom } = node.pick;
    for (const j of bits(used)) {
      const g = mom[j];
      let mf = t;
      if (g < offset[t]) mf = t - 1; // 漏检补获母本来自帧 t-1
      const mi = g - offset[mf];
      const gap = mf === t - 1 ? 2 : 1;
      edges.push({
        from: g,
        to: gi(t + 1, j),
        gap,
        dist: Math.sqrt(d2(frames[mf][mi], frames[t + 1][j])),
      });
    }
    node = node.sub;
  }

  const usedPerFrame = Array.from({ length: F }, () => new Set());
  usedPerFrame[0].add(startIndex);
  for (const e of edges) {
    let t = 0;
    while (t + 1 < F && e.to >= offset[t + 1]) t++;
    usedPerFrame[t].add(e.to - offset[t]);
  }

  // 母本 → 出边（分裂恰两条，保持/漏检一条）
  const outEdges = new Map();
  for (const e of edges) {
    if (!outEdges.has(e.from)) outEdges.set(e.from, []);
    outEdges.get(e.from).push(e);
  }
  // 沿边树按目标帧序推导：分裂女儿年龄归零、代际 +1；保持 +1、漏检 +2、代际不变。
  const spotAges = new Map();
  const generation = new Map();
  const rootG = gi(0, startIndex);
  spotAges.set(rootG, null);
  generation.set(rootG, 1);
  for (const e of [...edges].sort((a, b) => a.to - b.to)) {
    const momAge = spotAges.get(e.from);
    const momGen = generation.get(e.from);
    if (outEdges.get(e.from).length === 2) {
      spotAges.set(e.to, 0);
      generation.set(e.to, momGen + 1);
    } else {
      spotAges.set(e.to, momAge === null ? null : momAge + e.gap);
      generation.set(e.to, momGen);
    }
  }
  // 分裂事件：母本、分裂时年龄（null 即起始细胞首次分裂）、女儿
  const splitEvents = [];
  for (const [from, list] of outEdges) {
    if (list.length === 2) splitEvents.push({ from, age: spotAges.get(from), tos: list.map((e) => e.to) });
  }
  splitEvents.sort((a, b) => a.from - b.from);

  return {
    feasible: true,
    root: gi(0, startIndex),
    totalBrightness: frames[0][startIndex].b + root.bright,
    skips: root.skips,
    survivors: target,
    edges,
    usedPerFrame: usedPerFrame.map((s) => [...s].sort((a, b) => a - b)),
    spotAges,
    generation,
    splitEvents,
    offset,
    // 暴露引擎闭包：松弛引擎（不强制不应期）归因时复用
    expand: (t, live, gaps, liveAge, gapAge) => expand(t, live, gaps, liveAge, gapAge),
    solve: (t, live, gaps, left, liveAge, gapAge) =>
      solve(t, live, gaps, left, liveAge, gapAge),
  };
}

/**
 * 求解谱系。
 * @returns {object} 可行时 {feasible:true, ...}；不可行时
 *   {feasible:false, earliestBreak:{from,to}, refractoryBlock:object|null}
 */
export function solveLineage(spec) {
  return solveEngine(spec, true);
}

/**
 * 将基于序号的解翻译成带 id 的 JSON 友好结构（页面与测试共用）。
 */
export function presentSolution(spec, result) {
  const { frames, refractoryEnabled, refractory } = spec;
  const F = frames.length;
  const offset = result.offset || (() => {
    const off = [0];
    for (let t = 1; t <= F; t++) off[t] = off[t - 1] + frames[t - 1].length;
    return off;
  })();
  const decode = (g) => {
    let t = 0;
    while (t + 1 < F && g >= offset[t + 1]) t++;
    return { t, i: g - offset[t] };
  };
  const refractoryInfo = { enabled: refractoryEnabled, threshold: refractoryEnabled ? refractory : null };

  if (!result.feasible) {
    const out = {
      feasible: false,
      refractory: refractoryInfo,
      earliestBreak: result.earliestBreak,
      earliestBreakLabel:
        `第 ${result.earliestBreak.from + 1} 帧 → 第 ${result.earliestBreak.to + 1} 帧`,
    };
    const blk = result.refractoryBlock;
    if (blk) {
      const mf = decode(blk.gm);
      out.refractoryBlock = {
        from: blk.from,
        to: blk.to,
        intervalLabel: `第 ${blk.from + 1} 帧 → 第 ${blk.to + 1} 帧`,
        motherFrame: mf.t,
        motherId: frames[mf.t][mf.i].id,
        motherLabel: `第 ${mf.t + 1} 帧·${frames[mf.t][mf.i].id}`,
        age: blk.age,
        missing: blk.missing,
      };
    }
    return out;
  }

  const childrenOf = new Map();
  const edges = result.edges.map((e) => {
    const mf = decode(e.from);
    const cf = decode(e.to);
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
    childrenOf.get(e.from).push(e.to);
    return {
      fromFrame: mf.t,
      fromId: frames[mf.t][mf.i].id,
      toFrame: cf.t,
      toId: frames[cf.t][cf.i].id,
      gap: e.gap,
      dist: Math.round(e.dist * 100) / 100,
    };
  });
  edges.sort((a, b) =>
    a.fromFrame - b.fromFrame ||
    a.toFrame - b.toFrame ||
    String(a.fromId).localeCompare(String(b.fromId)) ||
    String(a.toId).localeCompare(String(b.toId)));

  let divisions = 0;
  for (const list of childrenOf.values()) if (list.length === 2) divisions++;

  // 代际 / 分裂年龄由引擎沿边树推导（result.generation / result.spotAges）
  const spots = result.usedPerFrame.map((list, t) => list.map((i) => {
    const g = offset[t] + i;
    const age = result.spotAges.get(g) ?? null;
    return {
      id: frames[t][i].id,
      generation: result.generation.get(g),
      age, // null 表示起始支（首次分裂不受限）
      waitRemaining: refractoryEnabled && age !== null
        ? Math.max(0, refractory - age)
        : null,
    };
  }));

  // 分裂事件：母本、分裂时年龄、女儿
  const divisionEvents = result.splitEvents.map((ev) => {
    const mf = decode(ev.from);
    return {
      frame: mf.t,
      motherId: frames[mf.t][mf.i].id,
      motherAge: ev.age, // null 即起始细胞的首次分裂
      daughters: ev.tos.map((g) => {
        const cf = decode(g);
        return frames[cf.t][cf.i].id;
      }),
    };
  });

  return {
    feasible: true,
    refractory: refractoryInfo,
    totalBrightness: result.totalBrightness,
    skips: result.skips,
    survivors: result.survivors,
    divisions,
    divisionEvents,
    spots,
    counts: result.usedPerFrame.map((s) => s.length),
    used: result.usedPerFrame.map((list, t) => list.map((i) => frames[t][i].id)),
    edges,
  };
}

import fs from 'node:fs';
import path from 'node:path';

const lv = 'levels';
const beats = [];
for (const d of fs.readdirSync(lv)) {
  const dir = path.join(lv, d);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.beat.json')) continue;
    const p = path.join(dir, f);
    beats.push({ p, m: fs.statSync(p).mtimeMs });
  }
}
beats.sort((a, b) => b.m - a.m);

for (const { p } of beats) {
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = d.marks.map(x => x.time).sort((a, b) => a - b);
  const iv = [];
  for (let i = 1; i < m.length; i++) iv.push(m[i] - m[i - 1]);
  iv.sort((a, b) => a - b);
  const q = k => iv[Math.floor(iv.length * k)];
  const dur = d.audio.duration, bpm = d.timing.sections[0].bpm;

  console.log('────────────────────────────────────────');
  console.log(path.dirname(p));
  console.log(`踩音 ${m.length} 点 | ${dur.toFixed(1)}s | BPM ${bpm.toFixed(1)} | 密度 ${(m.length / dur).toFixed(2)} 个/秒`);
  console.log(`间隔: 最小 ${iv[0].toFixed(3)}s | 5% ${q(.05).toFixed(3)} | 25% ${q(.25).toFixed(3)} | 中位 ${q(.5).toFixed(3)} | 75% ${q(.75).toFixed(3)} | 最大 ${iv[iv.length - 1].toFixed(2)}s`);
  console.log(`最小间隔 = 1/${((60 / bpm) / iv[0]).toFixed(1)} 拍`);
  console.log('');
  console.log('线速 → 最短段 / 全长（线宽 1m，最短段 <1m 会重叠）');
  for (const v of [8, 10, 12, 14, 16, 18, 20, 26.6]) {
    const s = iv[0] * v, L = dur * v;
    const tag = s < 1 ? '✗ 重叠' : s < 1.5 ? '△ 勉强' : '✓     ';
    console.log(`  ${String(v).padStart(4)} m/s:  最短段 ${s.toFixed(2)}m  ${tag}  全长 ${L.toFixed(0)}m`);
  }
  console.log('');
}

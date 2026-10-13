/* agent-doc-check.mjs —— 检查 AGENT.md 是否跟上了最新提交。
 *
 * 为什么需要它：AGENT.md 开头就写着"每次改动项目后必须同步更新本文件"，但这靠自觉，
 * 2026-10-13 就发生过"连续 14 个提交没更新 AGENT.md"（发起人当场问起来才发现）。
 * 这个脚本把"自觉"变成"可检查"：只要 AGENT.md 落后于 HEAD，就红字提示 + 退出码 1。
 *
 * 用法：node tools/agent-doc-check.mjs
 *   - 落后 0 个提交 → 打印 OK，退出 0
 *   - 落后 N 个提交 → 打印那 N 条提交，退出 1
 * 建议每轮收尾时跑一次（提交前跑最合适）。
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8" }).trim();

let last;
try {
  last = git("log -1 --format=%H -- AGENT.md");
} catch {
  console.error("✗ 这里不是 git 仓库，或在仓库外运行");
  process.exit(2);
}

const behind = git(`log --oneline ${last}..HEAD`).split("\n").filter(Boolean);

if (behind.length === 0) {
  console.log("✓ AGENT.md 是最新的（落后 0 个提交）");
  process.exit(0);
}

console.error(`✗ AGENT.md 落后 ${behind.length} 个提交 —— 按约定必须先更新它（进度/决策/已知问题三节）：\n`);
for (const line of behind) console.error("   " + line);
console.error(`\n   最后改 AGENT.md 的提交：${git("log -1 --format='%h %ad %s' --date=format:'%m-%d %H:%M' -- AGENT.md")}`);
process.exit(1);

/* 只做语法检查：把 tools/SketchEditor.html 里的 <script> 抽出来喂给 vm 编译。
   为什么要单独一个脚本：PowerShell 读写会把中文注释/字符串写坏（AGENT.md §11 记过这个坑），
   所以用 node 自己读文件，全程 UTF-8，不经过 PowerShell 的字符串处理。 */
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync("tools/SketchEditor.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error("✗ 没找到 <script> 块"); process.exit(2); }
try {
  new vm.Script(m[1], { filename: "SketchEditor.html<script>" });
  console.log("✓ JS 语法通过（" + m[1].split("\n").length + " 行，含中文注释）");
} catch (e) {
  console.error("✗ 语法错误：" + e.message);
  process.exit(1);
}

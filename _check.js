// 页面校验：锚点对应 / id 唯一 / 标签配平 / data-opts JSON 合法
// 用法: node _check.js <html文件> [更多文件...]
const fs = require('fs');
let fail = 0;
for (const file of process.argv.slice(2)) {
  const s = fs.readFileSync(file, 'utf8');
  const errs = [];
  // id 唯一
  const ids = {};
  for (const m of s.matchAll(/\sid="([^"]+)"/g)) {
    ids[m[1]] = (ids[m[1]] || 0) + 1;
    if (ids[m[1]] === 2) errs.push(`重复 id: ${m[1]}`);
  }
  // 锚点对应
  const anchors = new Set();
  for (const m of s.matchAll(/href="#([^"]+)"/g)) anchors.add(m[1]);
  for (const a of anchors) if (!ids[a]) errs.push(`锚点无对应 id: #${a}`);
  // 标签配平
  for (const tag of ['section', 'div', 'main', 'aside', 'table', 'figure', 'details']) {
    const open = (s.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
    const close = (s.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) errs.push(`<${tag}> 不配平: ${open} 开 / ${close} 闭`);
  }
  // data-opts JSON
  for (const m of s.matchAll(/data-opts='((?:[^'\\]|\\.)*)'/g)) {
    try { JSON.parse(m[1]); } catch (e) { errs.push(`data-opts JSON 非法: ${m[1].slice(0, 60)}... (${e.message})`); }
  }
  if (errs.length) { fail++; console.log(`✗ ${file}`); errs.forEach(e => console.log(`   ${e}`)); }
  else console.log(`✓ ${file}`);
}
process.exit(fail ? 1 : 0);

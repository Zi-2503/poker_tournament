// 静态检查：脚本里引用到的 DOM id 必须存在于 index.html，避免运行时静默失败。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const html = readFileSync(join(root, "index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

const scripts = readdirSync(join(root, "js")).filter((name) => name.endsWith(".js"));
const referenced = new Map();
for (const name of scripts) {
  const source = readFileSync(join(root, "js", name), "utf8");
  for (const match of source.matchAll(/getElementById\("([^"]+)"\)|\$\("([^"]+)"\)/g)) {
    const id = match[1] || match[2];
    if (id.startsWith("#")) continue;
    if (!referenced.has(id)) referenced.set(id, new Set());
    referenced.get(id).add(name);
  }
}

const missing = [...referenced.entries()].filter(([id]) => !htmlIds.has(id));
if (missing.length) {
  for (const [id, files] of missing) console.error(`缺少 DOM id "${id}"（被 ${[...files].join(", ")} 引用）`);
  process.exit(1);
}

const unused = [...htmlIds].filter((id) => !referenced.has(id));
console.log(`DOM 检查通过：${referenced.size} 个 id 全部存在`);
if (unused.length) console.log(`提示：index.html 中未被脚本引用的 id：${unused.join(", ")}`);

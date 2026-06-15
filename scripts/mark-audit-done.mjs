// Flip backlog checkboxes for given IDs from "- [ ] **ID " to "- [x] **ID ".
import { readFileSync, writeFileSync } from "node:fs";
const p = "docs/AUDIT-2026-06-15.md";
const ids = process.argv.slice(2);
let s = readFileSync(p, "utf8");
let n = 0;
for (const id of ids) {
  const from = `- [ ] **${id} `;
  const to = `- [x] **${id} `;
  if (s.includes(from)) { s = s.split(from).join(to); n++; }
}
writeFileSync(p, s, "utf8");
console.log(`checked ${n}/${ids.length} items`);

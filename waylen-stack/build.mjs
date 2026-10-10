import { transformSync } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "dist";
const SKIP = new Set(["dist", "node_modules", "supabase", "api", ".vercel", "build.mjs", "package.json", "package-lock.json", "vercel.json", ".gitignore"]);

const js = (s) => transformSync(s, { loader: "js", minify: true, charset: "utf8", legalComments: "none" }).code.trim();
const css = (s) => transformSync(s, { loader: "css", minify: true, charset: "utf8", legalComments: "none" }).code.trim();

function html(src) {
  const parts = [];
  const keep = (s) => "\u0000" + (parts.push(s) - 1) + "\u0000";
  src = src.replace(/<!--(?!\[if)[\s\S]*?-->/g, "");
  src = src.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (a, o, b, c) => keep(o + css(b) + c));
  src = src.replace(/(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/g, (a, o, b, c) => {
    if (!b.trim()) return keep(a);
    if (/type="application\/(ld\+)?json"/.test(o)) return keep(o + JSON.stringify(JSON.parse(b)) + c);
    return keep(o + js(b) + c);
  });
  src = src.replace(/<(pre|textarea)[\s\S]*?<\/\1>/g, (a) => keep(a));
  src = src.replace(/\n\s*/g, "\n");
  return src.replace(/\u0000(\d+)\u0000/g, (a, i) => parts[Number(i)]);
}

function walk(dir, rel = "") {
  for (const name of readdirSync(dir)) {
    if (!rel && (SKIP.has(name) || name.startsWith("."))) continue;
    const from = join(dir, name), to = join(OUT, rel, name);
    if (statSync(from).isDirectory()) { mkdirSync(to, { recursive: true }); walk(from, join(rel, name)); }
    else if (name.endsWith(".html")) writeFileSync(to, html(readFileSync(from, "utf8")));
    else cpSync(from, to);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
walk(".");

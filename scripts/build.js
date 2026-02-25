#!/usr/bin/env node
/**
 * scripts/build.js
 *
 * 扫描 public/ 下所有含 index.html 的一级子目录，
 * 生成静态首页 public/index.html。
 *
 * Cloudflare Pages 配置：
 *   Build command:    node scripts/build.js
 *   Output directory: public
 */

import { readdirSync, existsSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT    = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC  = join(ROOT, "public");   // ← 静态资源根目录，按需修改
const OUT     = join(PUBLIC, "index.html");

// ── 自定义每个子站点的标题 / 描述 / 图标 ────────────────────────────────────
// key = 子目录名，未配置的目录自动生成
const SITES = {
  // "docs":  { title: "文档中心",  desc: "API 参考与使用指南",  icon: "📖" },
  // "blog":  { title: "技术博客",  desc: "研究笔记与技术分享",  icon: "✍️"  },
  // "demo":  { title: "在线演示",  desc: "交互式 Demo",         icon: "🚀" },
};

// ── 首页标题 ─────────────────────────────────────────────────────────────────
const META = {
  title:    "项目导航",
  subtitle: "选择一个子站点开始浏览",
};

// ── 默认图标池（自动分配） ───────────────────────────────────────────────────
const ICONS = ["🗂️","📦","🔧","🌐","📊","🎯","💡","🛠️","📡","🔬","🧩","🖥️"];

// ── 扫描目录 ─────────────────────────────────────────────────────────────────
function scan() {
  const dirs = readdirSync(PUBLIC, { withFileTypes: true })
    .filter(e =>
      e.isDirectory() &&
      !e.name.startsWith("_") &&
      !e.name.startsWith(".") &&
      existsSync(join(PUBLIC, e.name, "index.html"))
    )
    .map(e => e.name)
    .sort();

  return dirs.map((name, i) => {
    const cfg = SITES[name] || {};
    return {
      path:  name,
      title: cfg.title || name.charAt(0).toUpperCase() + name.slice(1),
      desc:  cfg.desc  || `/${name}/`,
      icon:  cfg.icon  || ICONS[i % ICONS.length],
    };
  });
}

// ── 生成 HTML ─────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])
  );
}

function render(subsites) {
  const cards = subsites.map(({ path, title, desc, icon }, i) => `
        <a class="card" href="/${esc(path)}/" style="animation-delay:${0.06 * i}s">
          <div class="icon">${icon}</div>
          <div class="body">
            <h2>${esc(title)}</h2>
            <p>${esc(desc)}</p>
          </div>
          <span class="arrow">→</span>
        </a>`).join("");

  const empty = `
        <div class="empty">
          <div style="font-size:3rem;margin-bottom:16px">📂</div>
          <p>public/ 下暂无含 index.html 的子目录</p>
        </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(META.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0d0f14;--surface:#13161e;--border:#1e2330;--accent:#5b8bff;--text:#e8eaf0;--muted:#6b7280}
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;flex-direction:column;overflow-x:hidden}
    body::before{content:'';position:fixed;inset:0;pointer-events:none;
      background:radial-gradient(ellipse 80% 60% at 20% -10%,rgba(91,139,255,.15),transparent 60%),
                 radial-gradient(ellipse 60% 50% at 80% 110%,rgba(255,107,107,.10),transparent 55%)}
    .wrap{position:relative;z-index:1;max-width:880px;margin:0 auto;padding:0 24px;flex:1}
    header{padding:72px 0 48px;text-align:center}
    .badge{display:inline-block;padding:4px 14px;margin-bottom:20px;background:rgba(91,139,255,.15);border:1px solid rgba(91,139,255,.3);border-radius:999px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);font-family:'Syne',sans-serif}
    h1{font-family:'Syne',sans-serif;font-weight:800;font-size:clamp(1.8rem,5vw,3rem);line-height:1.1;letter-spacing:-.02em;background:linear-gradient(135deg,#fff 30%,var(--accent) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:12px}
    .sub{color:var(--muted);font-size:1rem;font-weight:300}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:14px;padding-bottom:72px}
    .card{display:flex;align-items:center;gap:14px;padding:20px 18px;background:var(--surface);border:1px solid var(--border);border-radius:14px;text-decoration:none;color:inherit;position:relative;overflow:hidden;transition:border-color .2s,transform .2s,box-shadow .2s;animation:up .4s ease both}
    .card:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 10px 36px rgba(91,139,255,.15)}
    .card::after{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(91,139,255,.05),transparent 60%);opacity:0;transition:opacity .2s}
    .card:hover::after{opacity:1}
    .icon{font-size:1.8rem;flex-shrink:0;width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.04);border-radius:10px}
    .body{flex:1;min-width:0}
    .body h2{font-family:'Syne',sans-serif;font-size:.95rem;font-weight:700;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .body p{font-size:.8rem;color:var(--muted);line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .arrow{color:var(--muted);flex-shrink:0;transition:color .2s,transform .2s}
    .card:hover .arrow{color:var(--accent);transform:translateX(4px)}
    .empty{text-align:center;padding:72px 0;color:var(--muted)}
    footer{position:relative;z-index:1;text-align:center;padding:20px;border-top:1px solid var(--border);font-size:.78rem;color:var(--muted)}
    @keyframes up{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
    @media(max-width:480px){header{padding:48px 0 32px}.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="badge">项目导航</div>
      <h1>${esc(META.title)}</h1>
      <p class="sub">${esc(META.subtitle)}</p>
    </header>
    <main>
      ${subsites.length ? `<div class="grid">${cards}\n      </div>` : empty}
    </main>
  </div>
  <footer>Powered by Cloudflare Pages · ${new Date().getFullYear()}</footer>
</body>
</html>`;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const subsites = scan();
writeFileSync(OUT, render(subsites), "utf-8");

console.log(`✅  生成 ${OUT}`);
console.log(`   共 ${subsites.length} 个子站点：`);
subsites.forEach(s => console.log(`   · /${s.path}/  →  ${s.title}`));

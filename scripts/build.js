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
const PUBLIC  = join(ROOT, "public");
const OUT     = join(PUBLIC, "index.html");

// ── 子站点特定配置 ──────────────────────────────────────────────────────────
const SITES = {
  "codewiki-docs": { 
    title: "CodeWiki Engine", 
    desc: "全自动代码分析与知识图谱生成引擎文档，深入理解系统架构与依赖关系。", 
    icon: "🧬",
    color: "#6366f1" 
  },
  "loki-mode-docs": { 
    title: "Loki Mode", 
    desc: "自治代理启动系统：从 PRD 到部署的端到端自动化，AI 驱动的开发新范式。", 
    icon: "🔥",
    color: "#f43f5e" 
  },
  "deer-flow-docs": { 
    title: "Deer Flow", 
    desc: "轻量级工作流编排与任务调度系统，支持复杂任务的有向无环图 (DAG) 编排。", 
    icon: "🦌",
    color: "#10b981" 
  },
  "zeptoclaw-docs": { 
    title: "ZeptoClaw", 
    desc: "高性能分布式爬虫与数据采集框架，极致的抓取效率与灵活的管道处理。", 
    icon: "🦀",
    color: "#f59e0b" 
  }
};

const META = {
  title: "Code Wiki Hub",
  subtitle: "探索代码深处的知识图谱，构建结构化的技术洞察。",
};

const ICONS = ["📚", "🛠️", "🌐", "🔍", "⚙️", "🧪"];

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
      title: cfg.title || name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '),
      desc:  cfg.desc  || `Technical documentation for ${name}. Explore modules, dependencies, and API references.`,
      icon:  cfg.icon  || ICONS[i % ICONS.length],
      color: cfg.color || "#6366f1"
    };
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])
  );
}

function render(subsites) {
  const cards = subsites.map(({ path, title, desc, icon, color }, i) => `
    <a class="card" href="/${esc(path)}/" style="--accent: ${color}; animation-delay: ${i * 0.1}s">
      <div class="card-glow"></div>
      <div class="card-content">
        <div class="icon-wrapper">
          <span class="icon">${icon}</span>
        </div>
        <div class="text">
          <h2>${esc(title)}</h2>
          <p>${esc(desc)}</p>
        </div>
        <div class="footer-link">
          <span>阅读文档</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
        </div>
      </div>
    </a>`).join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${esc(META.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg: #020617;
      --card-bg: rgba(15, 23, 42, 0.6);
      --card-hover: rgba(30, 41, 59, 0.8);
      --border: rgba(255, 255, 255, 0.05);
      --border-hover: rgba(255, 255, 255, 0.15);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.12) 0px, transparent 45%),
        radial-gradient(at 100% 0%, rgba(244, 63, 94, 0.08) 0px, transparent 40%),
        radial-gradient(at 50% 100%, rgba(16, 185, 129, 0.05) 0px, transparent 50%);
      color: var(--text-main);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      line-height: 1.6;
      overflow-x: hidden;
    }

    .container {
      max-width: 1300px;
      margin: 0 auto;
      padding: 100px 32px;
    }

    header {
      text-align: center;
      margin-bottom: 100px;
    }

    .brand-tag {
      display: inline-block;
      padding: 8px 20px;
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.15));
      border: 1px solid rgba(168, 85, 247, 0.2);
      border-radius: 100px;
      color: #a5b4fc;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 32px;
    }

    h1 {
      font-size: clamp(2.8rem, 8vw, 4.5rem);
      font-weight: 900;
      letter-spacing: -0.04em;
      margin-bottom: 24px;
      background: linear-gradient(to bottom, #fff, #94a3b8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      line-height: 1;
    }

    header p {
      color: var(--text-muted);
      font-size: 1.25rem;
      max-width: 650px;
      margin: 0 auto;
      font-weight: 400;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 32px;
    }

    .card {
      position: relative;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 32px;
      padding: 48px 40px;
      text-decoration: none;
      color: inherit;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      backdrop-filter: blur(20px);
      animation: fadeIn 0.8s ease backwards;
      min-height: 320px;
    }

    .card:hover {
      transform: translateY(-12px) scale(1.02);
      border-color: var(--border-hover);
      background: var(--card-hover);
      box-shadow: 0 40px 80px -20px rgba(0, 0, 0, 0.6);
    }

    .card-glow {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at var(--mouse-x, 50%) var(--mouse-y, 50%), var(--accent), transparent 100%);
      opacity: 0;
      transition: opacity 0.6s;
      pointer-events: none;
      filter: blur(80px);
    }

    .card:hover .card-glow { opacity: 0.2; }

    .icon-wrapper {
      width: 64px;
      height: 64px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 32px;
      font-size: 32px;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3);
    }

    .card:hover .icon-wrapper {
      transform: scale(1.15) rotate(-8deg);
      background: var(--accent);
      border-color: transparent;
      box-shadow: 0 20px 40px -10px var(--accent);
      color: white;
    }

    .text h2 {
      font-size: 1.6rem;
      font-weight: 800;
      margin-bottom: 16px;
      color: #fff;
      letter-spacing: -0.02em;
    }

    .text p {
      color: var(--text-muted);
      font-size: 1rem;
      line-height: 1.7;
      margin-bottom: 32px;
    }

    .footer-link {
      margin-top: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 15px;
      color: var(--text-main);
      letter-spacing: 0.02em;
    }

    .footer-link span {
      position: relative;
    }

    .footer-link span::after {
      content: '';
      position: absolute;
      bottom: -4px;
      left: 0;
      width: 0;
      height: 2px;
      background: var(--accent);
      transition: width 0.3s;
    }

    .card:hover .footer-link span::after {
      width: 100%;
    }

    .footer-link svg {
      transition: transform 0.3s;
      color: var(--accent);
    }

    .card:hover .footer-link svg {
      transform: translateX(6px);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    footer {
      text-align: center;
      padding: 60px 24px;
      color: var(--text-muted);
      font-size: 14px;
      border-top: 1px solid var(--border);
      margin-top: 80px;
    }

    @media (max-width: 640px) {
      .container { padding: 40px 20px; }
      h1 { font-size: 2.2rem; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
  <script>
    document.addEventListener('mousemove', (e) => {
      document.querySelectorAll('.card').forEach(card => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        card.style.setProperty('--mouse-x', x + 'px');
        card.style.setProperty('--mouse-y', y + 'px');
      });
    });
  </script>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand-tag">Project Portal</div>
      <h1>${esc(META.title)}</h1>
      <p>${esc(META.subtitle)}</p>
    </header>
    <main>
      <div class="grid">${cards || '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted)">暂无可用项目</div>'}</div>
    </main>
  </div>
  <footer>
    &copy; ${new Date().getFullYear()} DengQi. Built with CodeWiki Engine.
  </footer>
</body>
</html>`;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const subsites = scan();

writeFileSync(OUT, render(subsites), "utf-8");

console.log(`✅  生成 ${OUT}`);
console.log(`   共 ${subsites.length} 个子站点`);
subsites.forEach(s => console.log(`   · /${s.path}/  →  ${s.title}`));

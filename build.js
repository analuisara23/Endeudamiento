// Genera la versión protegida de los HTML del repositorio en la carpeta "dist".
// Cloudflare Pages ejecuta este script en cada publicación (comando: npm run build).
// Los archivos originales del repositorio NO se modifican.
const fs = require('fs');
const path = require('path');
const { minify } = require('html-minifier-terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const SKIP = new Set(['node_modules', 'dist', '.git', '.github']);
const SKIP_FILES = new Set(['build.js', 'package.json', 'package-lock.json', 'README_PROTECCION.md']);

const OBF = {
  compact: true,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 1,
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
};

// Bloqueos + marca de agua. Se inyecta antes de </body>.
const PROTECCION = `
<style>
body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
input,textarea,select{-webkit-user-select:text;user-select:text}
@media print{body{display:none!important}}
.wm-interno{position:fixed;inset:0;pointer-events:none;z-index:2147483647;opacity:.10;background-repeat:repeat}
</style>
<script>
(function(){
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); });
  ['copy','cut','dragstart'].forEach(function(ev){ document.addEventListener(ev, function(e){ e.preventDefault(); }); });
  document.addEventListener('keydown', function(e){
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['c','x','s','p','u','a'].indexOf(k) > -1) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i','j','c'].indexOf(k) > -1) e.preventDefault();
    if (e.key === 'F12') e.preventDefault();
  });
  function marca(texto){
    var t = String(texto).replace(/[<>&"']/g, '');
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='380' height='220'><text x='30' y='120' transform='rotate(-25 190 110)' font-family='sans-serif' font-size='15' fill='#888'>" + t + "</text></svg>";
    var d = document.createElement('div');
    d.className = 'wm-interno';
    d.style.backgroundImage = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")';
    document.body.appendChild(d);
  }
  marca('Estrategia y Analítica de Negocios');
})();
</script>`;

function walk(dir, list = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, list);
    else if (!(dir === ROOT && SKIP_FILES.has(name))) list.push(full);
  }
  return list;
}

function obfuscate(code) {
  return JavaScriptObfuscator.obfuscate(code, OBF).getObfuscatedCode();
}

const OBF_LOADER = Object.assign({}, OBF, { splitStrings: false, numbersToExpressions: false, transformObjectKeys: false });

async function protectHtml(html) {
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, PROTECCION + '\n</body>') : html + PROTECCION;
  // 1) Minifica todo (HTML + CSS)
  html = await minify(html, { collapseWhitespace: true, removeComments: true, minifyCSS: true, minifyJS: false });

  // 2) Separa piezas: estilos, scripts (en orden) y el cuerpo sin scripts
  const headM = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  let head = headM ? headM[1] : '';
  const bodyM = html.match(/<body([^>]*)>([\s\S]*)<\/body>/i);
  const bodyAttrs = bodyM ? bodyM[1] : '';
  let body = bodyM ? bodyM[2] : html;
  const htmlAttrs = (html.match(/<html([^>]*)>/i) || ['', ''])[1];

  let css = '';
  const scripts = [];
  const takeStyles = s => s.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, c) => { css += c; return ''; });
  const takeScripts = s => s.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (m, attrs = '', code) => {
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) scripts.push({ src });
    else if (/type\s*=\s*["']?(application\/(ld\+)?json|text\/template)/i.test(attrs)) return m;
    else if (code.trim()) scripts.push({ code: obfuscate(code) });
    return '';
  });
  head = takeScripts(takeStyles(head));
  body = takeScripts(takeStyles(body));
  // Lo que queda en <head> (title, meta, links de fuentes) se mantiene visible; no contiene datos
  const keepHead = head;

  // 3) Cargador: el diseño, el contenido y el código viajan cifrados y se arman en el navegador
  const loader = `(function(){
    var c=${JSON.stringify(css)},b=${JSON.stringify(body)},L=${JSON.stringify(scripts)};
    var st=document.createElement('style');st.textContent=c;document.head.appendChild(st);
    document.body.innerHTML=b;
    (function run(i){ if(i>=L.length) return; var s=document.createElement('script');
      if(L[i].src){ s.src=L[i].src; s.onload=s.onerror=function(){run(i+1)}; document.body.appendChild(s); }
      else { s.text=L[i].code; document.body.appendChild(s); run(i+1); } })(0);
  })();`;
  const shell = `<!doctype html><html${htmlAttrs}><head>${keepHead}</head><body${bodyAttrs}><noscript>Este análisis requiere JavaScript.</noscript><script>${JavaScriptObfuscator.obfuscate(loader, OBF_LOADER).getObfuscatedCode()}</script></body></html>`;
  return shell;
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const files = walk(ROOT);
  let n = 0;
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (/\.html?$/i.test(f)) {
      fs.writeFileSync(dest, await protectHtml(fs.readFileSync(f, 'utf8')));
      n++;
      console.log('Protegido:', rel);
    } else if (/\.js$/i.test(f)) {
      fs.writeFileSync(dest, obfuscate(fs.readFileSync(f, 'utf8')));
      console.log('Ofuscado:', rel);
    } else {
      fs.copyFileSync(f, dest);
    }
  }
  if (!n) { console.error('No se encontró ningún archivo HTML.'); process.exit(1); }
  console.log(`Listo: ${n} HTML protegido(s) en /dist`);
})().catch(e => { console.error(e); process.exit(1); });

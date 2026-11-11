// Маленький безопасный Markdown для текстов уровней.
// Поддерживает: абзацы, блоки ``` ```, `код`, **жирный**, *курсив*. Всё остальное — обычный текст.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  // Сначала вырезаем `код`, чтобы * внутри него не превращались в курсив.
  const parts = s.split(/(`[^`]+`)/g);
  return parts
    .map((p) => {
      if (/^`[^`]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    })
    .join('');
}

export function renderMarkdown(src) {
  const out = [];
  const blocks = src.split(/```/);
  blocks.forEach((b, i) => {
    if (i % 2 === 1) {
      out.push(`<pre class="snippet"><code>${esc(b.replace(/^\n/, '').replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    for (const para of b.split(/\n\s*\n/)) {
      const t = para.trim();
      if (t) out.push(`<p>${inline(t).replace(/\n/g, '<br>')}</p>`);
    }
  });
  return out.join('');
}

// extract_design_tokens.js
// Run in the target page to get a JSON design-token summary.
//   - Playwright MCP: pass the whole function below as the `browser_evaluate` `function` arg.
//   - Playwright script: `await page.evaluate(<this function>)`.
//   - DevTools console: paste and call it.
// Reads computed styles only (no asset scraping). Ranks values by frequency, so the top
// entries approximate the site's real design system.

() => {
  const MAX_ELEMENTS = 6000;
  const els = Array.from(document.querySelectorAll('*')).slice(0, MAX_ELEMENTS);
  const tally = {};
  const bump = (cat, val) => {
    if (val == null) return;
    val = String(val).trim();
    if (!val || ['none', 'normal', 'auto', '0px', '0'].includes(val)) return;
    (tally[cat] = tally[cat] || {})[val] = (tally[cat][val] || 0) + 1;
  };
  const visibleColor = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';

  for (const el of els) {
    const s = getComputedStyle(el);
    if (visibleColor(s.color)) bump('text_colors', s.color);
    if (visibleColor(s.backgroundColor)) bump('background_colors', s.backgroundColor);
    if (visibleColor(s.borderTopColor) && parseFloat(s.borderTopWidth) > 0) {
      bump('border_colors', s.borderTopColor);
    }
    bump('font_families', s.fontFamily);
    bump('font_sizes', s.fontSize);
    bump('font_weights', s.fontWeight);
    bump('line_heights', s.lineHeight);
    bump('letter_spacing', s.letterSpacing);
    bump('border_radius', s.borderRadius);
    if (s.boxShadow && s.boxShadow !== 'none') bump('shadows', s.boxShadow);
  }

  // Spacing scale from padding/margin (first 2000 els is plenty)
  for (const el of els.slice(0, 2000)) {
    const s = getComputedStyle(el);
    ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
     'marginTop', 'marginRight', 'marginBottom', 'marginLeft'].forEach((p) => {
      const v = s[p];
      if (v && v.endsWith('px') && parseFloat(v) > 0) bump('spacing', v);
    });
  }

  // :root CSS custom properties (a site's declared token set, if any)
  const rootVars = {};
  try {
    const rs = getComputedStyle(document.documentElement);
    for (let i = 0; i < rs.length; i++) {
      const prop = rs[i];
      if (prop.startsWith('--')) rootVars[prop] = rs.getPropertyValue(prop).trim();
    }
  } catch (e) { /* ignore */ }

  const topN = (cat, n) =>
    Object.entries(tally[cat] || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([value, count]) => ({ value, count }));

  return {
    url: location.href,
    title: document.title,
    sampled_elements: els.length,
    palette: {
      text: topN('text_colors', 12),
      background: topN('background_colors', 12),
      border: topN('border_colors', 10),
    },
    typography: {
      families: topN('font_families', 8),
      sizes: topN('font_sizes', 14),
      weights: topN('font_weights', 8),
      line_heights: topN('line_heights', 8),
      letter_spacing: topN('letter_spacing', 6),
    },
    spacing_scale: topN('spacing', 16),
    radii: topN('border_radius', 10),
    shadows: topN('shadows', 8),
    css_variables: rootVars,
    meta: {
      viewport: (document.querySelector('meta[name=viewport]') || {}).content || null,
      lang: document.documentElement.lang || null,
    },
  };
}

'use strict';
// Motor de temas: carregado no <head> para aplicar as cores antes da página aparecer (sem "piscar").
(function () {
  // Cada tema tem uma paleta escura e uma clara:
  // bg, deep (topo), panel (barra lateral/cartões), raised (botões), input, line, text, dim, bright, accent, play
  const P = (bg, deep, panel, raised, input, line, text, dim, bright, accent, play) =>
    ({ bg, deep, panel, raised, input, line, text, dim, bright, accent, play });

  const THEMES = {
    steam: {
      label: 'Steam',
      dark: P('#1b2838', '#171a21', '#202d39', '#2a3f54', '#0e141b', '#2f4256', '#c7d5e0', '#8f98a0', '#ffffff', '#66c0f4', '#6aa621'),
      light: P('#eef3f7', '#dfe7ee', '#e6edf3', '#d3dee8', '#ffffff', '#c3d1dd', '#26384a', '#5f7184', '#0d1b2a', '#1a8ad4', '#4f8a10'),
    },
    midnight: {
      label: 'Meia-noite',
      dark: P('#000000', '#000000', '#0a0a0c', '#18181c', '#0d0d10', '#222228', '#d4d4d8', '#8a8a93', '#ffffff', '#a78bfa', '#22c55e'),
      light: P('#fafafa', '#f0f0f2', '#f4f4f5', '#e4e4e7', '#ffffff', '#d4d4d8', '#27272a', '#71717a', '#09090b', '#7c3aed', '#16a34a'),
    },
    nord: {
      label: 'Nórdico',
      dark: P('#2e3440', '#242933', '#3b4252', '#434c5e', '#272c36', '#4c566a', '#d8dee9', '#9aa5b8', '#eceff4', '#88c0d0', '#a3be8c'),
      light: P('#eceff4', '#e5e9f0', '#e5e9f0', '#d8dee9', '#ffffff', '#cbd3e1', '#3b4252', '#6b7689', '#2e3440', '#5e81ac', '#6f9a4f'),
    },
    dracula: {
      label: 'Drácula',
      dark: P('#282a36', '#1e1f29', '#2f3242', '#44475a', '#21222c', '#44475a', '#e2e2e6', '#9ea3c0', '#f8f8f2', '#bd93f9', '#50c878'),
      light: P('#f8f8f2', '#efeee6', '#f1f0ea', '#e3e1d8', '#ffffff', '#d6d3c8', '#3a3c4e', '#6c6f85', '#1e1f29', '#9a5cf0', '#2f9e55'),
    },
    synthwave: {
      label: 'Synthwave',
      dark: P('#1a1033', '#120a24', '#231546', '#2f1d5c', '#140c29', '#3b2770', '#e6dcff', '#a597cf', '#ffffff', '#ff4fd8', '#2de2a6'),
      light: P('#fbf5ff', '#f2e8fb', '#f6eefc', '#ead9f7', '#ffffff', '#dcc5ee', '#3a2257', '#7a6596', '#1c0d33', '#d6249f', '#0f9e72'),
    },
    forest: {
      label: 'Floresta',
      dark: P('#14201a', '#0e1712', '#1a2a21', '#24392c', '#0c140f', '#2c4535', '#d3e4d8', '#8ea597', '#f2fff6', '#4ade80', '#4ade80'),
      light: P('#f2f7f3', '#e6efe8', '#ebf3ed', '#d9e8dd', '#ffffff', '#c5d9ca', '#22362a', '#5c7464', '#0f1d14', '#16a34a', '#15803d'),
    },
    amber: {
      label: 'Retrô Âmbar',
      dark: P('#1c1814', '#14110e', '#241f1a', '#332b23', '#120f0c', '#3f352a', '#ecdcc8', '#a8957e', '#fff7ec', '#f59e0b', '#84cc16'),
      light: P('#fbf6ee', '#f3eadb', '#f6efe3', '#eadfcc', '#ffffff', '#dccfb8', '#3d3024', '#7d6a55', '#1e160e', '#c2710c', '#4d7c0f'),
    },
    ocean: {
      label: 'Oceano',
      dark: P('#0b1a24', '#07121a', '#10232f', '#17323f', '#06111a', '#1f3f4f', '#cfe6ef', '#86a6b3', '#ffffff', '#22d3ee', '#34d399'),
      light: P('#f0f8fb', '#e2f0f5', '#e8f4f8', '#d3e8f0', '#ffffff', '#bfdbe6', '#1d3a47', '#557685', '#08202b', '#0891b2', '#059669'),
    },
  };

  const FONTS = {
    system: { label: 'Sistema', css: '"Segoe UI", Roboto, Arial, sans-serif' },
    inter: { label: 'Inter', css: 'Inter, "Segoe UI", sans-serif', google: 'Inter:wght@400;500;600;700;800' },
    poppins: { label: 'Poppins', css: 'Poppins, "Segoe UI", sans-serif', google: 'Poppins:wght@400;500;600;700' },
    nunito: { label: 'Nunito', css: 'Nunito, "Segoe UI", sans-serif', google: 'Nunito:wght@400;600;700;800' },
    rajdhani: { label: 'Rajdhani', css: 'Rajdhani, "Segoe UI", sans-serif', google: 'Rajdhani:wght@500;600;700' },
    orbitron: { label: 'Orbitron', css: 'Orbitron, "Segoe UI", sans-serif', google: 'Orbitron:wght@400;600;800' },
  };

  const ACCENTS = ['#66c0f4', '#3b82f6', '#a78bfa', '#ff4fd8', '#f43f5e', '#f97316', '#f59e0b', '#4ade80', '#22d3ee', '#e5e7eb'];

  const DEFAULT = {
    preset: 'steam', mode: 'dark', accent: '', font: 'system', radius: 4,
    glass: false, ambient: false, animations: true, density: 'comfortable', hover: 'lift',
  };

  // Combinações prontas ("estilos rápidos").
  const STYLES = {
    classic: { label: 'Clássico', icon: '🎮', desc: 'Visual da Steam', cfg: { ...DEFAULT } },
    modern: {
      label: 'Moderno', icon: '✨', desc: 'Vidro, arte de fundo, cantos arredondados',
      cfg: { preset: 'midnight', mode: 'dark', accent: '#3b82f6', font: 'inter', radius: 12, glass: true, ambient: true, animations: true, density: 'comfortable', hover: 'lift' },
    },
    minimal: {
      label: 'Minimalista', icon: '◻️', desc: 'Claro, limpo e compacto',
      cfg: { preset: 'midnight', mode: 'light', accent: '', font: 'inter', radius: 8, glass: false, ambient: false, animations: true, density: 'compact', hover: 'none' },
    },
    neon: {
      label: 'Neon', icon: '🌆', desc: 'Synthwave com brilho',
      cfg: { preset: 'synthwave', mode: 'dark', accent: '', font: 'rajdhani', radius: 10, glass: true, ambient: true, animations: true, density: 'comfortable', hover: 'glow' },
    },
  };

  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  let current = normalize(window.LUDO_THEME);

  function normalize(cfg) {
    const c = { ...DEFAULT, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
    if (!THEMES[c.preset]) c.preset = DEFAULT.preset;
    if (!FONTS[c.font]) c.font = DEFAULT.font;
    if (!['dark', 'light', 'system'].includes(c.mode)) c.mode = DEFAULT.mode;
    if (!/^#[0-9a-f]{6}$/i.test(c.accent || '')) c.accent = '';
    c.radius = Math.min(20, Math.max(0, Number(c.radius) || 0));
    return c;
  }

  const isLight = (cfg) => cfg.mode === 'light' || (cfg.mode === 'system' && mq.matches);

  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function palette(cfg) {
    return THEMES[cfg.preset][isLight(cfg) ? 'light' : 'dark'];
  }

  function loadFont(key) {
    const font = FONTS[key];
    let link = document.getElementById('themeFont');
    if (!font.google) { link?.remove(); return; }
    const href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
    if (link?.getAttribute('href') === href) return;
    if (!link) {
      link = document.createElement('link');
      link.id = 'themeFont';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = href;
  }

  function apply(cfg) {
    current = normalize(cfg);
    const p = palette(current);
    const accent = current.accent || p.accent;
    const vars = {
      '--bg': p.bg, '--bg-deep': p.deep, '--bg-panel': p.panel, '--bg-raised': p.raised, '--bg-input': p.input,
      '--line': p.line, '--text': p.text, '--text-dim': p.dim, '--text-bright': p.bright,
      '--accent': accent, '--on-accent': luminance(accent) > 0.45 ? '#0b0f14' : '#ffffff', '--play': p.play,
      '--radius': `${current.radius}px`, '--font': FONTS[current.font].css,
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    const flag = (name, on) => (on ? root.setAttribute(name, '') : root.removeAttribute(name));
    flag('data-light', isLight(current));
    flag('data-glass', current.glass);
    flag('data-ambient', current.ambient);
    flag('data-noanim', !current.animations);
    root.dataset.density = current.density;
    root.dataset.hover = current.hover;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', p.deep);
    loadFont(current.font);
    return current;
  }

  mq.addEventListener('change', () => { if (current.mode === 'system') apply(current); });

  window.Theme = {
    THEMES, FONTS, ACCENTS, STYLES, DEFAULT,
    apply,
    get: () => ({ ...current }),
    isLight: () => isLight(current),
    paletteOf: (preset) => THEMES[preset][isLight(current) ? 'light' : 'dark'],
  };
  apply(current);
})();

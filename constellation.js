// YouTube Study Time - the constellation, the visual for topic mastery.
//
// renderConstellation(container, topics) draws each topic as a star on a night sky;
// twinkle(topicKey) makes one star twinkle. It only reads the topic summaries from
// stats.js ({ key, topic, totalMin, firstAt, level, levelInfo }), so another theme
// (bookshelf, skyline, ...) can replace this file without touching storage.
// Plain SVG, no libraries. Original artwork.

const SKY_WIDTH = 800;
const SKY_HEIGHT = 380;
const SKY_MARGIN = 40;
const MIN_STAR_GAP = 72; // preferred distance between stars, in SVG units
const LABEL_ALL_UNDER = 15; // with more topics than this, only level 3+ stars get a label
const SVG_NS = 'http://www.w3.org/2000/svg';

let selectedStar = null; // topic key whose details stay open after a click

function svg(tag, attributes = {}, ...children) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

// FNV-1a: a stable number from a string.
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32: a small seeded random generator, so the sky looks the same every time.
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gives every topic an { x, y }. Topics are placed oldest first, each from its own
// seed, so a star keeps its place when new topics appear. Each tries a few spots
// and takes the first one far enough from the others (or the roomiest it found).
function placeStars(topics) {
  const ordered = [...topics].sort((a, b) => a.firstAt - b.firstAt || a.key.localeCompare(b.key));
  const placed = [];
  for (const topic of ordered) {
    const random = seededRandom(hashString(topic.key));
    let best = null;
    let bestGap = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = SKY_MARGIN + random() * (SKY_WIDTH - 2 * SKY_MARGIN);
      const y = SKY_MARGIN + random() * (SKY_HEIGHT - 2 * SKY_MARGIN - 16); // room for the label
      const gap = Math.min(Infinity, ...placed.map((star) => Math.hypot(star.x - x, star.y - y)));
      if (gap > bestGap) {
        best = { x, y };
        bestGap = gap;
      }
      if (gap >= MIN_STAR_GAP) break;
    }
    placed.push({ ...topic, x: Math.round(best.x), y: Math.round(best.y) });
  }
  return placed;
}

// Size and brightness grow with the level (1-6).
function starShape(level) {
  const core = 1.6 + level * 1.1;
  return {
    core,
    halo: core * 3.4,
    haloOpacity: 0.1 + level * 0.09,
    coreOpacity: 0.55 + level * 0.075,
    sparkle: level >= 4 ? core * (1.6 + (level - 4) * 0.5) : 0
  };
}

// A thin four-pointed sparkle centred on (0, 0).
function sparklePath(arm, waist) {
  return `M0 ${-arm} L${waist} ${-waist} L${arm} 0 L${waist} ${waist} L0 ${arm} ` +
    `L${-waist} ${waist} L${-arm} 0 L${-waist} ${-waist} Z`;
}

function describeStar(star) {
  const { levelInfo } = star;
  const level = `Level ${star.level}, ${levelInfo.name}`;
  const next = levelInfo.next
    ? `${formatMinutes(Math.max(1, levelInfo.next.hours * 60 - star.totalMin))} to ${levelInfo.next.name}`
    : 'Top level reached';
  return { title: star.topic, lines: [`${formatMinutes(star.totalMin)} session time`, level, next] };
}

function renderConstellation(container, topics) {
  container.replaceChildren();
  const sky = svg('svg', {
    viewBox: `0 0 ${SKY_WIDTH} ${SKY_HEIGHT}`,
    role: 'group',
    'aria-label': topics.length ? `Constellation of ${topics.length} topics` : 'Empty constellation'
  });

  sky.append(svg('defs', {},
    svg('radialGradient', { id: 'star-halo' },
      // stop-color comes from stats.css, so it follows the theme.
      svg('stop', { offset: '0%', 'stop-opacity': '1' }),
      svg('stop', { offset: '40%', 'stop-opacity': '0.35' }),
      svg('stop', { offset: '100%', 'stop-opacity': '0' })
    )
  ));

  // Faint background dust, the same on every visit.
  const dust = svg('g', { 'aria-hidden': 'true' });
  const random = seededRandom(20261107);
  for (let i = 0; i < 90; i++) {
    dust.append(svg('circle', {
      class: 'dust',
      cx: (random() * SKY_WIDTH).toFixed(1),
      cy: (random() * SKY_HEIGHT).toFixed(1),
      r: (0.4 + random() * 0.8).toFixed(2),
      'fill-opacity': (0.15 + random() * 0.5).toFixed(2)
    }));
  }
  sky.append(dust);

  const tip = document.createElement('div');
  tip.className = 'sky-tip';
  tip.hidden = true;
  tip.setAttribute('role', 'status');

  if (!topics.length) {
    container.append(sky);
    const empty = document.createElement('p');
    empty.className = 'sky-empty';
    empty.textContent = 'Finish a study session to light your first star.';
    container.append(empty);
    return;
  }

  const stars = placeStars(topics);

  // Join each star to the nearest star placed before it.
  const links = svg('g', { 'aria-hidden': 'true' });
  stars.forEach((star, index) => {
    if (!index) return;
    let nearest = stars[0];
    for (const other of stars.slice(0, index)) {
      if (Math.hypot(other.x - star.x, other.y - star.y) < Math.hypot(nearest.x - star.x, nearest.y - star.y)) {
        nearest = other;
      }
    }
    links.append(svg('line', { class: 'link', x1: nearest.x, y1: nearest.y, x2: star.x, y2: star.y }));
  });
  sky.append(links);

  const showTip = (star) => {
    const { title, lines } = describeStar(star);
    const heading = document.createElement('strong');
    heading.textContent = title;
    tip.replaceChildren(heading, ...lines.flatMap((line) => [document.createElement('br'), line]).slice(1));
    tip.style.left = `${(star.x / SKY_WIDTH) * 100}%`;
    tip.style.top = `${(star.y / SKY_HEIGHT) * 100}%`;
    tip.classList.toggle('below', star.y < 110);
    tip.hidden = false;
  };
  const hideTip = () => {
    const selected = selectedStar && stars.find((star) => star.key === selectedStar);
    if (selected) showTip(selected);
    else tip.hidden = true;
  };

  const labelAll = stars.length <= LABEL_ALL_UNDER;
  for (const star of stars) {
    const shape = starShape(star.level);
    const { title, lines } = describeStar(star);
    const body = svg('g', { class: 'body' },
      svg('circle', { class: 'halo', r: shape.halo.toFixed(1), fill: 'url(#star-halo)', 'fill-opacity': shape.haloOpacity.toFixed(2) })
    );
    if (shape.sparkle) {
      body.append(svg('path', { class: 'sparkle', d: sparklePath(shape.sparkle * 2, shape.core * 0.28) }));
    }
    if (star.level >= 6) {
      body.append(svg('path', { class: 'sparkle', d: sparklePath(shape.sparkle * 1.2, shape.core * 0.22), transform: 'rotate(45)' }));
    }
    body.append(svg('circle', { class: 'core', r: shape.core.toFixed(1), 'fill-opacity': shape.coreOpacity.toFixed(2) }));

    const group = svg('g', {
      class: 'star level-' + star.level + (star.key === selectedStar ? ' selected' : ''),
      transform: `translate(${star.x} ${star.y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${title}: ${lines.join('. ')}.`,
      'data-key': star.key
    },
      svg('circle', { class: 'hit', r: Math.max(14, shape.core + 8), fill: 'transparent' }),
      svg('circle', { class: 'focus-ring', r: (shape.core + 5).toFixed(1) }),
      body
    );
    if (labelAll || star.level >= 3) {
      // Below the core, or below the sparkle's lower arm when there is one.
      const labelY = Math.max(shape.core + 16, shape.sparkle * 2 + 12);
      const label = svg('text', { class: 'label', y: labelY.toFixed(1) });
      label.textContent = star.topic.length > 20 ? star.topic.slice(0, 19) + '…' : star.topic;
      group.append(label);
    }

    const select = () => {
      selectedStar = selectedStar === star.key ? null : star.key;
      for (const other of sky.querySelectorAll('.star')) other.classList.toggle('selected', other.dataset.key === selectedStar);
      hideTip();
    };
    group.addEventListener('pointerenter', () => showTip(star));
    group.addEventListener('pointerleave', hideTip);
    group.addEventListener('focus', () => showTip(star));
    group.addEventListener('blur', hideTip);
    group.addEventListener('click', select);
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
    sky.append(group);
  }

  container.append(sky, tip);
  hideTip(); // reopens the selected star's details after a re-render
}

// Briefly twinkles one topic's star (after a completed session).
function twinkle(key) {
  const star = [...document.querySelectorAll('#sky .star')].find((element) => element.dataset.key === key);
  if (!star) return;
  star.classList.remove('twinkle');
  void star.getBoundingClientRect(); // restart the animation if it is already running
  star.classList.add('twinkle');
  setTimeout(() => star.classList.remove('twinkle'), 4000);
}

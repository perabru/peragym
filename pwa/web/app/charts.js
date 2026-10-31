/** Small, dependency-free SVG charts for device-local training records. */
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

const DAY = 86_400_000;
const colors = { coral: '#ec7263', wine: '#974859' };
const kgFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });
const fullDate = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

/** Return a stable chronological copy, without changing caller-owned records. */
export function normalizePoints(points) {
  if (!Array.isArray(points)) return [];
  return points
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => point && typeof point.at === 'number'
      && Number.isFinite(point.at) && Math.abs(point.at) <= 8.64e15
      && typeof point.value === 'number' && Number.isFinite(point.value))
    .sort((a, b) => a.point.at - b.point.at || a.index - b.index)
    .map(({ point }) => ({ ...point }));
}

export function filterRange(points, days = 'all', now = Date.now()) {
  const valid = normalizePoints(points);
  if (days === 'all' || days === null || days === undefined || Number(days) === 0) return valid;
  const count = Number(days);
  if (!Number.isFinite(count) || count < 0 || !Number.isFinite(now)) return [];
  return valid.filter(point => point.at >= now - count * DAY && point.at <= now);
}

export function summarize(points) {
  const sorted = normalizePoints(points);
  if (!sorted.length) return { first: null, last: null, change: 0, percent: null, count: 0 };
  const first = sorted[0].value;
  const last = sorted[sorted.length - 1].value;
  // Round arithmetic noise only; preserve all practical kilogram precision.
  const change = Number((last - first).toFixed(8));
  const percent = first === 0 ? null : Number((change / Math.abs(first) * 100).toFixed(4));
  return { first, last, change, percent, count: sorted.length };
}

function axisFor(points) {
  const values = points.map(point => point.value);
  let low = Math.min(...values);
  let high = Math.max(...values);
  const positiveOnly = low >= 0;
  const padding = high === low ? Math.max(1, Math.abs(low) * 0.08) : (high - low) * 0.14;
  low -= padding;
  high += padding;
  if (positiveOnly) low = Math.max(0, low);
  const target = (high - low) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const fraction = target / magnitude;
  const step = ([1, 2, 2.5, 5, 10].find(number => number >= fraction) || 10) * magnitude;
  const minimum = Math.floor(low / step) * step;
  const maximum = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = minimum; value <= maximum + step * 0.001; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return { minimum, maximum, ticks };
}

function dateTicks(points) {
  const unique = points.filter((point, index) => !index || point.at !== points[index - 1].at);
  if (unique.length <= 3) return unique;
  const indices = [0, Math.round((unique.length - 1) / 2), unique.length - 1];
  return [...new Set(indices)].map(index => unique[index]);
}

function shortDate(at, first, last) {
  const firstDate = new Date(first);
  const lastDate = new Date(last);
  if (firstDate.toDateString() === lastDate.toDateString() && first !== last) {
    return new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const options = firstDate.getFullYear() !== lastDate.getFullYear()
    ? { day: '2-digit', month: '2-digit', year: '2-digit' }
    : { day: '2-digit', month: 'short' };
  return new Date(at).toLocaleDateString('pt-BR', options).replace('.', '');
}

/**
 * Every circle represents a real record. The line connects observations and
 * does not interpolate extra records or invent progress in empty datasets.
 */
export function renderChart(input, options = {}) {
  const points = normalizePoints(input);
  const title = String(options.title || 'Evolução dos registros');
  const unit = String(options.unit || 'kg');
  const id = String(options.id || 'peragym-chart').replace(/[^a-zA-Z0-9_-]/g, '-') || 'peragym-chart';
  const colorName = options.color === 'wine' ? 'wine' : 'coral';
  const color = colors[colorName];
  if (!points.length) {
    return `<figure class="chart chart-empty chart-color-${colorName}" aria-label="${escapeHtml(title)}: sem registros">
      <svg viewBox="0 0 100 60" width="100" height="60" aria-hidden="true"><path d="M8 5v47h84" fill="none" stroke="currentColor" opacity=".2" stroke-width="2"/><path d="M18 39 39 29 59 34 83 15" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-dasharray="4 6"/><circle cx="83" cy="15" r="4" fill="${color}"/></svg>
      <figcaption><strong>Seu próximo registro dá início ao gráfico.</strong><span>Adicione uma medição para acompanhar a evolução ao longo do tempo.</span></figcaption>
    </figure>`;
  }

  const bounds = { left: 57, right: 400, top: 24, bottom: 198 };
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const firstAt = points[0].at;
  const lastAt = points[points.length - 1].at;
  const axis = axisFor(points);
  const x = at => firstAt === lastAt ? bounds.left + width / 2 : bounds.left + (at - firstAt) / (lastAt - firstAt) * width;
  const y = value => bounds.bottom - (value - axis.minimum) / (axis.maximum - axis.minimum) * height;
  const coordinate = value => Number(value.toFixed(3));
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${coordinate(x(point.at))},${coordinate(y(point.value))}`).join(' ');
  const area = `${path} L${coordinate(x(lastAt))},${bounds.bottom} L${coordinate(x(firstAt))},${bounds.bottom} Z`;
  const visibleTicks = dateTicks(points);
  // Label only distinct date text, even when several measurements share a day.
  const labels = new Set();
  const dateLabels = visibleTicks.map(point => {
    const label = shortDate(point.at, firstAt, lastAt);
    if (labels.has(label)) return '';
    labels.add(label);
    const position = x(point.at);
    const anchor = position < bounds.left + 25 ? 'start' : position > bounds.right - 25 ? 'end' : 'middle';
    return `<text class="chart-tick chart-date" x="${coordinate(position)}" y="226" text-anchor="${anchor}" font-size="14" fill="currentColor" opacity=".7">${escapeHtml(label)}</text>`;
  }).join('');
  const summary = summarize(points);
  const description = `${points.length} registro${points.length === 1 ? '' : 's'}. Primeiro: ${kgFormat.format(summary.first)} ${unit}; último: ${kgFormat.format(summary.last)} ${unit}. De ${fullDate.format(firstAt)} até ${fullDate.format(lastAt)}.`;
  return `<figure class="chart chart-color-${colorName}">
    <svg class="chart-svg" viewBox="0 0 420 248" role="img" aria-labelledby="${id}-title ${id}-description" preserveAspectRatio="xMidYMid meet">
      <title id="${id}-title">${escapeHtml(title)}</title><desc id="${id}-description">${escapeHtml(description)}</desc>
      <defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".26"/><stop offset="100%" stop-color="${color}" stop-opacity=".015"/></linearGradient></defs>
      <text class="chart-unit" x="57" y="13" font-size="14" fill="currentColor" opacity=".65">${escapeHtml(unit)}</text>
      ${axis.ticks.map(value => `<g class="chart-grid"><line x1="${bounds.left}" x2="${bounds.right}" y1="${coordinate(y(value))}" y2="${coordinate(y(value))}" stroke="currentColor" stroke-opacity=".1" stroke-dasharray="3 5"/><text class="chart-tick" x="44" y="${coordinate(y(value) + 4.5)}" text-anchor="end" font-size="14" fill="currentColor" opacity=".7">${kgFormat.format(value)}</text></g>`).join('')}
      ${points.length > 1 && firstAt !== lastAt ? `<path class="chart-area" d="${area}" fill="url(#${id}-fill)"/><path class="chart-line" d="${path}" stroke="${color}" fill="none" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
      ${points.map(point => `<circle class="chart-point" cx="${coordinate(x(point.at))}" cy="${coordinate(y(point.value))}" r="${points.length === 1 ? 5.5 : 4}" fill="${color}" stroke="var(--surface, #fffdf9)" stroke-width="2" tabindex="0" role="img" aria-label="${escapeHtml(`${fullDate.format(point.at)}: ${kgFormat.format(point.value)} ${unit}`)}"><title>${escapeHtml(`${fullDate.format(point.at)} · ${kgFormat.format(point.value)} ${unit}`)}</title></circle>`).join('')}
      ${dateLabels}
    </svg>
    <figcaption class="chart-caption"><span>${points.length === 1 ? 'Primeiro registro salvo. Os próximos pontos mostrarão a evolução.' : 'Cada ponto representa um registro salvo por você.'}</span><span>${points.length} registro${points.length === 1 ? '' : 's'}</span></figcaption>
  </figure>`;
}

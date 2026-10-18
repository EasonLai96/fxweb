// 顯示用簡寫，不改變帳戶的數值或計算精度。
const UNITS = [[1e48,'極'],[1e44,'載'],[1e40,'正'],[1e36,'澗'],[1e32,'溝'],[1e28,'穰'],[1e24,'秭'],[1e20,'垓'],[1e16,'京'],[1e12,'兆'],[1e8,'億']];
export function compactAmount(value) {
  const a = Math.abs(value);
  if (!Number.isFinite(a)) return '—';
  if (a >= 1e52) {
    const [mantissa, exponent] = a.toExponential(2).split('e');
    return `${mantissa} × 10^${Number(exponent)}`;
  }
  for (let i = 0; i < UNITS.length; i++) {
    const [scale, unit] = UNITS[i];
    if (a < scale) continue;
    const rounded = Number((a / scale).toFixed(2));
    // 四捨五入到一萬時，改用上一級單位。
    if (rounded >= 10000 && i > 0) return `1 ${UNITS[i - 1][1]}`;
    return `${rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}`;
  }
  return a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function compactPercent(ratio) {
  if (!Number.isFinite(ratio) || !Number.isFinite(ratio * 100)) return '—';
  const sign = ratio >= 0 ? '+' : '-';
  return `${sign}${Math.abs(ratio) >= 1e4 ? compactAmount(ratio * 100).replace(/\.00$/, '') : Math.abs(ratio * 100).toFixed(2)}%`;
}

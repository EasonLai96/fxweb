// 結算紀錄的 t 為 Unix 毫秒；以使用者裝置的本地時區顯示，保留到秒。
export function formatTradeTime(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "時間未記錄";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "時間未記錄";
  const pad = n => String(n).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

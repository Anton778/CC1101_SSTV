// Локальная модель: координаты графика зависят только от времени и полей формы.
(() => {
  const el = id => document.getElementById(id);
  const form = el("range-form"), from = el("range-from"), to = el("range-to"), period = el("range-period");
  const run = el("range-run"), stop = el("range-stop"), status = el("range-status");
  const plot = el("range-plot"), ctx = plot.getContext("2d");
  const format = new Intl.NumberFormat("ru-RU", {minimumFractionDigits: 3, maximumFractionDigits: 6});
  let animation = null, started = 0;

  function checkBounds() {
    to.setCustomValidity(to.valueAsNumber <= from.valueAsNumber ? "Конечная частота должна быть выше начальной." : "");
    return form.checkValidity();
  }
  function draw(phase) {
    const w = plot.width, h = plot.height;
    const low = from.valueAsNumber, high = to.valueAsNumber, seconds = period.valueAsNumber;
    ctx.fillStyle = "#17231f";
    ctx.fillRect(0, 0, w, h);
    el("range-frequency").textContent = "—";
    if (!checkBounds()) return;
    const left = 100, right = w - 24, top = 30, bottom = h - 35, middle = (left + right) / 2;
    const ratio = 1 - Math.abs(2 * phase - 1);
    ctx.font = "14px monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = "#becab9";
    ctx.fillText("МГц", left - 10, 16);
    for (const [frequency, y] of [[high, top], [low, bottom]]) {
      ctx.fillText(format.format(frequency), left - 10, y + 4);
      ctx.strokeStyle = "#435449";
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    }
    ctx.fillText(seconds.toLocaleString("ru-RU") + " с", right, h - 10);
    ctx.textAlign = "center";
    ctx.fillText((seconds / 2).toLocaleString("ru-RU") + " с", middle, h - 10);
    ctx.textAlign = "left";
    ctx.fillText("0 с", left, h - 10);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#a6d29c";
    ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(middle, top); ctx.lineTo(right, bottom); ctx.stroke();
    ctx.fillStyle = "#efd177";
    ctx.beginPath();
    ctx.arc(left + (right - left) * phase, bottom - (bottom - top) * ratio, 5, 0, 2 * Math.PI);
    ctx.fill();
    el("range-frequency").textContent = format.format(low + (high - low) * ratio) + " МГц";
  }
  function halt() {
    if (animation !== null) cancelAnimationFrame(animation);
    animation = null;
    stop.disabled = true;
    run.disabled = false;
  }
  function tick(now) {
    const seconds = (now - started) / 1000;
    draw((seconds % period.valueAsNumber) / period.valueAsNumber);
    animation = requestAnimationFrame(tick);
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (!checkBounds() || animation !== null) return;
    started = performance.now();
    run.disabled = true;
    stop.disabled = false;
    status.textContent = "Модель работает.";
    tick(started);
  };
  stop.onclick = () => { halt(); status.textContent = "Модель остановлена."; };
  form.oninput = () => { halt(); status.textContent = ""; draw(0); };
  const panel = el("view-sweep");
  new MutationObserver(() => {
    if (panel.hidden && animation !== null) stop.click();
  }).observe(panel, {attributes: true, attributeFilter: ["hidden"]});
  window.addEventListener("pagehide", halt);
  draw(0);
})();

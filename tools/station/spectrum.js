"use strict";

class SpectrumPlot {
  constructor(canvas, readout) {
    this.canvas = canvas;
    this.readout = readout;
    this.reset(433720, 434120, -75);
    const pointAt = event => {
      const rect = canvas.getBoundingClientRect();
      const {left, right} = this.bounds(rect.width);
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - left) / (right - left)));
      this.cursor = this.first + fraction * (this.last - this.first);
      this.draw();
    };
    canvas.addEventListener("pointermove", pointAt);
    canvas.addEventListener("pointerdown", pointAt);
    canvas.addEventListener("keydown", event => {
      if (!this.points.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let i = this.cursor === null ? -1 : this.nearest(this.cursor);
      if (event.key === "Home") i = 0;
      else if (event.key === "End") i = this.points.length - 1;
      else i += event.key === "ArrowRight" ? 1 : -1;
      this.cursor = this.points[Math.max(0, Math.min(this.points.length - 1, i))].f;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  reset(first, last, threshold) {
    this.first = first;
    this.last = last;
    this.threshold = threshold;
    this.cursor = null;
    this.points = [];
    this.peaks = Array(640).fill(null);
    this.readout.textContent = "Наведите курсор, коснитесь графика или выберите точку стрелками ← →.";
  }
  add(f, r) {
    const point = {f, r};
    this.points.push(point); // Плата выдаёт точки по возрастанию частоты.
    const k = Math.round((f - this.first) / Math.max(1, this.last - this.first) * (this.peaks.length - 1));
    if (!this.peaks[k] || r > this.peaks[k].r) this.peaks[k] = point;
  }
  nearest(f) {
    let a = 0, b = this.points.length - 1;
    while (a < b) {
      const m = Math.floor((a + b) / 2);
      if (this.points[m].f < f) a = m + 1;
      else b = m;
    }
    return a > 0 && f - this.points[a - 1].f <= this.points[a].f - f ? a - 1 : a;
  }
  bounds(width) { return {left: 33, right: Math.max(34, width - 13)}; }
  draw() {
    const canvas = this.canvas, rect = canvas.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 60) return;
    const ctx = canvas.getContext("2d"), dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width), h = Math.round(rect.height);
    const px = Math.round(w * dpr), py = Math.round(h * dpr);
    if (canvas.width !== px || canvas.height !== py) { canvas.width = px; canvas.height = py; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const {left, right} = this.bounds(w), top = 18, bottom = h - 28;
    const lo = Math.min(-120, Math.floor(this.threshold / 10) * 10 - 10);
    const hi = Math.max(-20, Math.ceil(this.threshold / 10) * 10 + 10);
    const x = f => this.last === this.first ? (left + right) / 2 :
      left + (f - this.first) / (this.last - this.first) * (right - left);
    const y = r => bottom - (Math.max(lo, Math.min(hi, r)) - lo) / (hi - lo) * (bottom - top);
    function line(x0, y0, x1, y1, color) {
      ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    ctx.fillStyle = "#17231f"; ctx.fillRect(0, 0, w, h);
    ctx.font = "11px monospace"; ctx.lineWidth = 1; ctx.textAlign = "left";
    ctx.fillStyle = "#bfcbb9";
    for (let i = 0; i <= 5; ++i) {
      const r = lo + (hi - lo) * i / 5;
      line(left, y(r), right, y(r), "#435449");
      ctx.fillText(String(Math.round(r)), 0, y(r) + 4);
    }
    ctx.fillText("дБм", left, 11);
    const span = this.last - this.first;
    const target = Math.max(1, span / Math.max(2, Math.min(8, Math.floor((right - left) / 70))));
    const scale = 10 ** Math.floor(Math.log10(target));
    const step = [1, 2, 5, 10].find(n => n * scale >= target) * scale;
    const ticks = [this.first];
    for (let f = this.first + step; f < this.last; f += step) {
      if (x(this.last) - x(f) >= 62) ticks.push(f);
    }
    if (span) ticks.push(this.last);
    for (const f of ticks) {
      line(x(f), top, x(f), bottom, "#435449");
      ctx.textAlign = !span ? "center" : f === this.first ? "left" : f === this.last ? "right" : "center";
      ctx.fillText((f / 1000).toFixed(3), x(f), bottom + 17);
    }
    ctx.textAlign = "right"; ctx.fillText("МГц", right, 11);
    ctx.setLineDash([5, 4]); line(left, y(this.threshold), right, y(this.threshold), "#efd177"); ctx.setLineDash([]);
    let previous;
    for (const p of this.peaks) {
      if (!p) continue;
      if (previous) line(x(previous.f), y(previous.r), x(p.f), y(p.r), "#a6d29c");
      ctx.fillStyle = "#c6e3a7"; ctx.fillRect(x(p.f) - 2, y(p.r) - 2, 4, 4);
      previous = p;
    }
    if (this.cursor === null) return;
    line(x(this.cursor), top, x(this.cursor), bottom, "#e7bd5d");
    let value = "Курсор " + (this.cursor / 1000).toFixed(3) + " МГц";
    if (this.points.length) {
      const p = this.points[this.nearest(this.cursor)];
      ctx.beginPath(); ctx.arc(x(p.f), y(p.r), 4, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd56b"; ctx.fill();
      value += " · Ближайшая точка " + (p.f / 1000).toFixed(3) + " МГц · " + p.r.toFixed(1) + " дБм";
    }
    this.readout.textContent = value;
  }
}

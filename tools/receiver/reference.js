// Контрольная фонограмма для проверки конвертера до подключения плат.
function referenceRobot36() {
  const rate = 16000;
  const samples = new Float32Array(rate * 38);
  let clock = 0.5, index = Math.round(clock * rate), phase = 0;
  function tone(hz, seconds) {
    clock += seconds;
    const end = Math.round(clock * rate);
    const step = 2 * Math.PI * hz / rate;
    while (index < end) {
      samples[index++] = 0.6 * Math.sin(phase);
      phase = (phase + step) % (2 * Math.PI);
    }
  }
  tone(1900, 0.300); tone(1200, 0.010); tone(1900, 0.300); tone(1200, 0.030);
  for (const bit of [0, 0, 0, 1, 0, 0, 0, 1]) tone(bit ? 1100 : 1300, 0.030);
  tone(1200, 0.030);
  const bars = [[255,255,255], [255,255,0], [0,255,255], [0,255,0],
                [255,0,255], [255,0,0], [0,0,255], [0,0,0]];
  for (let y = 0; y < 240; ++y) {
    const colors = y < 120 ? bars : bars.slice().reverse();
    tone(1200, 0.009); tone(1500, 0.003);
    for (const [r, g, b] of colors) {
      const yy = 0.299*r + 0.587*g + 0.114*b;
      tone(1500 + 800 * yy / 255, 0.088 / 8);
    }
    tone(y % 2 === 0 ? 1500 : 2300, 0.0045); tone(1900, 0.0015);
    for (const [r, g, b] of colors) {
      const c = y % 2 === 0 ? 0.5*r - 0.419*g - 0.081*b : -0.169*r - 0.331*g + 0.5*b;
      tone(1500 + 800 * (128 + c) / 255, 0.044 / 8);
    }
  }
  return {samples, rate};
}

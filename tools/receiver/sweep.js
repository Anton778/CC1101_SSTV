// Учебный опыт на компьютере. Все частоты здесь звуковые, в герцах.
function addAudioSweep({samples, rate}, lowHz, highHz, periodSeconds, levelPercent) {
  if (![lowHz, highHz, periodSeconds, levelPercent].every(Number.isFinite) ||
      lowHz < 20 || highHz <= lowHz || highHz >= rate / 2 ||
      periodSeconds < 0.05 || periodSeconds > 60 || levelPercent < 0 || levelPercent > 200) {
    throw Error("Проверьте границы свипа, период (0,05–60 с) и амплитуду (0–200 %). Верхняя частота должна быть ниже половины частоты дискретизации.");
  }
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  const amplitude = peak * levelPercent / 100;
  const scale = 1 / Math.max(1, peak + amplitude);  // Оставить сумму в диапазоне WAV.
  const stepHz = 2 * (highHz - lowHz) / (periodSeconds * rate);
  const result = new Float32Array(samples.length);
  let frequency = lowHz;
  let direction = 1;
  let phase = 0;

  for (let i = 0; i < samples.length; ++i) {
    result[i] = scale * (samples[i] + amplitude * Math.sin(phase));
    phase = (phase + 2 * Math.PI * frequency / rate) % (2 * Math.PI);
    frequency += direction * stepHz;
    if (frequency >= highHz) {
      frequency = 2 * highHz - frequency;
      direction = -1;                     // Дошли до верхней границы — идём вниз.
    } else if (frequency <= lowHz) {
      frequency = 2 * lowHz - frequency;
      direction = 1;                      // Дошли до нижней границы — идём вверх.
    }
  }
  return {samples: result, rate};
}

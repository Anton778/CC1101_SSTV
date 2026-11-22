// Учебный опыт на компьютере. Все частоты здесь звуковые, в герцах.
function addAudioSweep({samples, rate}, lowHz, highHz, periodSeconds, level, unit = "percent") {
  if (![lowHz, highHz, periodSeconds, level].every(Number.isFinite) ||
      lowHz < 20 || highHz <= lowHz || highHz >= rate / 2 ||
      periodSeconds < 0.05 || periodSeconds > 60) {
    throw Error("Проверьте звуковые частоты и период (0,05–60 с). Верхняя частота должна быть ниже половины частоты дискретизации.");
  }
  if (unit === "percent" && (level < 0 || level > 200)) throw Error("Допустимая амплитуда: 0–200 %.");
  let peak = 0, sumSquares = 0;
  for (const value of samples) {
    peak = Math.max(peak, Math.abs(value));
    sumSquares += value * value;
  }
  // Pтона / Pзаписи = 10^(уровень/10). Для синуса пиковая амплитуда равна √2 · RMS.
  const amplitude = unit === "dB"
    ? Math.sqrt(2 * sumSquares / samples.length) * 10 ** (level / 20)
    : peak * level / 100;
  if (!Number.isFinite(amplitude)) throw Error("Слишком большое значение уровня в дБ.");
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

// Работает только с массивом отсчётов WAV в браузере.
function sweepFromCommand(audio, line) {
  const [name, ...args] = line.trim().split(/\s+/);
  if (name.toUpperCase() !== "WAV_SWEEP" || (args.length !== 3 && args.length !== 4) ||
      !args.every(value => /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value))) {
    throw Error("Формат: WAV_SWEEP нижняя_Гц верхняя_Гц уровень_дБ [период_с]");
  }
  const [low, high, level, period = 2] = args.map(value => Number(value.replace(",", ".")));
  return addAudioSweep(audio, low, high, period, level, "dB");
}

async function prepareImage(file) {
  const image = new Image();
  const url = URL.createObjectURL(file);
  try {
    image.src = url;
    try { await image.decode(); }
    catch { throw Error("Не удалось открыть изображение. Выберите PNG, JPEG, BMP или WebP."); }
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext("2d", {alpha: false});
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, Math.floor((320 - w) / 2), Math.floor((240 - h) / 2), w, h);
    for (const quality of [0.92, 0.83, 0.7]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.type === "image/jpeg" && blob.size <= ImageTransfer.maxBytes)
        return {bytes: new Uint8Array(await blob.arrayBuffer()), preview: URL.createObjectURL(blob)};
    }
    throw Error("Не удалось подготовить JPEG до 64 КиБ.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

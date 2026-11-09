const form = document.getElementById("editorForm");
const videoInput = document.getElementById("video");
const fileInfo = document.getElementById("fileInfo");
const statusText = document.getElementById("status");
const submitButton = document.getElementById("submitButton");
const buttonText = document.getElementById("buttonText");
const loadingIndicator = document.getElementById("loadingIndicator");
const loadingText = document.getElementById("loadingText");

const result = document.getElementById("result");
const preview = document.getElementById("preview");
const comparison = document.getElementById("comparison");
const processedCanvas = document.getElementById("processedCanvas");
const comparisonSlider = document.getElementById("comparisonSlider");
const explanation = document.getElementById("explanation");
const resultBadge = document.getElementById("resultBadge");

const downloadButton = document.getElementById("downloadButton");
const downloadLink = document.getElementById("downloadLink");
const exportStatus = document.getElementById("exportStatus");
const exportProgress = document.getElementById("exportProgress");
const downloadModal = document.getElementById("downloadModal");
const confirmExport = document.getElementById("confirmExport");
const cancelExport = document.getElementById("cancelExport");

const canvasContext = processedCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true
});

let sourceVideoUrl = null;
let exportedVideoUrl = null;
let adjustments = null;
let renderFrameId = null;
let lastRenderTime = 0;
let isExporting = false;
let activeRecorder = null;

const qualityNames = {
  basic: "Básico",
  medium: "Médio",
  high: "Muito nítido"
};

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function waitForMediaEvent(media, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("O browser não conseguiu carregar este vídeo."));
    };

    const cleanup = () => {
      media.removeEventListener(eventName, onEvent);
      media.removeEventListener("error", onError);
    };

    media.addEventListener(eventName, onEvent, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

async function waitForMetadata(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return;
  }
  await waitForMediaEvent(video, "loadedmetadata");
}

function selectedQuality() {
  return form.querySelector('input[name="quality"]:checked')?.value || "medium";
}
async function extractFrames(file) {
  if (sourceVideoUrl) {
    URL.revokeObjectURL(sourceVideoUrl);
  }

  sourceVideoUrl = URL.createObjectURL(file);
  preview.src = sourceVideoUrl;
  preview.load();

  await waitForMetadata(preview);

  if (!preview.videoWidth || !preview.videoHeight) {
    throw new Error("Não foi possível ler a imagem deste vídeo.");
  }

  const originalTime = preview.currentTime;
  const wasPlaying = !preview.paused;
  const duration = Number.isFinite(preview.duration) ? preview.duration : 0;

  preview.pause();

  const sampleTimes = duration > 0
    ? [...new Set([0, duration * 0.4, Math.max(0, duration - 0.25)])]
    : [0];


  const frames = [];

  for (const second of sampleTimes.slice(0, 3)) {
    if (Math.abs(preview.currentTime - second) > 0.05) {
      const seeked = waitForMediaEvent(preview, "seeked");
      preview.currentTime = second;
      await seeked;
    }

    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / preview.videoWidth);
    const width = Math.max(1, Math.round(preview.videoWidth * scale));
    const height = Math.max(1, Math.round(preview.videoHeight * scale));

    const frameCanvas = document.createElement("canvas");
    frameCanvas.width = width;
    frameCanvas.height = height;
    frameCanvas.getContext("2d").drawImage(preview, 0, 0, width, height);

    frames.push(frameCanvas.toDataURL("image/jpeg", 0.68));
  }

  if (Number.isFinite(originalTime) && Math.abs(preview.currentTime - originalTime) > 0.05) {
    const seeked = waitForMediaEvent(preview, "seeked");
    preview.currentTime = originalTime;
    await seeked;
  }

  if (wasPlaying) {
    preview.play().catch(() => {});
  }

  return frames;
}

function canvasDimensionsForQuality() {
  const limits = {
    basic: 960,
    medium: 1280,
    high: 1920
  };

  const maxSide = limits[selectedQuality()] || limits.medium;
  const scale = Math.min(1, maxSide / Math.max(preview.videoWidth, preview.videoHeight));

  return {
    width: Math.max(2, Math.round(preview.videoWidth * scale / 2) * 2),
    height: Math.max(2, Math.round(preview.videoHeight * scale / 2) * 2)
  };
}

function applySharpen(amount) {
  if (!amount || amount <= 0) return;

  const width = processedCanvas.width;
  const height = processedCanvas.height;

  const strength = Math.min(0.3, amount * 0.22);
  if (strength < 0.01 || width < 3 || height < 3) return;

  const image = canvasContext.getImageData(0, 0, width, height);
  const source = image.data;
  const output = new Uint8ClampedArray(source);
  const centerWeight = 1 + strength * 4;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;

      for (let channel = 0; channel < 3; channel += 1) {
        const center = source[index + channel] * centerWeight;
        const neighbors =
          source[index - 4 + channel] +
          source[index + 4 + channel] +
          source[index - width * 4 + channel] +
          source[index + width * 4 + channel];

        output[index + channel] = center - strength * neighbors;
      }
    }
  }

  image.data.set(output);
  canvasContext.putImageData(image, 0, 0);
}

function renderProcessedFrame() {
  if (!adjustments || !preview.videoWidth || !preview.videoHeight) return;

  const dimensions = canvasDimensionsForQuality();

  if (
    processedCanvas.width !== dimensions.width ||
    processedCanvas.height !== dimensions.height
  ) {
    processedCanvas.width = dimensions.width;
    processedCanvas.height = dimensions.height;
  }

  const brightness = Math.round(adjustments.brightness * 100);
  const contrast = Math.round(adjustments.contrast * 100);
  const saturation = Math.round(adjustments.saturation * 100);

  canvasContext.filter =
    `brightness(${100 + brightness}%) ` +
    `contrast(${contrast}%) ` +
    `saturate(${saturation}%)`;

  canvasContext.drawImage(
    preview,
    0,
    0,
    processedCanvas.width,
    processedCanvas.height
  );

  canvasContext.filter = "none";
  applySharpen(adjustments.sharpness);
}
function startRenderLoop() {
  cancelAnimationFrame(renderFrameId);
  lastRenderTime = 0;

  const draw = (timestamp) => {
    if (!isExporting && preview.paused) return;

    if (timestamp - lastRenderTime >= 1000 / 30) {
      renderProcessedFrame();
      lastRenderTime = timestamp;
    }

    renderFrameId = requestAnimationFrame(draw);
  };

  renderFrameId = requestAnimationFrame(draw);
}

function updateSplit() {
  comparison.style.setProperty("--split", `${comparisonSlider.value}%`);
}

function revokeExportUrl() {
  if (exportedVideoUrl) {
    URL.revokeObjectURL(exportedVideoUrl);
    exportedVideoUrl = null;
  }
}

videoInput.addEventListener("change", () => {
  const file = videoInput.files[0];

  revokeExportUrl();
  downloadLink.hidden = true;
  downloadLink.removeAttribute("href");
  result.hidden = true;
  statusText.textContent = "";

  if (!file) {
    fileInfo.textContent = "";
    return;
  }

  fileInfo.textContent = `Selecionado: ${file.name} · ${formatFileSize(file.size)}`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = videoInput.files[0];

  if (!file) {
    statusText.textContent = "Seleciona um vídeo primeiro.";
    return;
  }

  if (!file.type.startsWith("video/")) {
    statusText.textContent = "Seleciona um ficheiro de vídeo válido.";
    return;
  }

  const quality = selectedQuality();

  statusText.textContent = "";
  result.hidden = true;
  submitButton.disabled = true;
  loadingIndicator.hidden = false;
  buttonText.textContent = "A analisar…";
  loadingText.textContent = "A preparar até três fotogramas no teu dispositivo…";

  try {
    const frames = await extractFrames(file);

    loadingText.textContent = "A IA está a analisar os fotogramas…";

    const response = await fetch("/api/analyze-frames", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames, quality })
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("O servidor devolveu uma resposta inválida.");
    }

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível analisar o vídeo.");
    }

    adjustments = data.adjustments;

    if (
      !adjustments ||
      !["brightness", "contrast", "saturation", "sharpness"]
        .every((key) => Number.isFinite(Number(adjustments[key])))
    ) {
      throw new Error("A resposta da IA não contém ajustes válidos.");
    }

    preview.pause();
    preview.currentTime = 0;

    if (preview.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      renderProcessedFrame();
    } else {
      preview.addEventListener("loadeddata", renderProcessedFrame, { once: true });
    }

    preview.addEventListener("play", startRenderLoop);
    preview.addEventListener("pause", renderProcessedFrame);
    preview.addEventListener("seeked", renderProcessedFrame);

    explanation.textContent =
      `${adjustments.reason || "A IA recomendou ajustes para este vídeo."} ` +
      `(Brilho: ${Number(adjustments.brightness).toFixed(2)}, ` +
      `contraste: ${Number(adjustments.contrast).toFixed(2)}, ` +
      `saturação: ${Number(adjustments.saturation).toFixed(2)}, ` +
      `nitidez: ${Number(adjustments.sharpness).toFixed(2)}.)`;

    resultBadge.textContent = data.qualityName || qualityNames[quality];
    comparisonSlider.value = "50";
    updateSplit();

    revokeExportUrl();
    downloadLink.hidden = true;
    downloadLink.removeAttribute("href");
    exportStatus.textContent = "";
    exportProgress.hidden = true;
    exportProgress.value = 0;

    result.hidden = false;
    statusText.textContent = "Análise concluída. A exportação será local.";

    result.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    statusText.textContent = error.message || "Ocorreu um erro.";
  } finally {
    submitButton.disabled = false;
    loadingIndicator.hidden = true;
    buttonText.textContent = "Analisar vídeo com IA";
  }
});

comparisonSlider.addEventListener("input", updateSplit);

downloadButton.addEventListener("click", () => {
  if (!adjustments || !preview.src) {
    exportStatus.textContent = "Analisa um vídeo antes de o exportar.";
    return;
  }

  if (typeof MediaRecorder === "undefined" || !processedCanvas.captureStream) {
    exportStatus.textContent =
      "Este browser não suporta a exportação local de vídeo.";
    return;
  }

  if (typeof downloadModal.showModal === "function") {
    downloadModal.showModal();
  } else {
    exportStatus.textContent =
      "Este browser não suporta a janela de exportação necessária.";
  }
});
cancelExport.addEventListener("click", () => {
  downloadModal.close();
});

confirmExport.addEventListener("click", async () => {
  downloadModal.close();
  await exportVideoLocally();
});

function chooseRecordingType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function exportVideoLocally() {
  if (isExporting) return;

  const mimeType = chooseRecordingType();

  if (!mimeType) {
    exportStatus.textContent =
      "Este browser não encontrou um formato de gravação compatível.";
    return;
  }

  isExporting = true;
  downloadButton.disabled = true;
  downloadLink.hidden = true;
  exportProgress.hidden = false;
  exportProgress.value = 0;
  exportStatus.textContent = "A iniciar a gravação local…";

  let canvasStream;
  let sourceStream;
  let combinedStream;
  let chunks = [];

  try {
    preview.pause();

    if (preview.currentTime > 0) {
      const seeked = waitForMediaEvent(preview, "seeked");
      preview.currentTime = 0;
      await seeked;
    }

    renderProcessedFrame();

    canvasStream = processedCanvas.captureStream(30);
    combinedStream = new MediaStream(canvasStream.getVideoTracks());

    const captureSource =
      preview.captureStream?.bind(preview) ||
      preview.webkitCaptureStream?.bind(preview);

    if (captureSource) {
      sourceStream = captureSource();
      const audioTracks = sourceStream.getAudioTracks();

      audioTracks.forEach((track) => combinedStream.addTrack(track));

      if (audioTracks.length === 0) {
        exportStatus.textContent =
          "Este vídeo não tem uma faixa de áudio capturável; será exportado sem áudio.";
      }
    } else {
      exportStatus.textContent =
        "Este browser não permite capturar o áudio; a exportação poderá ficar sem áudio.";
    }

    const recorder = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: 5_000_000
    });

    activeRecorder = recorder;
    chunks = [];

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });

    const recordingFinished = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.addEventListener(
        "error",
        () => reject(new Error("O browser encontrou um erro durante a gravação.")),
        { once: true }
      );
    });

    recorder.start(1000);

    const onTimeUpdate = () => {
      if (Number.isFinite(preview.duration) && preview.duration > 0) {
        exportProgress.value = Math.min(
          99,
          (preview.currentTime / preview.duration) * 100
        );

        exportStatus.textContent =
          `A exportar localmente… ${Math.round(exportProgress.value)}%`;
      }
      renderProcessedFrame();
    };

    const onEnded = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };

    preview.addEventListener("timeupdate", onTimeUpdate);
    preview.addEventListener("ended", onEnded, { once: true });
    preview.addEventListener("play", startRenderLoop);

    startRenderLoop();

    try {
      await preview.play();
    } catch {
      throw new Error("Clica novamente e permite a reprodução para exportar.");
    }

    await recordingFinished;

    preview.removeEventListener("timeupdate", onTimeUpdate);
    preview.removeEventListener("ended", onEnded);
    cancelAnimationFrame(renderFrameId);
    preview.pause();

    const blob = new Blob(chunks, { type: mimeType });
    if (!blob.size) {
      throw new Error("A gravação terminou sem gerar um ficheiro.");
    }

    revokeExportUrl();
    exportedVideoUrl = URL.createObjectURL(blob);

    downloadLink.href = exportedVideoUrl;
    downloadLink.download = "video-melhorado.webm";
    downloadLink.hidden = false;

    exportProgress.value = 100;
    exportStatus.textContent =
      `Exportação concluída · ${formatFileSize(blob.size)} · WebM.`;
    downloadLink.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    exportStatus.textContent = error.message || "Não foi possível exportar o vídeo.";

    if (activeRecorder && activeRecorder.state !== "inactive") {
      activeRecorder.stop();
    }
  } finally {
    cancelAnimationFrame(renderFrameId);

    canvasStream?.getTracks().forEach((track) => track.stop());
    sourceStream?.getTracks().forEach((track) => track.stop());
    combinedStream?.getTracks().forEach((track) => track.stop());

    activeRecorder = null;
    isExporting = false;
    downloadButton.disabled = false;
  }
}

window.addEventListener("beforeunload", () => {
  if (sourceVideoUrl) URL.revokeObjectURL(sourceVideoUrl);
  if (exportedVideoUrl) URL.revokeObjectURL(exportedVideoUrl);
});

const privacyBtn = document.getElementById("privacyBtn");
const privacyModal = document.getElementById("privacyModal");
const closePrivacyModal = document.getElementById("closePrivacyModal");

if (privacyBtn && privacyModal && closePrivacyModal) {
  privacyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    privacyModal.showModal();
  });

  closePrivacyModal.addEventListener("click", () => {
    privacyModal.close();
  });

  privacyModal.addEventListener("click", (e) => {
    const dialogDimensions = privacyModal.getBoundingClientRect();
    if (
      e.clientX < dialogDimensions.left ||
      e.clientX > dialogDimensions.right ||
      e.clientY < dialogDimensions.top ||
      e.clientY > dialogDimensions.bottom
    ) {
      privacyModal.close();
    }
  });
}

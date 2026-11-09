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
const download = document.getElementById("download");
const explanation = document.getElementById("explanation");
const resultBadge = document.getElementById("resultBadge");

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

videoInput.addEventListener("change", () => {
  const file = videoInput.files[0];

  if (!file) {
    fileInfo.textContent = "";
    return;
  }

  fileInfo.textContent = `Selecionado: ${file.name} · ${formatFileSize(file.size)}`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!videoInput.files.length) {
    statusText.textContent = "Seleciona um vídeo primeiro.";
    return;
  }

  const selectedQuality =
    form.querySelector('input[name="quality"]:checked')?.value || "medium";

  const selectedQualityName = qualityNames[selectedQuality] || "Médio";

  statusText.textContent = "";
  result.hidden = true;
  submitButton.disabled = true;
  loadingIndicator.hidden = false;
  buttonText.textContent = "A processar vídeo…";
  loadingText.textContent =
    selectedQuality === "high"
      ? "A IA está a analisar e a processar o vídeo em alta qualidade. Pode demorar…"
      : "A IA está a analisar e a processar o vídeo…";

  try {
    const response = await fetch("/api/process-ai", {
      method: "POST",
      body: new FormData(form)
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("O servidor devolveu uma resposta inválida.");
    }

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível processar o vídeo.");
    }

    preview.pause();
    preview.src = `${data.videoUrl}?t=${Date.now()}`;
    preview.load();

    download.href = data.videoUrl;

    const adjustments = data.adjustments;

    explanation.textContent =
      `${adjustments.reason} ` +
      `(Brilho: ${adjustments.brightness.toFixed(2)}, ` +
      `contraste: ${adjustments.contrast.toFixed(2)}, ` +
      `saturação: ${adjustments.saturation.toFixed(2)}, ` +
      `nitidez: ${adjustments.sharpness.toFixed(2)}.)`;

    resultBadge.textContent = data.qualityName || selectedQualityName;
    result.hidden = false;
    statusText.textContent = "O vídeo está pronto.";

    result.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    submitButton.disabled = false;
    loadingIndicator.hidden = true;
    buttonText.textContent = "Melhorar vídeo com IA";
  }
});

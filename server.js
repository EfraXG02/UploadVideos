require("dotenv").config();

const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = path.join(__dirname, "uploads");
const outputsDir = path.join(__dirname, "outputs");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use("/outputs", express.static(outputsDir));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadsDir);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname) || ".mp4";
    callback(null, `${crypto.randomUUID()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype.startsWith("video/")) {
      return callback(null, true);
    }

    callback(new Error("O ficheiro enviado não parece ser um vídeo."));
  }
});

const qualityLevels = {
  basic: {
    name: "Básico",
    description: "Processamento rápido, resolução original",
    maxSharpness: 0.3,
    preset: "veryfast",
    crf: "23",
    scaleFilter: null
  },
  medium: {
    name: "Médio",
    description: "Boa qualidade, até 1920 píxeis no lado maior",
    maxSharpness: 0.7,
    preset: "fast",
    crf: "21",
    scaleFilter:
      "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos"
  },
  high: {
    name: "Muito nítido",
    description: "Saída até 3840 píxeis no lado maior; processamento mais pesado",
    maxSharpness: 1.2,
    preset: "medium",
    crf: "18",
    scaleFilter:
      "scale=w='if(gte(iw,ih),3840,-2)':h='if(gte(iw,ih),-2,3840)':flags=lanczos"
  }
};

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args);
    let errorOutput = "";

    ffmpeg.stderr.on("data", (data) => {
      errorOutput = (errorOutput + data.toString()).slice(-10000);
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(errorOutput || "Erro ao processar o vídeo com FFmpeg.")
        );
      }
    });
  });
}

async function extrairFotograma(videoPath, segundo, outputPath) {
  try {
    await runFFmpeg([
      "-y",
      "-ss", String(segundo),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=640:-1",
      "-q:v", "5",
      outputPath
    ]);

    return fs.existsSync(outputPath);
  } catch {
    return false;
  }
}

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}

app.post("/api/process-ai", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Seleciona um vídeo primeiro."
    });
  }

  const inputPath = req.file.path;
  const tempDir = path.join(uploadsDir, crypto.randomUUID());
  const outputName = `${crypto.randomUUID()}.mp4`;
  const outputPath = path.join(outputsDir, outputName);

  try {
    if (!process.env.AI_API_KEY) {
      throw new Error("Não encontrei AI_API_KEY no ficheiro .env.");
    }

    const requestedLevel = String(req.body?.quality || "medium").toLowerCase();
    const quality = qualityLevels[requestedLevel]
      ? requestedLevel
      : "medium";
    const profile = qualityLevels[quality];

    await fs.promises.mkdir(tempDir, { recursive: true });

    // A IA analisa até três fotogramas do vídeo.
    const imagePaths = [];

    for (const second of [0, 2, 5]) {
      const imagePath = path.join(tempDir, `frame-${second}.jpg`);
      const exists = await extrairFotograma(inputPath, second, imagePath);

      if (exists) {
        imagePaths.push(imagePath);
      }
    }

    if (imagePaths.length === 0) {
      throw new Error("Não foi possível extrair imagens deste vídeo.");
    }

    const prompt = `
Analisa estas imagens de um vídeo e escolhe ajustes automáticos para melhorar
a imagem, mantendo uma aparência natural e fiel ao que está visível.

O nível escolhido pelo utilizador é: ${profile.name}.
Descrição do nível: ${profile.description}.

Escolhe valores moderados de brilho, contraste, saturação e nitidez.
Não inventes detalhes nem características que não estejam visíveis.

Devolve apenas um objeto JSON neste formato:
{
  "brightness": 0,
  "contrast": 1,
  "saturation": 1,
  "sharpness": 0.2,
  "reason": "explicação breve em português"
}

Limites obrigatórios:
- brightness entre -0.3 e 0.3
- contrast entre 0.7 e 1.4
- saturation entre 0.7 e 1.5
- sharpness entre 0 e ${profile.maxSharpness}

Se a imagem já estiver boa, escolhe valores próximos de brilho 0,
contraste 1, saturação 1 e nitidez 0.2.
Evita halos, ruído, cores artificiais e nitidez exagerada.
`;

    const content = [
      {
        type: "text",
        text: prompt
      },
      ...imagePaths.map((imagePath) => ({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${fs
            .readFileSync(imagePath)
            .toString("base64")}`
        }
      }))
    ];

    const aiResponse = await fetch(
      process.env.CHAT_API_URL ||
        "https://api.experientiallabs.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.AI_MODEL || "gpt-6-luna",
          messages: [
            {
              role: "user",
              content
            }
          ],
          temperature: 0.2
        })
      }
    );

    let aiData;

    try {
      aiData = await aiResponse.json();
    } catch {
      throw new Error("A API de IA devolveu uma resposta inválida.");
    }

    if (!aiResponse.ok) {
      console.error("Erro da API de IA:", aiData);

      throw new Error(
        aiData.error?.message ||
          aiData.message ||
          `A API respondeu com o código ${aiResponse.status}.`
      );
    }

    const messageContent = aiData.choices?.[0]?.message?.content;

    const aiText = Array.isArray(messageContent)
      ? messageContent.map((part) => part.text || "").join("\n")
      : messageContent;

    if (!aiText) {
      console.error("Resposta recebida da API:", aiData);
      throw new Error("A API não devolveu uma resposta de texto.");
    }

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("A IA não devolveu os ajustes no formato esperado.");
    }

    const settings = JSON.parse(jsonMatch[0]);

    const brightness = Number(settings.brightness);
    const contrast = Number(settings.contrast);
    const saturation = Number(settings.saturation);
    const sharpness = Number(settings.sharpness);

    if (
      ![brightness, contrast, saturation, sharpness].every(Number.isFinite)
    ) {
      throw new Error("A IA devolveu valores de ajuste inválidos.");
    }

    const safeBrightness = limitar(brightness, -0.3, 0.3);
    const safeContrast = limitar(contrast, 0.7, 1.4);
    const safeSaturation = limitar(saturation, 0.7, 1.5);
    const safeSharpness = limitar(sharpness, 0, profile.maxSharpness);

    const filters = [
      `eq=brightness=${safeBrightness}:contrast=${safeContrast}:saturation=${safeSaturation}`
    ];

    if (profile.scaleFilter) {
      filters.push(profile.scaleFilter);
    }

    filters.push(`unsharp=5:5:${safeSharpness}:3:3:0`);

    await runFFmpeg([
      "-y",
      "-i", inputPath,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-vf", filters.join(","),
      "-c:v", "libx264",
      "-preset", profile.preset,
      "-crf", profile.crf,
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath
    ]);

    res.json({
      message: "Vídeo melhorado com IA.",
      videoUrl: `/outputs/${outputName}`,
      quality,
      qualityName: profile.name,
      adjustments: {
        brightness: safeBrightness,
        contrast: safeContrast,
        saturation: safeSaturation,
        sharpness: safeSharpness,
        reason: String(
          settings.reason ||
            "A IA escolheu ajustes automáticos para melhorar a imagem."
        )
      }
    });
  } catch (error) {
    console.error(error);

    await fs.promises.unlink(outputPath).catch(() => {});

    res.status(500).json({
      error: error.message || "Não foi possível processar o vídeo."
    });
  } finally {
    await fs.promises.unlink(inputPath).catch(() => {});
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: "O vídeo ultrapassa o limite de 500 MB."
    });
  }

  res.status(400).json({
    error: error.message || "Ocorreu um erro."
  });
});

app.listen(PORT, () => {
  console.log(`Aplicação disponível em http://localhost:${PORT}`);
});

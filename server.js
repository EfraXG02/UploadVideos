require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const qualityLevels = {
  basic: {
    name: "Básico",
    description: "Ajustes subtis, priorizando rapidez",
    maxSharpness: 0.3
  },
  medium: {
    name: "Médio",
    description: "Ajustes equilibrados e naturais",
    maxSharpness: 0.7
  },
  high: {
    name: "Muito nítido",
    description: "Nitidez mais forte; o processamento local pode ser mais lento",
    maxSharpness: 1.2
  }
};

app.use(express.static(path.join(__dirname, "public")));

// A rota recebe apenas alguns JPEGs pequenos, nunca o vídeo completo.
app.use(express.json({ limit: "6mb" }));

function limitar(valor, minimo, maximo) {
  return Math.max(minimo, Math.min(maximo, valor));
}

function extrairTextoAI(messageContent) {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }

  return "";
}

app.post("/api/analyze-frames", async (req, res) => {
  try {
    if (!process.env.AI_API_KEY) {
      return res.status(500).json({
        error: "A chave AI_API_KEY não está configurada no servidor."
      });
    }

    const frames = req.body?.frames;
    const requestedQuality = String(req.body?.quality || "medium").toLowerCase();
    const quality = qualityLevels[requestedQuality] ? requestedQuality : "medium";
    const profile = qualityLevels[quality];

    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 3) {
      return res.status(400).json({
        error: "Envia entre um e três fotogramas para análise."
      });
    }

    const imageParts = frames.map((frame) => {
      if (typeof frame !== "string") {
        throw new Error("Formato de fotograma inválido.");
      }

      const match = frame.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/);

      if (!match) {
        throw new Error("Os fotogramas devem ser imagens JPEG em Base64.");
      }

      const imageBuffer = Buffer.from(match[1], "base64");

      if (!imageBuffer.length || imageBuffer.length > 1024 * 1024) {
        throw new Error("Um dos fotogramas excede o limite permitido.");
      }

      return {
        type: "image_url",
        image_url: { url: frame }
      };
    });

    const prompt = `
Analisa estes fotogramas de um vídeo e recomenda ajustes naturais.
O nível escolhido é ${profile.name}: ${profile.description}.
Não inventes detalhes nem recomendes nitidez excessiva.

Devolve apenas JSON no formato:
{
  "brightness": 0,
  "contrast": 1,
  "saturation": 1,
  "sharpness": 0.2,
  "reason": "explicação breve em português"
}

Limites:
- brightness: -0.3 a 0.3
- contrast: 0.7 a 1.4
- saturation: 0.7 a 1.5
- sharpness: 0 a ${profile.maxSharpness}

Se a imagem já estiver boa, prefere valores próximos de brilho 0,
contraste 1, saturação 1 e nitidez 0.2.
`;

    const apiResponse = await fetch(
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
              content: [
                { type: "text", text: prompt },
                ...imageParts
              ]
            }
          ],
          temperature: 0.2
        })
      }
    );

    let aiData;

    try {
      aiData = await apiResponse.json();
    } catch {
      throw new Error("A API de IA devolveu uma resposta inválida.");
    }

    if (!apiResponse.ok) {
      console.error("A API de IA respondeu com o código:", apiResponse.status);
      throw new Error(
        aiData.error?.message ||
          aiData.message ||
          `A API de IA respondeu com o código ${apiResponse.status}.`
      );
    }

    const aiText = extrairTextoAI(aiData.choices?.[0]?.message?.content);
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error("A IA não devolveu ajustes no formato esperado.");
    }

    const settings = JSON.parse(jsonMatch[0]);
    const values = {
      brightness: Number(settings.brightness),
      contrast: Number(settings.contrast),
      saturation: Number(settings.saturation),
      sharpness: Number(settings.sharpness)
    };

    if (!Object.values(values).every(Number.isFinite)) {
      throw new Error("A IA devolveu valores de ajuste inválidos.");
    }

    res.json({
      quality,
      qualityName: profile.name,
      adjustments: {
        brightness: limitar(values.brightness, -0.3, 0.3),
        contrast: limitar(values.contrast, 0.7, 1.4),
        saturation: limitar(values.saturation, 0.7, 1.5),
        sharpness: limitar(values.sharpness, 0, profile.maxSharpness),
        reason:
          typeof settings.reason === "string"
            ? settings.reason.slice(0, 500)
            : "A IA escolheu ajustes automáticos para melhorar a imagem."
      }
    });
  } catch (error) {
    console.error("Erro na análise dos fotogramas:", error.message);

    res.status(500).json({
      error: error.message || "Não foi possível analisar o vídeo."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Aplicação disponível em http://localhost:${PORT}`);
});
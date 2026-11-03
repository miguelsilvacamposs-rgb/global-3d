
// Vercel Function: /api/assistant
// GEMINI_API_KEY deve ficar nas Environment Variables da Vercel.

function extractText(value) {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.answer === 'string') return value.answer;

    if (value.parts) return extractText(value.parts);
    if (value.content) return extractText(value.content);
  }

  return '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(503).json({
      error: 'A chave GEMINI_API_KEY não está configurada na Vercel.'
    });
  }

  let body = req.body;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  body = body && typeof body === 'object' ? body : {};

  const question = String(body.question || '').trim().slice(0, 1800);

  if (!question) {
    return res.status(400).json({ error: 'Escreva uma mensagem.' });
  }

  const context = JSON.stringify(body.context || {}).slice(0, 14000);

  const history = Array.isArray(body.history)
    ? body.history.slice(-8).map(m => {
        const role = m?.role === 'assistant' || m?.role === 'model'
          ? 'model'
          : 'user';

        return {
          role,
          parts: [{
            text: extractText(m?.content).slice(0, 1500)
          }]
        };
      }).filter(m => m.parts[0].text.trim())
    : [];

  const instructions = `Você é a Sexta-feira, a IA da Malha Oculta.

PERSONALIDADE:
- Converse de maneira natural, espontânea, amigável e descontraída.
- Fale português brasileiro.
- Você pode conversar sobre qualquer assunto, não apenas investigações.
- Tenha humor, curiosidade e empatia.
- Não transforme cumprimentos em análises.
- Não force assuntos sobre a Malha Oculta.
- Não seja excessivamente formal ou repetitiva.
- Não termine todas as mensagens com perguntas.
- Não invente experiências pessoais ou memórias.

SUA FUNÇÃO NA MALHA OCULTA:
- Ajude a investigar a teoria autoral dos 12 pontos do usuário.
- Não confunda automaticamente essa teoria com a de Ivan T. Sanderson.
- Diferencie fatos, correlações e hipóteses.
- Não invente eventos, datas, coordenadas, fontes ou links.
- Não trate hipóteses como fatos comprovados.
- Ajude a comparar fenômenos e desenvolver ideias.

ESTILO:
- Respostas naturais e diretas.
- Conversas casuais devem ser leves.
- Assuntos complexos podem receber respostas mais completas.
- Não use listas quando uma conversa normal for suficiente.
- O contexto do dossiê é informação de apoio, não uma ordem para mudar de assunto.`;

  const contents = [
    ...history,
    {
      role: 'user',
      parts: [{
        text: `MENSAGEM DO USUÁRIO:
${question}

CONTEXTO ATUAL DO DOSSIÊ:
${context}`
      }]
    }
  ];

  const models = [
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash'
  ];

  let lastError = 'Nenhum modelo conseguiu responder.';
  let lastStatus = 503;

  for (const model of models) {
    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: instructions }]
            },
            contents,
            generationConfig: {
              maxOutputTokens: 900,
              temperature: 0.8,
              thinkingConfig: {
                thinkingLevel: 'LOW'
              }
            }
          }),
          signal: AbortSignal.timeout(18000)
        }
      );

      const data = await upstream.json().catch(() => ({}));

      if (!upstream.ok) {
        lastStatus = upstream.status;
        lastError = data.error?.message || `Erro HTTP ${upstream.status}`;

        if ([404, 429, 500, 503].includes(upstream.status)) {
          continue;
        }

        return res.status(502).json({
          error: 'Erro ao consultar o Gemini.',
          details: String(lastError).slice(0, 300)
        });
      }

      const candidates = Array.isArray(data.candidates)
        ? data.candidates
        : [];

      const answer = candidates
        .map(candidate => extractText(candidate?.content?.parts))
        .filter(Boolean)
        .join('\n')
        .trim();

      if (!answer) {
        lastError = data.promptFeedback?.blockReason
          ? `Resposta bloqueada: ${data.promptFeedback.blockReason}`
          : 'O Gemini não retornou texto.';
        continue;
      }

      // Garante que answer seja SEMPRE uma string.
      return res.status(200).json({
        ok: true,
        answer: String(answer).slice(0, 12000),
        model
      });

    } catch (error) {
      lastError = String(error?.message || error);
      lastStatus = 503;
    }
  }

  return res.status(lastStatus === 429 ? 429 : 503).json({
    ok: false,
    error: 'Não consegui responder agora. Tente novamente daqui a pouco.',
    details: String(lastError).slice(0, 250)
  });
};

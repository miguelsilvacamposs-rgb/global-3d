// Vercel Function: /api/assistant
// Variáveis de ambiente necessárias na Vercel:
// - GEMINI_API_KEY
// - FIREBASE_PROJECT_ID
// - FIREBASE_CLIENT_EMAIL
// - FIREBASE_PRIVATE_KEY (ou GOOGLE_APPLICATION_CREDENTIALS / firebase-adminsdk json configurado)

let admin = null;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY 
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
      : undefined;

    if (process.env.FIREBASE_PROJECT_ID && privateKey && process.env.FIREBASE_CLIENT_EMAIL) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey
        })
      });
    }
  }
} catch (e) {
  // Firebase Admin opcional/não configurado inicialmente para não quebrar o chat caso o frontend ainda não envie token
  console.warn('Firebase Admin não inicializado:', e.message);
}

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

  // Validação opcional de Autenticação Firebase via Bearer Token no Header Authorization
  let authenticatedUser = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && admin && admin.apps.length) {
    const idToken = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      authenticatedUser = {
        uid: decodedToken.uid,
        email: decodedToken.email || ''
      };
    } catch (err) {
      console.warn('Falha ao verificar token do Firebase:', err.message);
    }
  }

  let privateMemoriesText = '';
  let sharedMemoriesText = '';

  // Consulta ao Firestore se o Firebase Admin estiver ativo
  if (admin && admin.apps.length) {
    const db = admin.firestore();

    // 1. Recuperação de Memória Privada (se o usuário estiver autenticado)
    if (authenticatedUser) {
      try {
        const memSnapshot = await db
          .collection('users')
          .doc(authenticatedUser.uid)
          .collection('memories')
          .orderBy('updatedAt', 'desc')
          .limit(5)
          .get();

        if (!memSnapshot.empty) {
          const memoriesList = memSnapshot.docs.map(doc => `- [${doc.data().type || 'preferência'}]: ${doc.data().content}`);
          privateMemoriesText = `\nMEMÓRIAS PRIVADAS DO USUÁRIO:\n${memoriesList.join('\n')}`;
        }
      } catch (err) {
        console.error('Erro ao buscar memórias privadas:', err.message);
      }
    }

    // 2. Recuperação de Memória Coletiva da Malha Oculta (Pública / Projetos)
    try {
      const sharedSnapshot = await db
        .collection('assistant_shared_memory')
        .orderBy('updatedAt', 'desc')
        .limit(6)
        .get();

      if (!sharedSnapshot.empty) {
        const sharedList = sharedSnapshot.docs.map(doc => `- [${doc.data().type || 'fato'}] (${doc.data().category || 'Geral'}): ${doc.data().content}`);
        sharedMemoriesText = `\nMEMÓRIA COLETIVA DA MALHA OCULTA:\n${sharedList.join('\n')}`;
      }
    } catch (err) {
      console.error('Erro ao buscar memória coletiva:', err.message);
    }
  }

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
${context}
${privateMemoriesText}
${sharedMemoriesText}`
      }]
    }
  ];

  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash'
  ];

  let lastError = 'Nenhum modelo conseguiu responder.';
  let lastStatus = 503;

  // Ativação inteligente do Google Search Grounding se a pergunta parecer exigir dados externos recentes
  const needsSearch = /(notícia|últimas|pesquise|busca|quanto foi|quem ganhou|site|link|recente|hoje|atual)/i.test(question);

  for (const model of models) {
    try {
      const payload = {
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
      };

      // Adiciona tools de Google Search Grounding se aplicável e compatível
      if (needsSearch) {
        payload.tools = [{ googleSearch: {} }];
      }

      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
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

      // Salva o histórico da conversa no Firestore de forma assíncrona (se autenticado)
      if (admin && admin.apps.length && authenticatedUser) {
        try {
          const db = admin.firestore();
          db.collection('users')
            .doc(authenticatedUser.uid)
            .collection('assistant_history')
            .add({
              question,
              answer,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            })
            .catch(() => {});
        } catch {}
      }

      // Garante que answer seja SEMPRE uma string e preserva o contrato original de resposta
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

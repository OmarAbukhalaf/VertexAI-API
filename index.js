+32
-72
Lines changed: 32 additions & 72 deletions
Original file line number	Original file line	Diff line number	Diff line change
@@ -1,69 +1,83 @@
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const NodeCache = require('node-cache');
const promptCache = new NodeCache({ stdTTL: 3600 });
const PORT = 3000;

app.use(express.json());

// === Firebase Admin Initialization from ENV ===
const firebaseBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
const firebaseServiceAccount = JSON.parse(
  Buffer.from(firebaseBase64, 'base64').toString('utf8')
);

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const db = admin.firestore();

// === Dialogflow Auth from ENV ===
async function getAccessToken() {
  const dialogflowBase64 = process.env.DIALOGFLOW_CREDENTIALS_BASE64;
  const dialogflowCredentials = JSON.parse(
    Buffer.from(dialogflowBase64, 'base64').toString('utf8')
  );

  const auth = new GoogleAuth({
    credentials: dialogflowCredentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}


// === Get Advertiser Data ===
async function getAdvertiserData(advertiserId) {
  // ✅ Return prompt from cache if available
  const cachedData = promptCache.get(advertiserId);
  if (cachedData) {
    console.log('Prompt fetched from cache');
    return cachedData; // { prompt: string, timestamp: Date }
  }

  const doc = await db.collection('advertiser_settings').doc(advertiserId).get();
  if (!doc.exists) {
    return { prompt: '', timestamp: null };
  }
  

  const data = doc.data();
  const customVocab = data.ADV_custom_vocab?.trim();
  const tone = data.ADV_tone?.trim();

  const missingfields=!customVocab || !tone;
  // ✅ Generate prompt dynamically
  const generatedPrompt = `You are a customer support assistant.
Always follow the brand's support style. Be conversational, clear, and helpful. Never mention that you are an AI.

Custom Vocabulary: Use brand-specific terms when applicable.
Example: ${customVocab||""}

Behavior Rules
Tone: ${tone||""}

Unclear Input:
If the user’s message is confusing or unclear, reply with:
"I didn’t quite catch that. Could you try rephrasing?"

Style Guide

Apply custom vocabulary where relevant.`;

  const promptObj = { prompt: generatedPrompt, timestamp: new Date(), missingfields };
  promptCache.set(advertiserId, promptObj);
  console.log('Prompt generated and cached');
  return promptObj;
}


// === Detect Intent ===
async function detectIntent({ projectId, locationId, agentId, sessionId, message,advertiserName, advertiserData = {} }) {
  const accessToken = await getAccessToken();

  const url = `https://${locationId}-dialogflow.googleapis.com/v3/projects/${projectId}/locations/${locationId}/agents/${agentId}/sessions/${sessionId}:detectIntent`;

  // 🧠 Prompt with advertiser data
  const prompt = advertiserData.Prompt;
  const missingFields = advertiserData.missingfields;



  const finalMessage = `${prompt}\n\nAdvertiser:${advertiserName}\n\n Query:${message}`;

  const payload = {
    queryInput: {
      text: { text: finalMessage },
      languageCode: 'en-US',
    },
    queryParams: {
      parameters: {}
    }
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    }
  });

  const result = response.data.queryResult;
  
  const result_text=result.responseMessages?.[0]?.text?.text?.[0] || 'No response from agent.';
  return missingFields ? `Missing Fields: ${result_text}` : result_text;

}

// === Express POST /chat Endpoint ===
app.post('/chat', async (req, res) => {
  try {
    const {
      message,
      advertiserName,
      advertiserId,
      sessionId = 'default-session'
    } = req.body;

    if (!message || !advertiserId) {
      return res.status(400).json({ error: 'Missing message or advertiserId' });
    }

    const advertiserData = await getAdvertiserData(advertiserId);

    const response = await detectIntent({
      projectId: 'aichat-457808',
      locationId: 'us-central1',
      agentId: '901d59b6-589f-431c-8be3-daca6f6766a7',
      sessionId,
      message,
      advertiserName,
      advertiserData
    });

    res.json({ response });
    console.log("Response:", response)
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to contact Gemini agent' });
  }
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

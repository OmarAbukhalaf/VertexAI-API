const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const PORT = 3000;

app.use(express.json());

// === Firebase Admin Initialization ===
const firebaseServiceAccount = require('./fb-omar.json');

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount),
});
const db = admin.firestore();

// === Dialogflow Service Account Path ===
const credentialsPath = 'service-account.json';

async function getAccessToken() {
  const auth = new GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  return token.token;
}

// === Get Advertiser Data ===
async function getAdvertiserData(advertiserId) {
  const doc = await db.collection('advertiser_settings').doc(advertiserId).get();
  return doc.exists ? doc.data() : {};
}

// === Detect Intent ===
async function detectIntent({ projectId, locationId, agentId, sessionId, message,advertiserName, advertiserData = {} }) {
  const accessToken = await getAccessToken();

  const url = `https://${locationId}-dialogflow.googleapis.com/v3/projects/${projectId}/locations/${locationId}/agents/${agentId}/sessions/${sessionId}:detectIntent`;

  // 🧠 Prompt with advertiser data
  const prompt = `
You are a customer support assistant.
Always follow the brand's support style. Be conversational, clear, and helpful. Never mention that you are an AI.

Custom Vocabulary: Use brand-specific terms when applicable.
Example: ${advertiserData.CustomVocab || ''}

Behavior Rules
Banned Phrases: ${advertiserData.BannedPhrases || ''}
If any word or phrase from this list appears anywhere in the user's message, immediately respond with:
"Banned Phrase used." 

Tone: ${advertiserData.Tone || ''}

Unclear Input:
If the user’s message is confusing or unclear, reply with:
"I didn’t quite catch that. Could you try rephrasing?"

Style Guide

Apply custom vocabulary where relevant.


`;
console.log(prompt)
  const finalMessage = `${prompt.trim()}\n\nAdvertiser:${advertiserName}\n\n Query:${message}`;

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
  return result.responseMessages?.[0]?.text?.text?.[0] || 'No response from agent.';
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
